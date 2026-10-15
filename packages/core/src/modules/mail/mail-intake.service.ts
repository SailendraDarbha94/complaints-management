import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Attachment, ParsedMail } from 'mailparser';
import type { Tx } from '@ksdc/db';
import type {
  CaseEvent,
  CaseState,
  CorrespondenceKind,
  FollowupStage,
  IntakeSource,
  MailForwardKind,
  MailMatchRung,
  MailSenderCheck,
  MailStatus,
  Milestone,
} from '@ksdc/contracts';
import { availableEvents, transitionFor } from '@ksdc/contracts';
import { ConflictError, DomainError, NotFoundError } from '../../common/domain-error.js';
import { Logger } from '../../common/logger.js';
import type { EngineContext } from '../followups/followup.service.js';
import type { FollowupService } from '../followups/followup.service.js';
import type { CaseIntakeService } from '../cases/case-intake.service.js';
import {
  EVENT_FOR_KIND,
  type CorrespondenceService,
} from '../correspondence/correspondence.service.js';
import type { DocumentsService } from '../documents/documents.service.js';
import { STAGING_PREFIX, sniff, MAX_UPLOAD_BYTES } from '../documents/storage.js';
import type { StoragePort } from '../documents/storage.js';
import { pgTextArray } from '../../common/pg-array.js';
import { assertCaseLive, CaseCancelledError } from '../cases/case-guard.js';
import { returnedToTrayNote } from './cancelled-case.js';
import { snippetOf, unwrapForward } from './forwarded.js';
import { parseMessage } from './parse.js';
import { imageSize } from './image-size.js';
import { notFromListedReason, senderCheckOf, unconfirmedSenderNote } from './sender-check.js';
import {
  casesByRecipient,
  findRecordedLetter,
  matchCouncilCopy,
  matchMessage,
  partiesOnCase,
  type MatchCandidate,
  type MatchResult,
  type RecordedLetterMatch,
} from './matching.js';
import {
  intakeAccountOf,
  isOwnAddress,
  ownAddressesOf,
  suggestedComplainant,
  type OwnAddresses,
  type SuggestedComplainant,
} from './complainant.js';
import {
  bareSubject,
  comparableName,
  copyWhenOf,
  councilCopyOf,
  inferLetterKinds,
  kindForRecipient,
  readsThrough,
  writtenByCouncilTo,
  type CopyDateBasis,
  type CouncilCopy,
  type CouncilCopyRecipient,
} from './council-copy.js';

/**
 * The inward mail tray.
 *
 * The officer forwards a complaint to a watched mailbox; this turns that message into a
 * card, and the card into a case when they say so.
 *
 * ONE THING TO UNDERSTAND BEFORE CHANGING ANYTHING HERE: a message is not a case.
 *
 * Most forwards are complaints. Some are the dentist replying on a case already open.
 * Some are circulars, duplicates, or mail that was never meant for the Council. A case
 * number is a serial in a legal register, and a voided entry in that book takes more
 * explaining than an empty tray does — so nothing here allocates one until either a person
 * presses a button, or the message quotes a number the register already knows.
 *
 * What it does with attachments is the other half. They are staged into object storage at
 * ingest and become case documents only on filing, because a complaint whose bills were
 * discarded while it waited in the tray is worse than no tray at all.
 */

/**
 * A timestamp column, whatever the driver handed back.
 *
 * node-pg parses timestamptz into a Date, but a value that has been through a JSON
 * round trip - a route handler, a cached payload - arrives as a string, and
 * `fiscalYearOf()` then fails on `.getFullYear is not a function` deep inside case
 * intake, where the cause is four call frames away from the symptom.
 */
function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Senders whose mail is the intake mailbox's own account administration - never a complaint.
 *
 * Google writes to the mailbox every time somebody signs in, turns on 2-step verification
 * or uses an app password. Left alone, each notice becomes a card the officer has to set
 * aside by hand, for as long as the mailbox exists. These are set aside automatically
 * instead - RECORDED with a reason, not dropped, because the tray is the record of what
 * arrived and a message must not be able to vanish from it.
 *
 * Deliberately a short, exact list of addresses. Nothing a member of the public could ever
 * write from belongs on it, which is what makes it safe to act on without a person.
 */
const ACCOUNT_NOTICE_SENDERS = new Set([
  'no-reply@accounts.google.com',
  // Google's "you shared some Google Account data with ..." notices, seen on the intake
  // mailbox on 2026-09-29 when an app was signed in to with it.
  'noreply-accounts@google.com',
  'noreply@google.com',
  'mail-noreply@google.com',
]);

/**
 * What makes an image a signature logo rather than evidence.
 *
 * Every forward from the office carries the sender's signature images, and so does most
 * mail from clinics; stored, each one became a "complaint material" document on the case.
 * But a photograph of a bill, or a screenshot of a UPI payment, pasted into the body of a
 * complaint is embedded in exactly the same way - and losing THAT to a rule about logos is
 * far worse than a logo on the file. So all three must hold: embedded in the body (cid:),
 * small in bytes, and small in pixels. Size in bytes alone was not enough - a cropped
 * screenshot weighs what a logo weighs - while its shape gives it away.
 */
const SIGNATURE_IMAGE_MAX_BYTES = 25 * 1024;
const SIGNATURE_IMAGE_MAX_PX = 200;

function isSignatureImage(a: Attachment, bytes: Buffer): boolean {
  if (!a.related || !/^image\//i.test(a.contentType) || bytes.length > SIGNATURE_IMAGE_MAX_BYTES) {
    return false;
  }
  const size = imageSize(bytes);
  // Size unknown: kept. A logo on the case is clutter; a screenshot thrown away is lost.
  return size !== null && Math.max(size.width, size.height) <= SIGNATURE_IMAGE_MAX_PX;
}

/**
 * Text from mail, made storable. Postgres text cannot hold U+0000, and a malformed
 * encoded-word in a header decodes to it - so one broken subject line failed the whole
 * message, on every attempt, while it waited to be read.
 */
function noNul<T extends string | null | undefined>(s: T): T {
  return (typeof s === 'string' ? s.replace(/\u0000/g, '') : s) as T;
}

/**
 * What a signature logo is recorded as. One exact string, because the tray matches on it:
 * the card's "N not stored" warning is for a file somebody may have needed, and a logo on
 * nearly every forward would teach the officer to ignore that warning.
 */
const SIGNATURE_LOGO_REASON =
  'A small image inside the message itself - almost always an email signature logo. ' +
  'Not stored; it is still in the mailbox if it was anything else.';

/**
 * How the reason on a copy's attachment begins when the file was already on the case
 * (pointAtCaseDuplicates). One string, because restageFromCancelledCase clears exactly this
 * reason when the file then goes onto another case as a document of its own.
 */
const DUPLICATE_REASON_PREFIX = 'Already on the case as ';

/** How deep to open emails attached inside emails. Real forwards nest one or two levels. */
const MAX_EMBED_DEPTH = 3;

/** The fixed identity every automatic write is attributed to. Created in migration 0013. */
export const MAIL_ROBOT_USER_ID = '00000000-0000-4000-8000-000000000001';

/**
 * The card text of a message that could not be read (recordUnreadable). Also how such a card
 * is told apart later: the one-off sender rule (sender-rule.ts) must never set one aside - it
 * is the only trace of a message that may have been a complaint, and its sender, when there
 * is one at all, was never checked.
 */
export const UNREADABLE_SNIPPET = 'This message could not be read automatically. Open it in the mailbox.';

export interface IngestMeta {
  mailbox: string;
  uid?: number | null;
  uidValidity?: string | null;
  gmMsgId?: string | null;
  /** The complete raw source. Hashed whole — a truncated read gives a hash that never matches. */
  raw: Buffer;
}

export interface IngestResult {
  mailMessageId: string;
  status: MailStatus;
  /** True when this message was already in the tray and nothing was written. */
  duplicate: boolean;
  autoFiledTo: string | null;
  note: string | null;
  attachmentsStored: number;
  attachmentsSkipped: number;
  /**
   * A copy of a letter the Council itself sent (see council-copy.ts). The automatic mail
   * assistant is not asked about these: the register already knows what they are.
   */
  councilCopy: boolean;
  /**
   * Who sent it, against the council's intakeSenders list (sender-check.ts); null when the
   * council has no list. 'unverified' is not read by the automatic assistant either: it is
   * the one kind of message in the tray whose sender is itself the question.
   */
  senderCheck: MailSenderCheck | null;
}

export type TrayRow = {
  id: string;
  subject: string;
  snippet: string;
  envelope_from: string;
  envelope_from_name: string | null;
  envelope_date: Date;
  ingested_at: Date;
  forward_kind: MailForwardKind;
  original_from: string | null;
  original_from_name: string | null;
  original_subject: string | null;
  original_date_text: string | null;
  status: MailStatus;
  suggestion_note: string | null;
  suggested_case_file_id: string | null;
  suggested_case_number: string | null;
  attachment_count: number;
  skipped_count: number;
  /** Who the case would be opened for. Null when the message does not say. */
  complainant: SuggestedComplainant | null;
  /** Set when this is a copy of a letter the Council sent: who that letter went to. */
  councilCopy: CouncilCopy | null;
  /**
   * Who sent it, against the council's intakeSenders list (sender-check.ts). The card marks
   * 'unverified'; null when the council had no list when it arrived.
   */
  sender_check: MailSenderCheck | null;
  /** Why it was set aside - by the officer, or on arrival. Null unless it is. */
  dismissed_reason: string | null;
};

/**
 * The three ways of filing a copy of a Council letter on a case.
 *
 *   link          the case records the letter as sent: the copy is attached to it as proof
 *   record_sent   record the letter as sent now, from the copy, with everything sending it
 *                 means for the case - exactly as the "I have sent this" click
 *   record_only   put the letter on the case as sent, and change nothing else
 */
export type CouncilCopyMode = 'link' | 'record_sent' | 'record_only';

/** Everything the message page needs to file a copy of a Council letter on one case. */
export interface CouncilCopyPlan {
  caseFileId: string;
  caseNumber: string;
  recipients: CouncilCopyRecipient[];
  /** When the copy says the letter went out (see copyWhenOf). */
  copyDate: Date;
  /**
   * How far copyDate can be trusted: 'forwarded' means it is only when the copy was
   * forwarded, and the letter went out then or earlier - the page then asks for the day
   * rather than filling in the forward's.
   */
  copyDateBasis: CopyDateBasis;
  /** The forward's own date line, as written, when it kept one only as text. */
  dateText: string | null;
  kind: CorrespondenceKind | null;
  /** The template's own name for that kind, or null when the subject is no template's. */
  kindLabel: string | null;
  /**
   * When the subject is two of the Council's letters at once (the hearing notice to the
   * complainant and the one to the dentist share a subject) and who it went to does not
   * settle which: both, for the officer to choose. Empty otherwise.
   */
  kindOptions: Array<{ kind: CorrespondenceKind; label: string }>;
  /** The recipients against THIS case. */
  check: 'confirmed' | 'mismatch' | 'unverified';
  checkNote: string;
  /**
   * The letter the case records that this is most likely the copy of, and how sure that is
   * (see findRecordedLetter): 'match', 'already_copied' (a copy of it is on file already) or
   * 'earlier' (recorded well before the copy's date - perhaps it, perhaps an earlier one).
   */
  recordedLetter: {
    id: string;
    kind: CorrespondenceKind;
    subject: string;
    sentAt: Date;
    how: 'match' | 'already_copied' | 'earlier';
    /** A copy of it is already on file: filing this one adds a second. */
    copied: boolean;
    /**
     * It is this copy's letter beyond doubt (see planFor). Otherwise attaching the copy to it
     * is only one of the choices, worded "if it is", and only the officer makes it.
     */
    sure: boolean;
  } | null;
  draft: { id: string; kind: CorrespondenceKind; subject: string } | null;
  /** What recording this letter as sent does to the case, if anything. */
  event: CaseEvent | null;
  eventAvailable: boolean;
  /** A notice to a dentist: recording it needs to say which dentist. */
  needsRespondent: boolean;
  /** sentTo: this dentist's address or name is on the copy's To line. */
  respondents: Array<{ id: string; name: string; noticeCount: number; sentTo: boolean }>;
  /** What may be done, the recommended first. */
  actions: CouncilCopyMode[];
  /** Why these and not the others, in a sentence or two for the officer. */
  explanation: string;
  /** What "record it as sent" will do to the case, in words; null when it does nothing. */
  effect: string | null;
  /**
   * The reminders on the case that a letter RECEIVED would stop - every one waiting for a
   * reply, whoever it waits on. For the "it is a reply - add it as received" confirm, which
   * must say what it will close before it closes it.
   */
  waitingForReply: Array<{ stage: FollowupStage; label: string }>;
}

export interface CouncilCopyFiled {
  filedAs: CouncilCopyMode;
  correspondenceId: string;
  transitioned: CaseEvent | null;
  documentsFiled: number;
}

/**
 * The reminders a letter RECEIVED answers: filing one stops every live reminder at these
 * stages on its case (satisfyWaiting). The message page lists them before the officer files
 * a misread copy as received (CouncilCopyPlan.waitingForReply), so both read this one list.
 */
const ANSWERED_BY_A_REPLY: readonly FollowupStage[] = [
  'await_patient_docs',
  'await_respondent_explanation',
  'await_ev_explanation',
];

/** What a follow-up waits for, for "This starts the reminder for ...". */
const WAITING_FOR: Partial<Record<FollowupStage, string>> = {
  await_patient_docs: 'the documents',
  await_respondent_explanation: "the dentist's explanation",
  await_gdc_report: "the expert's report",
};

/** A milestone as the officer would say it, for "already moved past this step (... on 9 Oct)". */
const MILESTONE_SAID: Partial<Record<Milestone, string>> = {
  documents_requested: 'documents asked for',
  respondent_notice_despatched: 'a notice sent',
  expert_referral_despatched: 'the referral sent',
};

export type MailAttachmentRow = {
  id: string;
  filename: string;
  declared_type: string | null;
  size_bytes: number;
  sha256: string;
  document_id: string | null;
  /**
   * The status of the document it became, when it became one. A file withdrawn from the
   * case as misfiled is not "on the case file", and is not copied onward when a message
   * leaves a cancelled case either (see restageFromCancelledCase).
   */
  document_status: string | null;
  skipped_reason: string | null;
};

/** What the officer did with a message through the ordinary buttons. */
export type OfficerMailAction =
  | { action: 'opened_case'; caseFileId: string }
  /**
   * asCouncilCopy: filed as a copy of the Council's own letter (fileCouncilCopy), not as a
   * letter received. The assistant counts the two as different answers - "their reply"
   * and "our own letter" - so it is told which one the officer gave.
   */
  | { action: 'filed_on_case'; caseFileId: string; asCouncilCopy?: boolean }
  | { action: 'set_aside'; reason: string };

/**
 * What the tray tells the mail assistant, and when.
 *
 * A hook handed in by services.ts rather than an import, because the assistant is built
 * ON this service (an accepted suggestion is carried out by openCase / fileOnCase /
 * dismiss) and an import back the other way would be a cycle.
 *
 * `officerActed` is what keeps the assistant's agreement figure honest. Without it only
 * the suggestions the officer ACCEPTED would have an outcome, and a model that is right
 * whenever it is accepted is right 100 per cent of the time by construction. So when the
 * officer ignores a suggestion and uses the ordinary buttons, the assistant is told what
 * they did and records whether it matched.
 */
export interface MailAssistantHook {
  /** Inside the officer's transaction, after the action succeeded. Never throws onward. */
  officerActed(
    tx: Tx,
    ctx: EngineContext,
    mailMessageId: string,
    act: OfficerMailAction,
  ): Promise<void>;
  /**
   * After a sweep, for the messages it put in the tray. Outside any transaction: this
   * waits on the model, and opens its own short scopes. The sweep does not wait for it -
   * the reader's next fetch must never queue behind a model (see sweep.ts) - but the
   * promise settles when these messages have been read, for a caller that does want to.
   */
  suggestAfterSweep(ctx: EngineContext, mailMessageIds: string[]): Promise<void>;
}

export class MailIntakeService {
  private readonly log = new Logger('mail');

  constructor(
    private readonly storage: StoragePort,
    private readonly intake: CaseIntakeService,
    private readonly correspondence: CorrespondenceService,
    private readonly documents: DocumentsService,
    private readonly followups: FollowupService,
    /** Optional: the tests that do not involve the assistant construct this without it. */
    private readonly assistant: MailAssistantHook | null = null,
  ) {}

  /** For the sweep, which is a function rather than a method and reaches it through here. */
  get assistantHook(): MailAssistantHook | null {
    return this.assistant;
  }

  /**
   * Tell the assistant what the officer did, without ever letting that fail the action.
   *
   * In a savepoint because a failed statement aborts the whole transaction, and catching
   * the error would not un-abort it - the officer's case would then fail to open over a
   * bookkeeping row about a suggestion. The action is what matters; the record of how it
   * compared with a suggestion is worth a warning in the log, not the officer's work.
   */
  private async tellAssistant(
    tx: Tx,
    ctx: EngineContext,
    mailMessageId: string,
    act: OfficerMailAction,
  ): Promise<void> {
    const hook = this.assistant;
    if (!hook) return;
    try {
      await tx.transaction((sp) => hook.officerActed(sp, ctx, mailMessageId, act));
    } catch (err) {
      this.log.warn(
        `the assistant's record for message ${mailMessageId} was not updated: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // ─── Ingest ────────────────────────────────────────────────────────────────

  /**
   * Take one message off the mailbox and put it in the tray.
   *
   * Idempotent on two keys, and it needs both. `gm_msg_id` is Gmail's own identifier and
   * the one thing a sender cannot influence, but it exists only on Gmail. `raw_sha256` is
   * always available. Message-ID is deliberately NOT a dedupe key: it is sender-controlled
   * and optional under RFC 5322, and can legitimately repeat — deduping on it would
   * silently drop a genuine second complaint, which in a statutory register is data loss
   * dressed up as tidiness.
   */
  async ingest(
    tx: Tx,
    ctx: EngineContext,
    parsed: ParsedMail,
    meta: IngestMeta,
  ): Promise<IngestResult> {
    const rawSha256 = createHash('sha256').update(meta.raw).digest('hex');

    const seen = await tx.execute<{ id: string; status: MailStatus; sender_check: MailSenderCheck | null }>(sql`
      SELECT id, status, sender_check FROM mail_message
      WHERE council_id = ${ctx.councilId}::uuid
        AND (raw_sha256 = ${rawSha256}
          OR (${meta.gmMsgId ?? null}::text IS NOT NULL AND gm_msg_id = ${meta.gmMsgId ?? null}))
      LIMIT 1
    `);
    if (seen.rows[0]) {
      return {
        mailMessageId: seen.rows[0].id,
        status: seen.rows[0].status,
        duplicate: true,
        autoFiledTo: null,
        note: null,
        attachmentsStored: 0,
        attachmentsSkipped: 0,
        councilCopy: false,
        senderCheck: seen.rows[0].sender_check,
      };
    }

    const own = await this.ownAddresses(tx, ctx, meta.mailbox);
    // Through any forward the Council made only to itself, and any an outside body made of
    // somebody else's mail, to the mail inside it: see forwarded.ts, readThrough(), for the
    // support-desk and grievance-cell chains this is for, and council-copy.ts, readsThrough.
    const original = await unwrapForward(parsed, {
      readThrough: (o, inner) => readsThrough(o, inner, own),
    });
    const envelope = parsed.from?.value?.[0];
    const bodyText = parsed.text ?? '';
    // The card should show the complainant's words, not the officer's covering note.
    const snippet = snippetOf(original.body ?? bodyText);

    // Who sent it here, against the addresses this council's complaints come from (see
    // intakeSenders in council-config.ts, and sender-check.ts). The ENVELOPE sender, never
    // the unwrapped original: the Registrar forwards other people's mail, and the person
    // inside the forward is on no list. Null when the council has no list - nothing below
    // then differs from before the rule existed.
    const intakeSenders = ctx.config.intakeSenders ?? [];
    const senderCheck = senderCheckOf(intakeSenders, envelope?.address ?? null, parsed.headers);
    const isAccountNotice = Boolean(
      envelope?.address && ACCOUNT_NOTICE_SENDERS.has(envelope.address.toLowerCase()),
    );
    // Mail from any other address is set aside below, and is not looked at on the way: no
    // case is matched to it, nothing is filed, it is not taken for a copy of a Council
    // letter, and the assistant is not asked. An account notice is set aside by its own
    // rule, first, with its own reason - exactly as before the list existed.
    const turnedAway = senderCheck === 'not_allowed' && !isAccountNotice;
    // From a listed address, but the mail provider could not confirm it (a From line can
    // be written by anybody). It goes to the tray - never set aside, because a genuine
    // complaint must not disappear because a signature broke on the way - but it never
    // files itself, and the automatic assistant leaves it for the officer.
    const unconfirmed = senderCheck === 'unverified';

    const council = await tx.execute<{ code: string }>(
      sql`SELECT code FROM council WHERE id = ${ctx.councilId}::uuid`,
    );
    const councilCode = council.rows[0]?.code ?? '';

    // A copy of a letter the Council itself sent - forwarded here, or sent with the intake
    // address in Cc. It is matched and filed by its own rules below, never as a reply: see
    // council-copy.ts for what went wrong when it was treated as one.
    const envelopeTo = parsed.to && 'text' in parsed.to ? parsed.to.text : null;
    const copy = turnedAway
      ? null
      : councilCopyOf(
          {
            original_from: original.fromAddress,
            original_to: original.to,
            envelope_from: envelope?.address ?? null,
            envelope_to: envelopeTo,
            subject: parsed.subject ?? null,
          },
          own,
        );

    // Both the forwarder and the original sender are offered to the matcher. The forwarder
    // is usually the officer and will match nothing, which is harmless; the original is
    // the one that can find a case.
    const searched = {
      subject: [parsed.subject ?? '', original.subject ?? ''].join('\n'),
      body: [bodyText, original.body ?? ''].join('\n'),
    };
    const copyMatch = copy
      ? await matchCouncilCopy(tx, ctx, councilCode, {
          ...searched,
          recipients: copy.recipients.map((r) => r.email),
        })
      : null;
    const match: MatchResult = turnedAway
      ? { autoFile: null, candidates: [], note: null }
      : copyMatch
        ? { autoFile: null, candidates: copyMatch.candidates, note: copyMatch.note }
        : await matchMessage(tx, ctx, councilCode, {
            ...searched,
            // Never the Council's own addresses: the office forwards everything, and an
            // address that is on every case says nothing about which one this is.
            senderAddresses: [original.fromAddress, envelope?.address ?? null].filter(
              (a): a is string => Boolean(a) && !isOwnAddress(a, own),
            ),
          });

    // What an unconfirmed message would have filed itself onto, had its sender been
    // confirmed. Still offered - the case is suggested, and the officer files it with one
    // click once satisfied - but the note says why it did not file itself, in place of the
    // matcher's "Filed automatically", which would now be untrue.
    const heldBack = unconfirmed ? (match.autoFile ?? copyMatch?.autoFileCandidate ?? null) : null;
    if (unconfirmed) {
      const quoted = heldBack
        ? match.candidates.find((c) => c.caseFileId === heldBack.caseFileId)?.caseNumber
        : null;
      match.note = [
        unconfirmedSenderNote(envelope?.address?.toLowerCase() ?? 'unknown'),
        quoted
          ? `It quotes ${quoted}, but because of this it has not been filed there on its own - ` +
            'file it yourself once you are satisfied it is genuine.'
          : match.note,
      ]
        .filter(Boolean)
        .join(' ');
    }

    // Who passed it on before the Council did - a grievance cell, a police station - when the
    // unwrapper read through their forward to the complainant's own message. Said on the
    // card, so the officer still knows how it came, without that body being taken for the
    // complainant.
    const passedOnBy = (original.via ?? []).filter((v) => v.address && !isOwnAddress(v.address, own));
    if (passedOnBy.length) {
      const who = passedOnBy.map((v) => (v.name ? `${v.name} <${v.address}>` : v.address)).join(', then by ');
      match.note = [
        match.note,
        `It reached the Council forwarded by ${who}. The sender shown is the person whose message they passed on.`,
      ]
        .filter(Boolean)
        .join(' ');
    }

    const id = randomUUID();
    await tx.execute(sql`
      INSERT INTO mail_message (
        id, council_id, gm_msg_id, message_id, raw_sha256, mailbox, uid, uid_validity,
        envelope_from, envelope_from_name, envelope_to, envelope_date, subject,
        in_reply_to, reference_ids, body_text, body_html, snippet,
        forward_kind, original_from, original_from_name, original_to, original_subject,
        original_date, original_date_text, original_body,
        suggested_case_file_id, suggestion_note, sender_check, created_by
      ) VALUES (
        ${id}::uuid, ${ctx.councilId}::uuid, ${meta.gmMsgId ?? null},
        ${noNul(parsed.messageId ?? null)}, ${rawSha256}, ${meta.mailbox},
        ${meta.uid ?? null}, ${meta.uidValidity ?? null},
        ${noNul(envelope?.address?.toLowerCase() ?? 'unknown')}, ${noNul(envelope?.name || null)},
        ${noNul(envelopeTo)},
        ${parsed.date ?? new Date()}, ${noNul(parsed.subject ?? '(no subject)')},
        ${noNul(parsed.inReplyTo ?? null)},
        ${pgTextArray(([] as string[]).concat(parsed.references ?? []).map(noNul))}::text[],
        ${noNul(bodyText || null)}, ${noNul(parsed.html || null)}, ${noNul(snippet)},
        ${original.kind}::mail_forward_kind, ${noNul(original.fromAddress)},
        ${noNul(original.fromName)}, ${noNul(original.to)}, ${noNul(original.subject)},
        ${original.date}, ${noNul(original.dateText)}, ${noNul(original.body)},
        ${match.candidates[0]?.caseFileId ?? null}::uuid, ${noNul(match.note)}, ${senderCheck},
        ${ctx.userId ?? null}
      )
    `);

    // Staged whatever happens next, a message set aside included: one brought back from
    // "Set aside" must still have its files to go on a case with.
    const stored = await this.stageAttachments(tx, ctx, id, parsed);

    // The mailbox provider writing to its own account holder. Set aside with a reason rather
    // than left in the tray - see ACCOUNT_NOTICE_SENDERS.
    if (isAccountNotice) {
      await tx.execute(sql`
        UPDATE mail_message
        SET status = 'dismissed', dismissed_at = now(), dismissed_by = ${ctx.userId ?? null},
            dismissed_reason = ${'An account notice from the mail provider about the intake ' +
              'mailbox itself, not a complaint. Set aside automatically.'}
        WHERE council_id = ${ctx.councilId}::uuid AND id = ${id}::uuid
      `);
      return {
        mailMessageId: id,
        status: 'dismissed',
        duplicate: false,
        autoFiledTo: null,
        note: 'Account notice from the mail provider; set aside automatically.',
        attachmentsStored: stored.stored,
        attachmentsSkipped: stored.skipped,
        councilCopy: false,
        senderCheck,
      };
    }

    // Not from an address this council's complaints come from. Set aside on arrival, like an
    // account notice, and for the same reason: RECORDED with a reason, never dropped, so
    // it can be brought back from "Set aside" if it is a complaint after all. Nothing was
    // matched for it above, and nothing is filed - not even when it quotes a case number,
    // which anybody can do. Brought back, it is an ordinary message in the tray, filed only
    // by the officer: the register files mail by itself only on arrival (below), and this
    // message has already arrived.
    if (turnedAway) {
      await tx.execute(sql`
        UPDATE mail_message
        SET status = 'dismissed', dismissed_at = now(), dismissed_by = ${ctx.userId ?? null},
            dismissed_reason = ${notFromListedReason(intakeSenders)}
        WHERE council_id = ${ctx.councilId}::uuid AND id = ${id}::uuid
      `);
      this.log.log(`ingested ${parsed.subject ?? '(no subject)'} -> set aside (not from a listed sender)`);
      return {
        mailMessageId: id,
        status: 'dismissed',
        duplicate: false,
        autoFiledTo: null,
        note: 'Not from a listed sender; set aside automatically.',
        attachmentsStored: stored.stored,
        attachmentsSkipped: stored.skipped,
        councilCopy: false,
        senderCheck,
      };
    }

    // Rungs 1 and 2 only. The sender rung suggests and never files - see matching.ts.
    //
    // The matcher leaves cancelled cases out, but it read without a lock, and the staging
    // above can take a while. A case cancelled in that gap would take this message out of
    // the tray and onto a case nobody looks at - after cancel() had already sent that
    // case's other mail back. So the case is checked again under its row lock (see
    // case-guard), and a message whose case has just gone goes to the tray instead of
    // failing: a message that fails to ingest does not reach the tray at all. Its page
    // re-runs the matcher live, and says there which cancelled case it quotes.
    //
    // And only for a sender the mail provider confirmed, when the council has a list: an
    // unconfirmed one waits for the officer (heldBack, above), quoting a number or not.
    let autoFile = unconfirmed ? null : (match.autoFile ?? copyMatch?.autoFileCandidate ?? null);
    if (autoFile) {
      try {
        await assertCaseLive(tx, ctx, autoFile.caseFileId);
      } catch (err) {
        if (!(err instanceof CaseCancelledError)) throw err;
        autoFile = null;
      }
    }

    // A copy files itself only when the number and the person it was sent to agree on one
    // open case AND that case records the letter as sent - that very letter, beyond doubt:
    // then the copy is proof of a step the register already knows about, and attaching it
    // changes nothing. Anything else - the letter not recorded, recorded long before, already
    // copied, a number that disagrees with its recipient, no number - waits for the officer,
    // because recording a letter as sent starts a reminder or moves a dentist's notice count,
    // and neither should happen because an email arrived.
    //
    // What the card then says is worked out by the same rules as the message page's own
    // panel (planFor), so the card never sends the officer to do something the page refuses.
    if (copy && autoFile) {
      const { plan, found, stepTaken } = await this.planFor(tx, ctx, await this.mustFind(tx, ctx, id), {
        caseFileId: autoFile.caseFileId,
      });
      if (found.how === 'match' && found.sure && plan.recordedLetter?.sure && plan.actions[0] === 'link') {
        match.note =
          `Filed as the copy of "${bareSubject(found.sent!.subject)}", recorded as sent on ` +
          `${this.onDay(ctx, found.sent!.sentAt!)}.`;
      } else {
        match.note = `${copyMatch?.note ?? ''} ${this.whatToDoWithCopy(ctx, plan, found, stepTaken)}`.trim();
        autoFile = null;
      }
      await tx.execute(sql`
        UPDATE mail_message SET suggestion_note = ${noNul(match.note)}
        WHERE council_id = ${ctx.councilId}::uuid AND id = ${id}::uuid
      `);
    }
    let autoFiledTo: string | null = null;
    if (autoFile && copy) {
      // The copy of a letter the case already records: attached to that letter, as the
      // officer's "File as the copy" button would. Never recorded as received, and never
      // closes a reminder - see fileCouncilCopy.
      await this.fileCouncilCopy(tx, ctx, {
        mailMessageId: id,
        caseFileId: autoFile.caseFileId,
        mode: 'link',
        rung: autoFile.rung,
      });
      autoFiledTo = autoFile.caseFileId;
    } else if (autoFile) {
      await this.attachToCase(tx, ctx, {
        mailMessageId: id,
        caseFileId: autoFile.caseFileId,
        rung: autoFile.rung,
        subject: parsed.subject ?? '(no subject)',
        body: original.body ?? bodyText,
        fromEmail: original.fromAddress ?? envelope?.address ?? null,
        receivedAt: parsed.date ?? new Date(),
        messageId: parsed.messageId ?? null,
      });
      // The attachments go with it, exactly as when the officer files by hand. They did not,
      // once: a complainant's reply quoting the case number - the usual way the bills the
      // Council asked for arrive - filed itself and closed the "waiting for documents"
      // reminder, while the bills stayed behind on the message and never reached the case.
      await this.fileAttachments(tx, ctx, id, autoFile.caseFileId);
      autoFiledTo = autoFile.caseFileId;
    }

    this.log.log(
      `ingested ${parsed.subject ?? '(no subject)'} from ${original.fromAddress ?? envelope?.address ?? '?'}` +
        (autoFiledTo && copy
          ? ' -> filed as the copy of a recorded letter'
          : autoFiledTo
            ? ' -> auto-filed'
            : copy
              ? ' -> tray (a copy of a Council letter)'
              : ' -> tray') +
        (unconfirmed ? ' (sender not confirmed)' : ''),
    );

    return {
      mailMessageId: id,
      status: autoFiledTo ? 'filed' : 'unfiled',
      duplicate: false,
      autoFiledTo,
      note: match.note,
      attachmentsStored: stored.stored,
      attachmentsSkipped: stored.skipped,
      councilCopy: copy !== null,
      senderCheck,
    };
  }

  /**
   * A message that could not be ingested, written down so that it cannot vanish.
   *
   * The read cursor is the highest UID in the tray, so a message whose ingest fails is only
   * retried until a later message succeeds; after that the reader is past it for good. A
   * complaint that tripped on some malformed part was then lost, with one line in a log and
   * nothing on screen. This puts a card in the tray instead - that it arrived, that it could
   * not be read, and that the original is in the mailbox - and, being a row with a UID, it
   * also lets the cursor move on honestly.
   */
  async recordUnreadable(
    tx: Tx,
    ctx: EngineContext,
    parsed: ParsedMail | null,
    meta: IngestMeta,
    reason: string,
  ): Promise<string | null> {
    const envelope = parsed?.from?.value?.[0];
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO mail_message (
        id, council_id, gm_msg_id, raw_sha256, mailbox, uid, uid_validity,
        envelope_from, envelope_from_name, envelope_date, subject, snippet,
        suggestion_note, created_by
      ) VALUES (
        ${randomUUID()}::uuid, ${ctx.councilId}::uuid, ${meta.gmMsgId ?? null},
        ${createHash('sha256').update(meta.raw).digest('hex')}, ${meta.mailbox},
        ${meta.uid ?? null}, ${meta.uidValidity ?? null},
        ${noNul(envelope?.address?.toLowerCase() ?? 'unknown')}, ${noNul(envelope?.name || null)},
        ${parsed?.date ?? new Date()}, ${noNul(parsed?.subject ?? '(no subject)')},
        ${UNREADABLE_SNIPPET},
        ${noNul(
          `Could not be read automatically (${reason.slice(0, 200)}). Nothing from it is on ` +
            'any case and its attachments were not kept - open it in the mailbox, and ' +
            'forward it again if it is a complaint.',
        )},
        ${ctx.userId ?? null}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    return inserted.rows[0]?.id ?? null;
  }

  /**
   * Put each attachment somewhere it can be retrieved from later.
   *
   * Refused types are RECORDED rather than dropped. The register accepts PDFs and images;
   * real mail carries .docx, .zip, calendar invitations and signature logos. An officer
   * looking at a complaint needs to know that a file came with it and was not stored, and
   * a silent drop is how somebody concludes the complainant never sent their bill.
   */
  private async stageAttachments(
    tx: Tx,
    ctx: EngineContext,
    mailMessageId: string,
    parsed: ParsedMail,
  ): Promise<{ stored: number; skipped: number }> {
    const tally = { stored: 0, skipped: 0 };
    await this.stageFrom(tx, ctx, mailMessageId, parsed.attachments ?? [], 0, tally, null);
    return tally;
  }

  /**
   * One level of attachments, opening any email attached inside it.
   *
   * An email forwarded AS AN ATTACHMENT arrives as a single message/rfc822 part, and the
   * complainant's bills are inside it: mailparser does not lift them out to the outer
   * message. This used to skip that part - reasoning, correctly, that the attached email is
   * the complaint and had been unwrapped already - and with it every file the complainant
   * had attached, without a trace. So each attached email is opened, to MAX_EMBED_DEPTH.
   *
   * Whose files they are matters as much as keeping them. When two complaints are forwarded
   * together as attachments, the first is read as the complaint and the second is somebody
   * else's: staging its files here would put another patient's X-ray on this complainant's
   * case. So `elsewhere`, when set, says these files belong to a different email. They are
   * recorded with that reason and never staged, so they cannot be filed with this message.
   */
  private async stageFrom(
    tx: Tx,
    ctx: EngineContext,
    mailMessageId: string,
    attachments: Attachment[],
    depth: number,
    tally: { stored: number; skipped: number },
    elsewhere: string | null,
  ): Promise<void> {
    const emails = attachments.filter((a) => a.contentType === 'message/rfc822').length;
    let embedded = 0;

    for (const a of attachments) {
      const bytes = a.content as Buffer;

      if (a.contentType === 'message/rfc822') {
        embedded++;
        let inner: ParsedMail | null = null;
        if (depth < MAX_EMBED_DEPTH) {
          try {
            inner = await parseMessage(bytes);
          } catch {
            inner = null;
          }
        }
        if (!inner) {
          await this.recordAttachment(tx, ctx, mailMessageId, tally, a, bytes, null,
            depth < MAX_EMBED_DEPTH
              ? 'An email attached to this one could not be opened. It is still in the mailbox.'
              : 'An email attached several emails deep. It is still in the mailbox.');
          tally.skipped++;
          continue;
        }

        // Inside another email's attachments: everything below it is that email's too.
        if (elsewhere) {
          await this.stageFrom(tx, ctx, mailMessageId, inner.attachments ?? [], depth + 1, tally, elsewhere);
          continue;
        }

        const label = `"${inner.subject ?? 'no subject'}" from ${inner.from?.text ?? 'an unknown sender'}`;

        // The first attached email at the top level, when it names a sender, is the one
        // unwrapForward() read as the complaint: its text is already this message's. Any
        // other attached email is written down, so that it cannot vanish either.
        const isTheComplaint = depth === 0 && embedded === 1 && Boolean(inner.from?.value?.[0]?.address);
        if (!isTheComplaint) {
          await this.recordAttachment(tx, ctx, mailMessageId, tally, a, bytes, null,
            `Another email attached to this one (${label}). Its text is not kept here - read it ` +
              'in the mailbox.');
          tally.skipped++;
        }

        // Its files are this complaint's when it IS the complaint, when it was the only email
        // attached, or when it sits inside the complaint (a clinic's email the complainant
        // attached to theirs). A second complaint forwarded alongside keeps its own.
        const belongsHere = isTheComplaint || depth > 0 || emails === 1;
        await this.stageFrom(tx, ctx, mailMessageId, inner.attachments ?? [], depth + 1, tally,
          belongsHere
            ? null
            : `Attached to the other email (${label}), not to this complaint, so it is not ` +
                'filed with it. It is in the mailbox.');
        continue;
      }

      let stagingKey: string | null = null;
      let skippedReason: string | null = null;

      if (elsewhere) {
        skippedReason = elsewhere;
      } else if (bytes.length === 0) {
        skippedReason = 'The file was empty.';
      } else if (bytes.length > MAX_UPLOAD_BYTES) {
        skippedReason =
          `${Math.round(bytes.length / 1_048_576)} MB, over the ` +
          `${MAX_UPLOAD_BYTES / 1_048_576} MB limit.`;
      } else if (isSignatureImage(a, bytes)) {
        // Before the type check, not after it: a GIF or WebP logo is not a kind the register
        // stores, and would otherwise be reported as a file it refused - a warning on the
        // card for nothing. Recorded, not dropped, so the officer can still see it came.
        skippedReason = SIGNATURE_LOGO_REASON;
      } else if (!sniff(bytes)) {
        // Sniffed from the bytes, never trusted from the declared type - the same rule
        // the browser upload path follows.
        skippedReason = `Not a kind the register stores (declared ${a.contentType}).`;
      } else {
        // Not caught. If the store will not take a file, the whole message fails and the
        // sweep stops at it and tries again (see sweepMailbox). Recording it as "not stored"
        // instead looked kinder and was not: the message then filed itself without the bill
        // and closed the reminder that was waiting for it, and nothing ever retried it.
        stagingKey = `${STAGING_PREFIX}${randomUUID()}`;
        await this.storage.write(stagingKey, bytes, a.contentType);
      }

      await this.recordAttachment(tx, ctx, mailMessageId, tally, a, bytes, stagingKey, skippedReason);
      if (stagingKey) tally.stored++;
      else tally.skipped++;
    }
  }

  private async recordAttachment(
    tx: Tx,
    ctx: EngineContext,
    mailMessageId: string,
    tally: { stored: number; skipped: number },
    a: Attachment,
    bytes: Buffer,
    stagingKey: string | null,
    skippedReason: string | null,
  ): Promise<void> {
    // Numbered, so two unnamed files on one message can still be told apart.
    const n = tally.stored + tally.skipped + 1;
    const filename =
      a.filename || (a.contentType === 'message/rfc822' ? `attached-email-${n}.eml` : `attachment-${n}`);
    await tx.execute(sql`
      INSERT INTO mail_attachment (council_id, mail_message_id, filename, declared_type,
                                   size_bytes, sha256, staging_key, skipped_reason)
      VALUES (${ctx.councilId}::uuid, ${mailMessageId}::uuid, ${noNul(filename)},
              ${noNul(a.contentType)}, ${bytes.length},
              ${createHash('sha256').update(bytes).digest('hex')}, ${stagingKey},
              ${noNul(skippedReason)})
    `);
  }

  // ─── Acting on a message ───────────────────────────────────────────────────

  /**
   * Open a case from a message in the tray.
   *
   * The complainant's details come from the unwrapped original, so the case is opened in
   * the name of the person who complained rather than the officer who forwarded it. The
   * officer can correct any of it on the way through.
   */
  async openCase(
    tx: Tx,
    ctx: EngineContext,
    args: {
      mailMessageId: string;
      summary?: string;
      complainantName?: string;
      complainantEmail?: string | null;
      receivedOn?: string;
      intakeSource?: IntakeSource;
      /**
       * The officer's word that a message the register took for a copy of the Council's own
       * letter is a complaint after all - a complainant's reply to the Council's "please send
       * your complaint in writing" mail, quoting it in a layout the register misread, say.
       * Without it such a message could only be set aside: a copy has no case to go on.
       */
      asComplaint?: boolean;
    },
  ): Promise<{ caseFileId: string; caseNumber: string; documentsFiled: number }> {
    const m = await this.mustFind(tx, ctx, args.mailMessageId);
    if (m.status !== 'unfiled') {
      throw new ConflictError(
        m.status === 'filed'
          ? 'That message is already on a case.'
          : 'That message was dismissed. Restore it before opening a case from it.',
      );
    }
    // Opened as a complaint, the Council's own letter would become a case with the patient
    // as complainant - and no complaint from them on file at all. See council-copy.ts. The
    // officer can say otherwise (asComplaint); everything below still holds then, including
    // the refusal to open a case in the Council's own name.
    const own = await this.ownAddresses(tx, ctx, m.mailbox);
    const detectedCopy = this.copyOf(m, own) !== null;
    if (detectedCopy && !args.asComplaint) {
      throw new DomainError(
        'This is a copy of a letter the Council sent, not a complaint. File it on the case ' +
          'it belongs to - or, if it is a complaint after all, say so on the message page.',
      );
    }

    // What arrived, not when it was typed in. A forward that sat unread for a week should
    // open a case dated from the day it reached the Council.
    const receivedAt = args.receivedOn
      ? new Date(`${args.receivedOn}T00:00:00Z`)
      : asDate(m.original_date ?? m.envelope_date);

    const summary = (args.summary ?? m.original_subject ?? m.subject ?? '').trim();
    if (!summary) {
      throw new DomainError('A one-line summary of the grievance is needed to open a case.');
    }

    // Always give the case a complainant. intake.create() only creates party rows when one
    // is supplied, and a case with no parties has nobody for a letter to go to.
    //
    // What the officer typed wins. Otherwise the message's own answer - which is never an
    // address of the Council's (see complainant.ts). When the message cannot say, the case
    // is not opened in the Council's name: the officer is asked. That refusal is the whole
    // point, and it is what the tray's quick "Open a case" runs into on a forward it could
    // not read.
    const suggested = suggestedComplainant(m, own);
    const typedName = args.complainantName?.trim();
    if (!typedName && !suggested) {
      throw new DomainError(
        "This message came from the Council's own address and the original sender could " +
          "not be read from it. Open the message and enter the complainant's name and email.",
      );
    }
    const name = typedName || suggested!.name;
    const email =
      args.complainantEmail !== undefined
        ? args.complainantEmail?.trim() || null
        : // A typed name with the suggested email would pair two different people when
          // the officer has corrected who complained, so the email follows the name.
          typedName && typedName !== suggested?.name
          ? null
          : (suggested?.email ?? null);

    const created = await this.intake.create(tx, ctx, {
      summary,
      receivedAt,
      // A forward from the council's own inbox is how these arrive today.
      intakeSource: args.intakeSource ?? 'direct_email',
      complainant: { fullName: name, email },
    });

    await this.attachToCase(tx, ctx, {
      mailMessageId: m.id,
      caseFileId: created.caseFileId,
      rung: 'officer',
      subject: m.subject,
      ...this.asLetterReceived(m, own, detectedCopy),
      receivedAt,
      messageId: m.message_id,
    });

    const documentsFiled = await this.fileAttachments(tx, ctx, m.id, created.caseFileId);
    // The override, kept on the message: the page stops calling it the Council's letter.
    if (detectedCopy) await this.markNotACopy(tx, ctx, m.id);
    await this.tellAssistant(tx, ctx, m.id, { action: 'opened_case', caseFileId: created.caseFileId });
    return { ...created, documentsFiled };
  }

  /**
   * File a message onto a case that already exists.
   *
   * `asReceived`: the officer's word that a message the register took for a copy of the
   * Council's own letter is not one - a reply quoting our letter in a layout the register
   * misread, say. It is then filed as what it is, a letter received, with everything that
   * means: every reminder on the case that is waiting for a reply stops (satisfyWaiting),
   * which is why the page asks first and lists them (CouncilCopyPlan.waitingForReply). The
   * answer is kept on the message (markNotACopy). Without this a misreading would be a dead
   * end: a copy is otherwise always filed as a copy.
   */
  async fileOnCase(
    tx: Tx,
    ctx: EngineContext,
    args: { mailMessageId: string; caseFileId: string; asReceived?: boolean },
  ): Promise<{ documentsFiled: number }> {
    const m = await this.mustFind(tx, ctx, args.mailMessageId);
    if (m.status === 'filed') throw new ConflictError('That message is already on a case.');
    // The picker no longer offers a cancelled case, but a tab opened before the case was
    // cancelled still does. Filing onto it would put the message - and its attachments -
    // on a case no list leads to, and take the message out of the tray where it was
    // visible. See case-guard.
    await assertCaseLive(tx, ctx, args.caseFileId);

    // A copy of the Council's own letter is never a letter received, and filing it never
    // closes a reminder: see fileCopyByDefault for what "Add to a case" does with one.
    const own = await this.ownAddresses(tx, ctx, m.mailbox);
    const detectedCopy = this.copyOf(m, own) !== null;
    if (!args.asReceived && detectedCopy) {
      const filed = await this.fileCopyByDefault(tx, ctx, {
        mailMessageId: m.id,
        caseFileId: args.caseFileId,
      });
      return { documentsFiled: filed.documentsFiled };
    }

    await this.attachToCase(tx, ctx, {
      mailMessageId: m.id,
      caseFileId: args.caseFileId,
      rung: 'officer',
      subject: m.subject,
      ...this.asLetterReceived(m, own, detectedCopy),
      receivedAt: asDate(m.original_date ?? m.envelope_date),
      messageId: m.message_id,
    });

    const documentsFiled = await this.fileAttachments(tx, ctx, m.id, args.caseFileId);
    // The override, kept on the message (see copyOf).
    if (detectedCopy) await this.markNotACopy(tx, ctx, m.id);
    await this.tellAssistant(tx, ctx, m.id, { action: 'filed_on_case', caseFileId: args.caseFileId });
    return { documentsFiled };
  }

  /**
   * Who a message filed as a letter received is from, and its words.
   *
   * Ordinarily the original's sender and body - the complainant's, not the office's that
   * forwarded it. But a message the register took for a copy of the Council's letter, and
   * the officer has said is not one, was misread: its "original" is the Council's own
   * letter, quoted at the foot of the reply, and its sender the Council. Recorded as that,
   * the case would show a letter received FROM the Council, in the Council's own words,
   * with the reply that actually came nowhere on it - and the Council's address would make
   * the case a sender suggestion for every later office forward. So the message's own text,
   * which holds the reply, and no sender rather than a Council one.
   */
  private asLetterReceived(
    m: NonNullable<Awaited<ReturnType<MailIntakeService['find']>>>,
    own: OwnAddresses,
    misreadCopy: boolean,
  ): { fromEmail: string | null; body: string } {
    const from = m.original_from ?? m.envelope_from;
    if (misreadCopy && isOwnAddress(from, own)) {
      return { fromEmail: null, body: m.body_text ?? m.original_body ?? '' };
    }
    return { fromEmail: from, body: m.original_body ?? m.body_text ?? '' };
  }

  /**
   * Not a complaint.
   *
   * The message stays. A reason is required, because the tray is the record of what the
   * Council received, and a message that could simply vanish from it would make the tray
   * evidence of nothing.
   */
  async dismiss(
    tx: Tx,
    ctx: EngineContext,
    args: { mailMessageId: string; reason: string },
  ): Promise<void> {
    if (!args.reason?.trim()) {
      throw new DomainError('Say why this is not a complaint. It stays on the record either way.');
    }
    const m = await this.mustFind(tx, ctx, args.mailMessageId);
    if (m.status === 'filed') {
      throw new ConflictError('That message is on a case. It cannot be dismissed.');
    }
    await tx.execute(sql`
      UPDATE mail_message
      SET status = 'dismissed', dismissed_at = now(),
          dismissed_reason = ${args.reason.trim()}, dismissed_by = ${ctx.userId ?? null}
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${m.id}::uuid
    `);
    await this.tellAssistant(tx, ctx, m.id, { action: 'set_aside', reason: args.reason.trim() });
  }

  /** Put a dismissed message back in the tray. */
  async restore(tx: Tx, ctx: EngineContext, args: { mailMessageId: string }): Promise<void> {
    await tx.execute(sql`
      UPDATE mail_message
      SET status = 'unfiled', dismissed_at = NULL, dismissed_reason = NULL, dismissed_by = NULL
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.mailMessageId}::uuid
        AND status = 'dismissed'
    `);
  }

  // ─── Copies of the Council's own letters ───────────────────────────────────
  //
  // See council-copy.ts for what a copy is and why it cannot be filed as a reply. The rules
  // the officer was promised, all of which hold here:
  //
  //   - A copy is never recorded as a letter received, and never closes a reminder.
  //   - A copy of a letter the case already records is attached to that letter. Nothing
  //     new is added, and the reminders keep running.
  //   - A letter the case does not record is recorded only when the officer says so,
  //     because recording it starts a reminder or moves a dentist's notice count.

  /** Whether a message is a copy of a Council letter. For the automatic assistant's skip. */
  async isCouncilCopy(tx: Tx, ctx: EngineContext, mailMessageId: string): Promise<boolean> {
    const m = await this.find(tx, ctx, mailMessageId);
    return m ? this.copyOf(m, await this.ownAddresses(tx, ctx, m.mailbox)) !== null : false;
  }

  /**
   * Whether a message came from a listed address the mail provider could not confirm
   * (sender-check.ts). For the automatic assistant's skip: whether it is genuine at all is
   * the officer's question, and a model reading its words cannot answer it. The officer can
   * still press "Ask the assistant" on one.
   */
  async hasUnconfirmedSender(tx: Tx, ctx: EngineContext, mailMessageId: string): Promise<boolean> {
    const m = await this.find(tx, ctx, mailMessageId);
    return m?.sender_check === 'unverified';
  }

  /**
   * How many messages that arrived today were set aside for not coming from a listed
   * address - for the tray's quiet line pointing at "Set aside". "Today" in the council's
   * own calendar. Only those still set aside: one the officer has brought back is not.
   * Mostly those set aside on arrival; a message that arrived today and was set aside by
   * the one-off script (sender-rule.ts, which marks what it sets aside the same way) counts
   * too - it is in "Set aside" for the same reason, which is what the line points to.
   */
  async setAsideFromOtherSendersToday(tx: Tx, ctx: EngineContext): Promise<number> {
    const rows = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM mail_message
      WHERE council_id = ${ctx.councilId}::uuid
        AND status = 'dismissed' AND sender_check = 'not_allowed'
        AND ingested_at >= (date_trunc('day', now() AT TIME ZONE ${ctx.config.calendar.timezone})
                            AT TIME ZONE ${ctx.config.calendar.timezone})
    `);
    return rows.rows[0]?.n ?? 0;
  }

  /**
   * What filing this copy on this case would mean, for the message page to offer.
   *
   * Works on any message, detected as a copy or not, so that a copy the detector missed
   * (one the assistant recognised) can still be filed as one; its recipients are then
   * simply unknown. `kind` is the officer's answer to "which letter is this", when the
   * subject alone does not settle it (kindOptions).
   */
  async councilCopyPlan(
    tx: Tx,
    ctx: EngineContext,
    args: { mailMessageId: string; caseFileId: string; kind?: CorrespondenceKind },
  ): Promise<CouncilCopyPlan> {
    const m = await this.mustFind(tx, ctx, args.mailMessageId);
    return (await this.planFor(tx, ctx, m, args)).plan;
  }

  /**
   * The plan, and what it was worked out from. Every path that files a copy goes through
   * this - the message page's panel, "Add to a case", the assistant's Accept, a copy filing
   * itself at ingest - and fileCouncilCopy refuses whatever the plan does not offer, so no
   * path can do what the page would have refused: record a letter the case already records,
   * or record a step the case has moved past.
   */
  private async planFor(
    tx: Tx,
    ctx: EngineContext,
    m: NonNullable<Awaited<ReturnType<MailIntakeService['find']>>>,
    args: { caseFileId: string; kind?: CorrespondenceKind },
  ): Promise<{
    plan: CouncilCopyPlan;
    found: RecordedLetterMatch;
    kind: CorrespondenceKind | null;
    parties: Awaited<ReturnType<typeof partiesOnCase>>;
    /** "documents asked for on 9 Oct", when the case has moved past the letter's step. */
    stepTaken: string | null;
  }> {
    const facts = await this.copyFacts(tx, ctx, m);

    const caseRows = await tx.execute<{
      id: string;
      case_number: string;
      state: CaseState;
      deleted_at: Date | null;
    }>(sql`
      SELECT id, case_number, state, deleted_at FROM case_file
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.caseFileId}::uuid
    `);
    const c = caseRows.rows[0];
    if (!c) throw new NotFoundError('That case is not in the register.');

    const recipients = facts.copy?.recipients ?? [];
    const sentTo = recipients.map((r) => r.email);
    // This case asked about directly, uncapped; the others only to name them. Only a party
    // elsewhere says the letter went to the wrong case (see matchCouncilCopy).
    const here = await casesByRecipient(tx, ctx, sentTo, { onlyCaseFileId: c.id });
    const others = await casesByRecipient(tx, ctx, sentTo, { excludeCaseFileId: c.id });
    const partyOthers = others.filter((x) => x.viaParty);
    const said = (xs: string[]) =>
      xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

    let check: CouncilCopyPlan['check'];
    let checkNote: string;
    if (here.length > 0) {
      check = 'confirmed';
      checkNote =
        `It was sent to ${said(here.map((x) => x.address))}, who is on ${c.case_number}: the ` +
        'case and the person it went to agree.';
    } else if (partyOthers.length > 0) {
      check = 'mismatch';
      checkNote =
        `It was sent to ${said([...new Set(partyOthers.map((x) => x.address))])}, who is on ` +
        `${said(partyOthers.map((x) => x.caseNumber))} - not on ${c.case_number}. Check this is the ` +
        'right case, and whether the letter went to the right person.';
    } else {
      check = 'unverified';
      checkNote = !sentTo.length
        ? 'The message does not say who the letter went to, so the case cannot be checked ' +
          'against the person it went to.'
        : others.length
          ? `${said(sentTo)} ${sentTo.length > 1 ? 'are' : 'is'} not on file on ${c.case_number}. ` +
            `Letters on ${said(others.map((x) => x.caseNumber))} went to the same address, but ` +
            'nobody with it is a party there, so the case cannot be checked against the person ' +
            'it went to.'
          : `${said(sentTo)} ${sentTo.length > 1 ? 'are' : 'is'} not on file on ${c.case_number} ` +
            'or on any other case, so the case cannot be checked against the person it went to.';
    }

    // Which letter it is. Templates that share a subject (the two hearing notices) are told
    // apart by who the copy went to; when even that does not settle it, the officer is asked.
    const parties = await partiesOnCase(tx, ctx, c.id);
    const recipientNames = new Set(recipients.map((r) => comparableName(r.name)).filter(Boolean));
    const recipientRoles = parties
      .filter((p) => (p.email && sentTo.includes(p.email)) || recipientNames.has(comparableName(p.name)))
      .map((p) => p.role);
    const resolved = kindForRecipient(facts.kinds, recipientRoles);
    const labelOf = (k: CorrespondenceKind) => facts.templates.find((t) => t.kind === k)?.name ?? null;
    // Offered whenever the subject is two letters and the recipient does not settle which -
    // also once the officer has answered, so a wrong answer can be changed on the page.
    const kindOptions =
      !resolved && facts.kinds.length > 1 ? facts.kinds.map((k) => ({ kind: k, label: labelOf(k) ?? k })) : [];
    // The officer's answer, when it is one of those letters (or, with no question to answer,
    // their correction of the subject's). Never a guess: with the question open and no
    // answer, the kind is unknown, and nothing that depends on it is done - recording the
    // dentist's hearing notice as the complainant's would mark the complainant's draft sent.
    const chosen =
      args.kind && (kindOptions.length === 0 || facts.kinds.includes(args.kind)) ? args.kind : undefined;
    const kind = chosen ?? resolved ?? (kindOptions.length ? null : (facts.kinds[0] ?? null));
    const undecided = kind === null && kindOptions.length > 0;

    const found = await findRecordedLetter(tx, ctx, c.id, {
      kind,
      subject: facts.letterSubject,
      date: facts.when.date,
      basis: facts.when.basis,
      recipients,
    });
    const draft = found.draft && (!kind || found.draft.kind === kind) ? found.draft : null;
    const event = kind ? (EVENT_FOR_KIND[kind] ?? null) : null;
    const eventAvailable =
      event !== null &&
      !c.deleted_at &&
      availableEvents(c.state, { phase: ctx.config.buildPhase }).some((t) => t.event === event);

    const respondents = await tx.execute<{
      id: string;
      name: string;
      notice_count: number;
      email: string | null;
    }>(sql`
      SELECT cr.id, p.full_name AS name, cr.notice_count, lower(p.email) AS email
      FROM case_respondent cr
      JOIN case_party cp ON cp.id = cr.case_party_id
      JOIN party p ON p.id = cp.party_id
      WHERE cr.council_id = ${ctx.councilId}::uuid AND cr.case_file_id = ${c.id}::uuid
        AND cr.dropped_at IS NULL
      ORDER BY p.full_name
    `);

    // Recording it as sent is offered only when doing so means something the case can
    // still take: a letter that moves nothing, or a step the case is at now. A draft of the
    // letter does not make a step the case has moved past available again - the draft is
    // reused if the step can be recorded, and is otherwise closed off by record_only.
    const available = availableEvents(c.state, { phase: ctx.config.buildPhase });
    const canRecordKind = (k: CorrespondenceKind) => {
      const e = EVENT_FOR_KIND[k] ?? null;
      return k !== 'other' && (e === null || (!c.deleted_at && available.some((t) => t.event === e)));
    };
    const canRecord = kind !== null && canRecordKind(kind);
    const recorded = found.sent;
    const onDay = (d: Date) => this.onDay(ctx, d);
    const earlierOne = found.previous
      ? ` It records "${bareSubject(found.previous.subject)}" as sent on ${onDay(found.previous.sentAt!)}, ` +
        'more than a fortnight before this copy is dated - a different letter.'
      : '';

    // The recorded letter is this copy's beyond doubt: around its date, the kind it is, to
    // the person it went to, with nothing else that fits as well - and the officer is not
    // still to say which letter it is. Only then is attaching it the one thing offered, and
    // only then may a button other than the panel's own do it (fileCopyByDefault).
    const linkSure =
      recorded !== null && (found.how === 'match' || found.how === 'already_copied') && found.unsure === null && !undecided;
    const recordable = undecided ? kindOptions.some((o) => canRecordKind(o.kind)) : canRecord;

    let actions: CouncilCopyMode[];
    let explanation: string;
    let past: { explanation: string; stepTaken: string | null } | null = null;
    if (recorded && (found.how === 'match' || found.how === 'already_copied') && !linkSure) {
      // Perhaps that letter; perhaps another one, which the case does not record. The
      // officer says which: attaching it is offered first, recording it beside it - never
      // the one choice, and never made by "Add to a case" or Accept.
      actions = recordable ? ['link', 'record_sent', 'record_only'] : ['link', 'record_only'];
      const to = recorded.toName ? ` to ${recorded.toName}` : '';
      const why =
        found.unsure === 'several'
          ? ` The case records more than one letter like it around then.`
          : found.unsure === 'other_kind'
            ? ' That is a different letter that only shares its subject.'
            : found.unsure === 'addressee'
              ? ` This copy went to ${said(sentTo) || 'an address'}, which is not on file for ${recorded.toName ?? 'whoever that letter went to'}.`
              : '';
      explanation =
        `It may be the copy of "${bareSubject(recorded.subject)}", recorded as sent on ` +
        `${onDay(recorded.sentAt!)}${to}${recorded.copied ? ', which already has a copy on file' : ''}.${why} ` +
        'If it is, file it with that letter. If it is a different letter, put it on the case instead.' +
        (undecided
          ? ` Its subject is the same for ${said(kindOptions.map((o) => `the ${o.label}`))}: say which letter it is before recording it.`
          : '');
    } else if (recorded && found.how === 'match') {
      actions = ['link'];
      explanation =
        `${c.case_number} already records "${bareSubject(recorded.subject)}" as sent on ` +
        `${onDay(recorded.sentAt!)}. Filing the copy attaches it to that letter as ` +
        'proof of what was sent. Nothing new is added to the case, and its reminders keep running.';
    } else if (recorded && found.how === 'already_copied') {
      // Never "no record": the letter IS recorded, and recording it again would count a
      // notice twice. A second copy of it goes with the first, or is not needed at all.
      actions = ['link'];
      explanation =
        `${c.case_number} already records "${bareSubject(recorded.subject)}" as sent on ` +
        `${onDay(recorded.sentAt!)}, and a copy of it is already on file. Filing this one adds ` +
        'it to that letter as a second copy - nothing new is added to the case, and its ' +
        'reminders keep running. If it is not needed, set it aside instead.';
    } else if (recorded && found.how === 'earlier') {
      // Perhaps this letter, forwarded late; perhaps an earlier one, and this a second
      // letter of the same kind. Both offered, the likelier first - but never claimed to be
      // the only one, and never chosen without the officer (fileCopyByDefault).
      actions = canRecord ? ['link', 'record_sent', 'record_only'] : ['link', 'record_only'];
      explanation =
        `${c.case_number} records "${bareSubject(recorded.subject)}" as sent on ` +
        `${onDay(recorded.sentAt!)}${recorded.copied ? ', with a copy already on file,' : ''} more than a ` +
        `fortnight before this copy was forwarded (${onDay(facts.when.date)}` +
        `${m.original_date_text ? `; the forward says "${m.original_date_text}"` : ''}). ` +
        'If this is the copy of that letter, file it there. If the Council sent the letter ' +
        'again, put it on the case as a second letter.';
    } else if (undecided) {
      actions = kindOptions.some((o) => canRecordKind(o.kind)) ? ['record_sent', 'record_only'] : ['record_only'];
      explanation =
        `Its subject is the same for ${said(kindOptions.map((o) => `the ${o.label}`))}, and the person it ` +
        'went to is not on file as either. Say which letter it is before it is put on the case.';
    } else if (canRecord) {
      actions = ['record_sent', 'record_only'];
      explanation = `${c.case_number} has no record of this letter being sent${found.previous ? ' around then.' : '.'}${earlierOne}`;
    } else {
      actions = ['record_only'];
      explanation = !kind
        ? "The letter's subject is not one of the Council's templates, so it can only be put " +
          'on the case as a letter sent.'
        : event
          ? (past = await this.pastThisStep(tx, ctx, c.id, c.case_number, event)).explanation
          : 'It can be put on the case as a letter sent.';
    }

    const plan: CouncilCopyPlan = {
      caseFileId: c.id,
      caseNumber: c.case_number,
      recipients,
      copyDate: facts.when.date,
      copyDateBasis: facts.when.basis,
      dateText: facts.direct ? null : m.original_date_text,
      kind,
      kindLabel: kind ? labelOf(kind) : null,
      kindOptions,
      check,
      checkNote,
      recordedLetter: recorded
        ? {
            id: recorded.id,
            kind: recorded.kind,
            subject: recorded.subject,
            sentAt: recorded.sentAt!,
            how: found.how!,
            copied: recorded.copied,
            sure: linkSure,
          }
        : null,
      draft: draft ? { id: draft.id, kind: draft.kind, subject: draft.subject } : null,
      event,
      eventAvailable,
      needsRespondent: event === 'ISSUE_RESPONDENT_NOTICE',
      respondents: respondents.rows.map((r) => ({
        id: r.id,
        name: r.name,
        noticeCount: Number(r.notice_count),
        sentTo:
          (r.email !== null && sentTo.includes(r.email)) ||
          (recipientNames.size > 0 && recipientNames.has(comparableName(r.name))),
      })),
      actions,
      explanation,
      effect: event ? this.effectOf(ctx, event) : kind ? 'Nothing else on the case moves.' : null,
      waitingForReply: [
        ...new Map(
          (await this.followups.liveForCase(tx, ctx, c.id))
            .filter((f) => ANSWERED_BY_A_REPLY.includes(f.stage as FollowupStage))
            .map((f) => [f.id, { stage: f.stage as FollowupStage, label: f.title }] as const),
        ).values(),
      ],
    };
    return { plan, found, kind, parties, stepTaken: past?.stepTaken ?? null };
  }

  /**
   * The end of a copy's tray note when it did not file itself: what the officer will find
   * on the message page, in the same terms the page uses (see planFor).
   */
  private whatToDoWithCopy(
    ctx: EngineContext,
    plan: CouncilCopyPlan,
    found: RecordedLetterMatch,
    stepTaken: string | null,
  ): string {
    const r = found.sent;
    const tier = found.how === 'match' || found.how === 'already_copied';
    if (r && tier && !plan.recordedLetter?.sure) {
      if (found.unsure === null && !plan.kind && plan.kindOptions.length > 0) {
        return (
          `${plan.caseNumber} records "${bareSubject(r.subject)}" as sent around then, but this ` +
          `copy's subject is the same for ${plan.kindOptions.map((o) => `the ${o.label}`).join(' and ')} - ` +
          'open the message to say which letter it is.'
        );
      }
      if (found.unsure === 'other_kind') {
        return (
          `${plan.caseNumber} records "${bareSubject(r.subject)}" as sent around then, but as a ` +
          'different letter from this one - open the message to check which this is.'
        );
      }
      if (found.unsure === 'addressee') {
        return (
          `${plan.caseNumber} records "${bareSubject(r.subject)}" as sent around then` +
          `${r.toName ? ` to ${r.toName}` : ''}, but this copy went to an address not on file for ` +
          'them - open the message to check whether it is the copy of that letter.'
        );
      }
      return (
        `${plan.caseNumber} records more than one letter like "${bareSubject(r.subject)}" as sent ` +
        'around then - open the message to check which this is the copy of.'
      );
    }
    if (r && found.how === 'already_copied') {
      return (
        `${plan.caseNumber} already records this letter as sent on ${this.onDay(ctx, r.sentAt!)}, ` +
        'and a copy of it is already on file - open the message to add this one to it, or set ' +
        'it aside as not needed.'
      );
    }
    if (r && found.how === 'match') {
      return (
        `${plan.caseNumber} records this letter as sent on ${this.onDay(ctx, r.sentAt!)} - open the ` +
        'message to file the copy with it.'
      );
    }
    if (r && found.how === 'earlier') {
      return (
        `${plan.caseNumber} records a letter like this as sent on ${this.onDay(ctx, r.sentAt!)}, ` +
        'more than a fortnight earlier - open the message to check whether this is the copy of it.'
      );
    }
    if (!plan.kind && plan.kindOptions.length > 0) {
      return (
        `Its subject is the same for ${plan.kindOptions.map((o) => `the ${o.label}`).join(' and ')}, ` +
        'and the person it went to is not on file as either - open the message to say which it is.'
      );
    }
    if (plan.actions[0] === 'record_sent') {
      return `${plan.caseNumber} has no record of this letter being sent - open the message to record it.`;
    }
    if (!plan.kind) {
      return (
        "Its subject is not one of the Council's letters, so it cannot be recorded as one - open " +
        `the message to put it on ${plan.caseNumber} as a letter sent.`
      );
    }
    if (stepTaken) {
      return (
        `${plan.caseNumber} already records this step (${stepTaken}), so it is not recorded ` +
        'again - open the message to put the copy on file.'
      );
    }
    // Not past the step: before it, or a letter with no step at all. Never "already records
    // this step" - that would tell the officer a dentist's notice is counted when it is not.
    return plan.event
      ? `${plan.caseNumber} is not at the step this letter belongs to, so it is not recorded as ` +
          'that step - open the message to put the copy on the case as a letter sent.'
      : `It can only be put on ${plan.caseNumber} as a letter sent - open the message to do that.`;
  }

  /**
   * File a copy without the message page's panel: "Add to a case", or the assistant's Accept.
   *
   * Attached to the letter it copies when the case records it around the copy's date (the
   * plan's first choice, which is then 'link'); otherwise put on the case as a letter sent,
   * moving nothing. "Record it as sent", which starts a reminder or counts a notice, is a
   * button of its own on the message page and never happens because some other button was
   * pressed. A draft of the letter is closed off as that letter (fileCouncilCopy,
   * record_only), so "I have sent this" on it later cannot record it a second time.
   *
   * Refused, sending the officer to the message page, whenever the choice is theirs to make:
   * a letter recorded long before a copy that only shows when it was forwarded (this letter,
   * forwarded late - or another one?), a subject that is two letters, a copy that does not
   * say when its letter went out (fileCouncilCopy).
   */
  async fileCopyByDefault(
    tx: Tx,
    ctx: EngineContext,
    args: { mailMessageId: string; caseFileId: string; asCouncilCopy?: boolean },
  ): Promise<CouncilCopyFiled & { caseNumber: string }> {
    const m = await this.mustFind(tx, ctx, args.mailMessageId);
    const { plan } = await this.planFor(tx, ctx, m, { caseFileId: args.caseFileId });
    const r = plan.recordedLetter;
    if (r?.how === 'earlier') {
      throw new DomainError(
        `${plan.caseNumber} records "${bareSubject(r.subject)}" as sent on ${this.onDay(ctx, r.sentAt)}, ` +
          'more than a fortnight before this copy was forwarded. Open the message to say whether ' +
          'this is the copy of that letter or a new one.',
      );
    }
    // Which letter it is, when the subject is two of them: never guessed by a button that
    // does not ask (fileCouncilCopy refuses the recording ways too).
    if (plan.kind === null && plan.kindOptions.length > 0) {
      throw new DomainError(
        `Its subject is the same for ${plan.kindOptions.map((o) => `the ${o.label}`).join(' and ')}. ` +
          'Open the message and say which letter it is before it is put on the case.',
      );
    }
    // A letter it may or may not be the copy of - another dentist's notice sent the same
    // week, one of two letters nothing tells apart, a letter that only shares its subject.
    // Attached without the officer, the case would hold one person's copy as proof of
    // service of another person's letter, and the letter this copy is would go unrecorded.
    if (r && !r.sure && plan.actions[0] === 'link') {
      throw new DomainError(
        `It may be the copy of "${bareSubject(r.subject)}", recorded on ${plan.caseNumber} as sent on ` +
          `${this.onDay(ctx, r.sentAt)}, but that is not certain. Open the message to say whether it ` +
          'is, or to put it on the case as a different letter.',
      );
    }
    const filed = await this.fileCouncilCopy(tx, ctx, {
      mailMessageId: m.id,
      caseFileId: args.caseFileId,
      mode: plan.actions[0] === 'link' ? 'link' : 'record_only',
      asCouncilCopy: args.asCouncilCopy,
    });
    return { ...filed, caseNumber: plan.caseNumber };
  }

  /**
   * File a copy of a Council letter on a case - by the officer's button, by fileOnCase, by
   * the assistant's Accept, or by ingest when the copy is of a letter the case already
   * records.
   *
   * NEVER records the copy as a letter received and NEVER closes a reminder: the copy is
   * the Council's own words, not anybody's answer. Whatever the mode, the message ends up
   * linked to the outgoing letter it is a copy of.
   *
   * Only a way the plan offers NOW is taken. A page loaded before "I have sent this" was
   * clicked in another tab still shows "record it as sent"; carried out, that would add a
   * second letter and count a dentist's notice twice, which is the basis of an ex parte
   * finding. So the plan is worked out again here, and a way it no longer offers is refused.
   */
  async fileCouncilCopy(
    tx: Tx,
    ctx: EngineContext,
    args: {
      mailMessageId: string;
      caseFileId: string;
      mode: CouncilCopyMode;
      /** When the letter went out. Defaults to the copy's own date. */
      sentAt?: Date;
      /** Which letter it is, when the subject alone does not say (or says wrongly). */
      kind?: CorrespondenceKind;
      /** The dentist a notice went to. Required to record a notice as sent. */
      caseRespondentId?: string | null;
      /** File it as a copy although the addresses do not show it is one (the assistant's accept). */
      asCouncilCopy?: boolean;
      rung?: MailMatchRung;
    },
  ): Promise<CouncilCopyFiled> {
    const m = await this.mustFind(tx, ctx, args.mailMessageId);
    if (m.status === 'filed') throw new ConflictError('That message is already on a case.');
    await assertCaseLive(tx, ctx, args.caseFileId);

    const facts = await this.copyFacts(tx, ctx, m);
    if (!facts.copy && !args.asCouncilCopy) {
      throw new DomainError(
        'This message is not a copy of a letter the Council sent, so it cannot be filed as ' +
          'one. Add it to the case in the ordinary way instead.',
      );
    }
    if (args.kind === 'inbound') {
      throw new DomainError('A letter the Council sent cannot be recorded as a letter received.');
    }
    if (args.sentAt && args.sentAt.getTime() > Date.now()) {
      throw new DomainError('A letter cannot have been sent on a date that has not come yet.');
    }

    const { plan, found, kind, parties } = await this.planFor(tx, ctx, m, {
      caseFileId: args.caseFileId,
      kind: args.kind,
    });
    if (!plan.actions.includes(args.mode)) {
      throw new ConflictError(
        args.mode === 'link'
          ? 'This case no longer has a letter recorded as sent that this could be the copy of. ' +
              'Reload the page to see what can be done with it now.'
          : plan.actions[0] === 'link' && plan.recordedLetter?.sure
            ? `${plan.caseNumber} now records this letter as sent, so it is not recorded again. ` +
                'Reload the page: the copy can be attached to that letter.'
            : `${plan.explanation} Reload the page to see what can be done with it now.`,
      );
    }
    // Recording needs to know which letter it is: with the subject two letters and no answer,
    // a guess would record the dentist's hearing notice as the complainant's, and close off
    // the complainant's own draft as sent although it never went out.
    if (args.mode !== 'link' && plan.kind === null && plan.kindOptions.length > 0) {
      throw new DomainError(
        `Its subject is the same for ${plan.kindOptions.map((o) => `the ${o.label}`).join(' and ')}. ` +
          'Open the message and say which letter it is before it is put on the case.',
      );
    }
    // And when it went out. A copy that only shows when it was forwarded does not say; the
    // forward's day would record the letter late, which the page itself refuses to suggest.
    if (args.mode !== 'link' && !args.sentAt && facts.when.basis === 'forwarded') {
      throw new DomainError(
        'The copy shows only when it was forwarded, not when the letter went out. Open the ' +
          'message and enter the day it was sent.',
      );
    }

    // The copy's own date, but never later than now: a sender's clock can be wrong.
    const sentAt = args.sentAt ?? new Date(Math.min(facts.when.date.getTime(), Date.now()));

    let correspondenceId: string;
    let transitioned: CaseEvent | null = null;

    if (args.mode === 'link') {
      correspondenceId = plan.recordedLetter!.id;
    } else if (args.mode === 'record_sent') {
      // planFor offers record_sent only for a known kind the case can take now.
      const letterKind = kind!;
      const notice = EVENT_FOR_KIND[letterKind] === 'ISSUE_RESPONDENT_NOTICE';
      if (notice && !args.caseRespondentId) {
        throw new DomainError(
          'This letter is a notice to a dentist, so recording it needs to say which dentist it ' +
            'went to. Pick the dentist.',
        );
      }
      // The draft of this letter, when the officer drafted it here and sent it without
      // clicking "I have sent this": the draft IS the letter, and recording it as sent keeps
      // one row, not two. For a notice, only the draft written to the dentist picked: a case
      // with two dentists has a draft for each, and marking Dr A's sent for Dr B's copy
      // would record a notice to Dr A that never went out.
      const dentist = notice ? plan.respondents.find((r) => r.id === args.caseRespondentId) : null;
      if (notice && !dentist) {
        throw new DomainError('That dentist is not named on this case. Reload the page and pick again.');
      }
      const draft = dentist
        ? found.drafts.find(
            (d) => d.kind === letterKind && comparableName(d.toName) === comparableName(dentist.name),
          )
        : found.draft && found.draft.kind === letterKind
          ? found.draft
          : undefined;
      if (draft) {
        correspondenceId = draft.id;
        const to = this.copyRecipientFor(facts.copy, parties, dentist?.name ?? null);
        if (to) {
          await tx.execute(sql`
            UPDATE correspondence SET to_email = coalesce(to_email, ${to.email})
            WHERE council_id = ${ctx.councilId}::uuid AND id = ${draft.id}::uuid
          `);
        }
      } else {
        correspondenceId = await this.insertCopiedLetter(tx, ctx, m, facts.copy, {
          caseFileId: args.caseFileId,
          kind: letterKind,
          sentAt: null,
          direct: facts.direct,
          to: dentist
            ? { name: dentist.name, email: this.copyRecipientFor(facts.copy, parties, dentist.name)?.email ?? null }
            : undefined,
        });
      }
      // Exactly the "I have sent this" click: the step, the reminder, the notice count. A
      // refusal from the lifecycle rolls the whole filing back.
      const sent = await this.correspondence.markSent(tx, ctx, {
        correspondenceId,
        sentAt,
        serviceMode: 'email',
        caseRespondentId: args.caseRespondentId ?? null,
      });
      transitioned = sent.transitioned;
    } else {
      // Put on the case as a letter sent, moving nothing. A draft of this very letter -
      // written to this recipient, or the only one of its kind - is closed off as it rather
      // than left beside it: left, its "I have sent this" would later record the same
      // letter a second time.
      const recordKind = kind ?? 'other';
      const sameKind = found.drafts.filter((d) => d.kind === recordKind && d.addressed !== 'no');
      const draft =
        sameKind.find((d) => d.addressed === 'yes') ?? (sameKind.length === 1 ? sameKind[0] : undefined);
      if (draft) {
        correspondenceId = draft.id;
        const to = this.copyRecipientFor(facts.copy, parties, draft.toName);
        await tx.execute(sql`
          UPDATE correspondence
          SET sent_at = ${sentAt}, to_email = coalesce(to_email, ${to?.email ?? null})
          WHERE council_id = ${ctx.councilId}::uuid AND id = ${draft.id}::uuid AND sent_at IS NULL
        `);
      } else {
        correspondenceId = await this.insertCopiedLetter(tx, ctx, m, facts.copy, {
          caseFileId: args.caseFileId,
          kind: recordKind,
          sentAt,
          direct: facts.direct,
        });
      }
    }

    await tx.execute(sql`
      UPDATE mail_message
      SET status = 'filed', case_file_id = ${args.caseFileId}::uuid,
          correspondence_id = ${correspondenceId}::uuid,
          matched_rung = ${args.rung ?? 'officer'}::mail_match_rung,
          filed_at = now(), filed_by = ${ctx.userId ?? null}
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${m.id}::uuid
    `);

    const documentsFiled = await this.fileAttachments(tx, ctx, m.id, args.caseFileId, {
      skipCaseDuplicates: true,
    });
    await this.tellAssistant(tx, ctx, m.id, {
      action: 'filed_on_case',
      caseFileId: args.caseFileId,
      asCouncilCopy: true,
    });
    return { filedAs: args.mode, correspondenceId, transitioned, documentsFiled };
  }

  /**
   * Which of the copy's recipients a letter recorded from it was written to.
   *
   * For a letter to a named person (a dentist's notice), the recipient on file as that
   * person; failing that, the first recipient who is not on file as somebody ELSE on the
   * case - never one person's address against another person's name. Without a name, the
   * first recipient.
   */
  private copyRecipientFor(
    copy: CouncilCopy | null,
    parties: Awaited<ReturnType<typeof partiesOnCase>>,
    toName: string | null,
  ): CouncilCopyRecipient | null {
    const recipients = copy?.recipients ?? [];
    if (!toName) return recipients[0] ?? null;
    const name = comparableName(toName);
    const theirs = parties.filter((p) => comparableName(p.name) === name).map((p) => p.email);
    return (
      recipients.find((r) => theirs.includes(r.email) || comparableName(r.name) === name) ??
      recipients.find((r) => !parties.some((p) => p.email === r.email && comparableName(p.name) !== name)) ??
      null
    );
  }

  /**
   * The mail filed on a case, for its page: what is the complaint, and what is a copy of
   * a letter the Council sent.
   *
   * Complaints and replies first, oldest first - so the first row is the complaint itself,
   * in the complainant's own words - and copies of the Council's letters after them,
   * marked. Without the mark, a copy filed on a case opened by hand from a paper letter was
   * the oldest mail on it, and the case page printed the Council's own letter under "the
   * complaint".
   */
  async mailForCase(
    tx: Tx,
    ctx: EngineContext,
    caseFileId: string,
  ): Promise<Array<Record<string, unknown> & { id: string; council_copy: boolean }>> {
    const rows = await tx.execute<Record<string, unknown> & { id: string; council_copy: boolean }>(sql`
      SELECT m.id, m.subject, m.original_subject, m.original_from, m.original_from_name,
             m.envelope_from, m.envelope_from_name, m.envelope_date, m.original_date_text,
             coalesce(m.original_body, m.body_text) AS body, m.forward_kind, m.matched_rung,
             coalesce(co.direction = 'out'::contact_direction, false) AS council_copy
      FROM mail_message m
      LEFT JOIN correspondence co
        ON co.id = m.correspondence_id AND co.council_id = ${ctx.councilId}::uuid
      WHERE m.council_id = ${ctx.councilId}::uuid AND m.case_file_id = ${caseFileId}::uuid
      ORDER BY coalesce(co.direction = 'out'::contact_direction, false),
               coalesce(m.original_date, m.envelope_date)
    `);
    return rows.rows;
  }

  /** What a stored message tells about itself as a copy of a Council letter. */
  private async copyFacts(
    tx: Tx,
    ctx: EngineContext,
    m: NonNullable<Awaited<ReturnType<MailIntakeService['find']>>>,
  ) {
    const own = await this.ownAddresses(tx, ctx, m.mailbox);
    const copy = this.copyOf(m, own);
    // The message that arrived IS the letter - sent with the intake mailbox in Cc or Bcc,
    // even when it forwards something on (writtenByCouncilTo): its own subject, words and
    // date are the letter's, not those of whatever it forwards.
    const direct = copy !== null && writtenByCouncilTo(m, own) !== null;
    const templates = await this.templatesOf(tx, ctx);
    const letterSubject = direct ? m.subject : (m.original_subject ?? m.subject);
    // Every kind the subject could be (two templates can share one); planFor chooses
    // between them by who the copy went to, once it knows the case.
    const fromOriginal = inferLetterKinds(letterSubject, templates);
    const kinds = fromOriginal.length ? fromOriginal : inferLetterKinds(m.subject, templates);
    return { copy, direct, templates, kinds, letterSubject, when: copyWhenOf(m, direct) };
  }

  /**
   * The council's letters as they are now: the current published version of each template,
   * read as CorrespondenceService.draft reads it, so a subject the officer has reworded is
   * recognised in its new words.
   */
  private async templatesOf(
    tx: Tx,
    ctx: EngineContext,
  ): Promise<Array<{ kind: CorrespondenceKind; name: string; subjectTpl: string }>> {
    const rows = await tx.execute<{ kind: CorrespondenceKind; name: string; subject_tpl: string }>(sql`
      SELECT t.kind::text AS kind, t.name, v.subject_tpl
      FROM template t
      JOIN template_version v ON v.id = t.current_version_id
      WHERE t.council_id = ${ctx.councilId}::uuid
      ORDER BY t.created_at, t.kind
    `);
    return rows.rows.map((r) => ({ kind: r.kind, name: r.name, subjectTpl: r.subject_tpl }));
  }

  /**
   * The letter a copy shows, written onto the case as one the Council sent: to whom the
   * copy says, in the words the copy carries. No template version and no merge context - it
   * was not drafted here, and claiming a template produced it would be a record of
   * something that did not happen.
   */
  private async insertCopiedLetter(
    tx: Tx,
    ctx: EngineContext,
    m: NonNullable<Awaited<ReturnType<MailIntakeService['find']>>>,
    copy: CouncilCopy | null,
    args: {
      caseFileId: string;
      kind: CorrespondenceKind;
      sentAt: Date | null;
      /** Whom it was written to, when that is known better than "the first recipient". */
      to?: { name: string | null; email: string | null };
      /** The message itself is the letter (copyFacts' `direct`), not what it forwards. */
      direct?: boolean;
    },
  ): Promise<string> {
    const to = args.to ?? copy?.recipients[0] ?? null;
    const ownSubject = m.subject.replace(/^\s*(?:(?:fwd?|fw)\s*:\s*)+/i, '').trim();
    const subject = args.direct ? ownSubject : (m.original_subject ?? ownSubject);
    const body = args.direct ? (m.body_text ?? m.original_body ?? '') : (m.original_body ?? m.body_text ?? '');
    const row = await tx.execute<{ id: string }>(sql`
      INSERT INTO correspondence (council_id, case_file_id, kind, direction, to_name, to_email,
                                  subject, body, template_version_id, merge_context, sent_at,
                                  created_by)
      VALUES (${ctx.councilId}::uuid, ${args.caseFileId}::uuid,
              ${args.kind}::correspondence_kind, 'out'::contact_direction,
              ${noNul(to?.name ?? null)}, ${noNul(to?.email ?? null)},
              ${noNul(subject || '(no subject)')}, ${noNul(body)},
              NULL, NULL, ${args.sentAt}, ${ctx.userId ?? null})
      RETURNING id
    `);
    return row.rows[0]!.id;
  }

  /** "Case X has already moved past this step (documents asked for on 9 Oct) ..." */
  private async pastThisStep(
    tx: Tx,
    ctx: EngineContext,
    caseFileId: string,
    caseNumber: string,
    event: CaseEvent,
  ): Promise<{ explanation: string; stepTaken: string | null }> {
    const milestone = [...(transitionFor(event).milestones ?? [])].pop();
    const said = milestone ? MILESTONE_SAID[milestone] : undefined;
    let when: Date | null = null;
    if (milestone) {
      const rows = await tx.execute<{ occurred_at: Date | string }>(sql`
        SELECT occurred_at FROM case_milestone
        WHERE council_id = ${ctx.councilId}::uuid AND case_file_id = ${caseFileId}::uuid
          AND milestone = ${milestone}
        ORDER BY occurred_at DESC LIMIT 1
      `);
      const at = rows.rows[0]?.occurred_at;
      when = at ? (at instanceof Date ? at : new Date(at)) : null;
    }
    const stepTaken = when && said ? `${said} on ${this.onDay(ctx, when)}` : null;
    return {
      explanation: stepTaken
        ? `${caseNumber} has already moved past this step (${stepTaken}), so it is not recorded ` +
          'again. The copy can be put on the case as a letter sent.'
        : `${caseNumber} is not at the step this letter belongs to, so it is not recorded as that ` +
          'step. The copy can be put on the case as a letter sent.',
      stepTaken,
    };
  }

  /** What recording a letter as sent will do, from the transition table and the council's rules. */
  private effectOf(ctx: EngineContext, event: CaseEvent): string {
    const stage = transitionFor(event).opens?.[0];
    const rule = stage ? ctx.config.followupRules.find((r) => r.stage === stage) : undefined;
    const due = rule
      ? `, due in ${rule.dueInDays} ${rule.basis === 'working_days' ? 'working ' : ''}days`
      : '';
    const waitingFor = stage ? (WAITING_FOR[stage] ?? 'the reply') : null;
    if (event === 'ISSUE_RESPONDENT_NOTICE') {
      return (
        'This counts as the next notice to the dentist you pick, sent by email' +
        (waitingFor ? `, and starts the reminder for ${waitingFor}${due}.` : '.')
      );
    }
    return waitingFor
      ? `This records the step on the case and starts the reminder for ${waitingFor}${due}.`
      : 'This records the step on the case.';
  }

  /** "10 Oct", in the council's own calendar. */
  private onDay(ctx: EngineContext, d: Date): string {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: ctx.config.calendar.timezone,
      day: 'numeric',
      month: 'short',
    }).format(d);
  }

  // ─── Reading ───────────────────────────────────────────────────────────────

  /** The tray. Unfiled first and newest first; there are never many. */
  async tray(
    tx: Tx,
    ctx: EngineContext,
    status: MailStatus = 'unfiled',
  ): Promise<TrayRow[]> {
    // The suggestion was stored at ingest, and the case it names may have been cancelled
    // as opened in error since. Such a case is not offered - the join below drops it - and
    // nor is the note that came with it, which describes a suggestion no longer being made.
    // The message page re-runs the matcher live and needs none of this.
    //
    // A message sent back from a case cancelled as opened in error says so instead, on the
    // card: without it the officer would meet a message they had already dealt with, back
    // in the tray with no explanation. See mail/cancelled-case. Only while it is unfiled -
    // one set aside since has been dealt with, and its own reason says how.
    const rows = await tx.execute<
      Omit<TrayRow, 'complainant' | 'councilCopy'> & {
        mailbox: string | null;
        returned_from: string | null;
        returned_reason: string | null;
        original_to: string | null;
        envelope_to: string | null;
        not_council_copy_at: Date | null;
      }
    >(sql`
      SELECT m.id, m.subject, m.snippet, m.envelope_from, m.envelope_from_name,
             m.envelope_date, m.ingested_at, m.forward_kind, m.mailbox,
             m.original_from, m.original_from_name, m.original_subject, m.original_date_text,
             m.original_to, m.envelope_to, m.not_council_copy_at,
             m.status, m.sender_check, m.dismissed_reason,
             CASE WHEN m.suggested_case_file_id IS NOT NULL AND sc.id IS NULL THEN NULL
                  ELSE m.suggestion_note END AS suggestion_note,
             sc.id AS suggested_case_file_id,
             sc.case_number AS suggested_case_number,
             CASE WHEN m.status = 'unfiled' THEN pc.case_number END AS returned_from,
             CASE WHEN m.status = 'unfiled' THEN pc.deletion_reason END AS returned_reason,
             (SELECT count(*)::int FROM mail_attachment a
               WHERE a.mail_message_id = m.id AND a.staging_key IS NOT NULL) AS attachment_count,
             (SELECT count(*)::int FROM mail_attachment a
               WHERE a.mail_message_id = m.id AND a.skipped_reason IS NOT NULL
                 AND a.document_id IS NULL
                 AND a.skipped_reason <> ${SIGNATURE_LOGO_REASON}) AS skipped_count
      FROM mail_message m
      LEFT JOIN case_file sc ON sc.id = m.suggested_case_file_id AND sc.deleted_at IS NULL
      LEFT JOIN case_file pc ON pc.id = m.case_file_id AND pc.deleted_at IS NOT NULL
      WHERE m.council_id = ${ctx.councilId}::uuid AND m.status = ${status}::mail_status
      ORDER BY m.ingested_at DESC
      LIMIT 200
    `);
    const council = await this.councilAddresses(tx, ctx);
    return rows.rows.map(
      ({ mailbox, returned_from, returned_reason, original_to, envelope_to, not_council_copy_at, ...row }) => {
        const own = ownAddressesOf({ ...council, intakeAccount: intakeAccountOf(mailbox) });
        return {
          ...row,
          suggestion_note: returned_from
            ? returnedToTrayNote(returned_from, returned_reason)
            : row.suggestion_note,
          complainant: suggestedComplainant(row, own),
          // With the same addresses as the complainant, so the card can never call a message
          // both "from the complainant" and "a copy of our letter".
          councilCopy: this.copyOf({ ...row, original_to, envelope_to, not_council_copy_at }, own),
        };
      },
    );
  }

  /** One message, with everything the detail screen shows. */
  async get(
    tx: Tx,
    ctx: EngineContext,
    id: string,
  ): Promise<{
    message: Record<string, unknown>;
    attachments: MailAttachmentRow[];
    candidates: MatchCandidate[];
  } | null> {
    const m = await this.find(tx, ctx, id);
    if (!m) return null;

    const attachments = await tx.execute<MailAttachmentRow>(sql`
      SELECT a.id, a.filename, a.declared_type, a.size_bytes, a.sha256, a.document_id,
             d.status::text AS document_status, a.skipped_reason
      FROM mail_attachment a
      LEFT JOIN document d ON d.id = a.document_id
      WHERE a.mail_message_id = ${id}::uuid ORDER BY a.created_at
    `);

    // Re-run live rather than reading what was suggested at ingest: a case opened since
    // then should be offered, and a case closed since then should say so.
    const council = await tx.execute<{ code: string }>(
      sql`SELECT code FROM council WHERE id = ${ctx.councilId}::uuid`,
    );
    const own = await this.ownAddresses(tx, ctx, m.mailbox);
    const detected = this.copyOf(m, own);
    // With when the letter went out by the copy's own account, so the page never has to
    // work that out again and never shows the forward's arrival as the sending.
    const when = copyWhenOf(m, detected !== null && writtenByCouncilTo(m, own) !== null);
    const councilCopy = detected
      ? { ...detected, copyDate: when.date, copyDateBasis: when.basis }
      : null;
    const searched = {
      subject: [m.subject, m.original_subject ?? ''].join('\n'),
      body: [m.body_text ?? '', m.original_body ?? ''].join('\n'),
    };
    // A copy of a Council letter is matched by the person it was sent to, not by its
    // sender, which is the Council (see matchCouncilCopy).
    const match = councilCopy
      ? await matchCouncilCopy(tx, ctx, council.rows[0]?.code ?? '', {
          ...searched,
          recipients: councilCopy.recipients.map((r) => r.email),
        })
      : await matchMessage(tx, ctx, council.rows[0]?.code ?? '', {
          ...searched,
          // As at ingest: never the Council's own addresses.
          senderAddresses: [m.original_from, m.envelope_from].filter(
            (a): a is string => Boolean(a) && !isOwnAddress(a, own),
          ),
        });

    const complainant = suggestedComplainant(m, own);
    return {
      message: { ...m, complainant, councilCopy } as unknown as Record<string, unknown>,
      attachments: attachments.rows,
      candidates: match.candidates,
    };
  }

  /**
   * Where the reader had got to, derived from the tray rather than stored beside it.
   *
   * There is no cursor table and there should not be one: the messages ARE the cursor.
   * A separate high-water mark is a second thing to keep in step, and the failure mode
   * when it drifts ahead is silent — mail arrives, the cursor says it was already seen,
   * and a complaint is never ingested at all. Taking max(uid) from what was actually
   * written cannot drift, and a message that failed to ingest is simply retried.
   */
  async cursorFor(
    tx: Tx,
    ctx: EngineContext,
    mailbox: string,
  ): Promise<{ uid: number; uidValidity: string } | null> {
    const rows = await tx.execute<{ uid: number | null; uid_validity: string | null }>(sql`
      SELECT max(uid) AS uid, max(uid_validity) AS uid_validity
      FROM mail_message
      WHERE council_id = ${ctx.councilId}::uuid AND mailbox = ${mailbox}
        AND uid IS NOT NULL
    `);
    const r = rows.rows[0];
    if (!r?.uid || !r.uid_validity) return null;
    return { uid: Number(r.uid), uidValidity: r.uid_validity };
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────────

  /** Record the message as inbound correspondence on a case and mark it filed. */
  private async attachToCase(
    tx: Tx,
    ctx: EngineContext,
    args: {
      mailMessageId: string;
      caseFileId: string;
      rung: MailMatchRung;
      subject: string;
      body: string;
      fromEmail: string | null;
      receivedAt: Date;
      messageId: string | null;
    },
  ): Promise<void> {
    const correspondenceId = await this.correspondence.recordInbound(tx, ctx, {
      caseFileId: args.caseFileId,
      subject: noNul(args.subject),
      body: noNul(args.body),
      fromEmail: noNul(args.fromEmail),
      receivedAt: args.receivedAt,
    });

    // The Message-ID goes on the letter so a later reply in the same thread can find it.
    // Only if no letter has it already: it is unique per council, and a Message-ID can
    // legitimately repeat (see ingest) - so setting it blindly made filing the second such
    // message fail outright, which for a message filing itself meant never reaching the tray.
    if (args.messageId) {
      const messageId = noNul(args.messageId);
      try {
        // A savepoint as well as the NOT EXISTS: two filings running at once (the reader
        // and the officer's "check now") can both pass the check, and the loser must lose
        // only the thread marker, not the filing.
        await tx.transaction(async (sp) => {
          await sp.execute(sql`
            UPDATE correspondence SET message_id = ${messageId}
            WHERE council_id = ${ctx.councilId}::uuid AND id = ${correspondenceId}::uuid
              AND NOT EXISTS (
                SELECT 1 FROM correspondence other
                WHERE other.council_id = ${ctx.councilId}::uuid AND other.message_id = ${messageId}
              )
          `);
        });
      } catch {
        // Another letter holds this Message-ID. It keeps it; this one files without.
      }
    }

    await tx.execute(sql`
      UPDATE mail_message
      SET status = 'filed', case_file_id = ${args.caseFileId}::uuid,
          correspondence_id = ${correspondenceId}::uuid,
          matched_rung = ${args.rung}::mail_match_rung,
          filed_at = now(), filed_by = ${ctx.userId ?? null}
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.mailMessageId}::uuid
    `);

    // A reply arriving IS the thing the case was waiting for, however it came to be filed.
    // Doing this only on the officer's manual path would mean a reply that filed itself
    // left its own chase open - so the Today screen would keep asking for a document that
    // is already on the file, which is precisely the lie that makes a queue stop being read.
    await this.satisfyWaiting(tx, ctx, args.caseFileId, args.mailMessageId);
  }

  /**
   * Promote each staged attachment to a case document.
   *
   * Each in its own savepoint, so a failure on one takes neither the others nor the filing
   * with it: the message still files, the file that did not make it stays staged and shows
   * on the message page as not yet on the case, and fileHeldAttachments() tries it again on
   * the next sweep. This matters most when a reply files ITSELF - there the whole message
   * used to depend on every one of its attachments reaching the store, and a message that
   * fails to ingest does not reach the tray at all. commit() writes its rows before it moves
   * the file, so a rolled-back savepoint leaves the file where the staging key says it is.
   */
  private async fileAttachments(
    tx: Tx,
    ctx: EngineContext,
    mailMessageId: string,
    caseFileId: string,
    opts: { skipCaseDuplicates?: boolean } = {},
  ): Promise<number> {
    await this.restageFromCancelledCase(tx, ctx, mailMessageId, caseFileId);
    if (opts.skipCaseDuplicates) await this.pointAtCaseDuplicates(tx, ctx, mailMessageId, caseFileId);

    const rows = await tx.execute<{ id: string; filename: string; staging_key: string }>(sql`
      SELECT id, filename, staging_key FROM mail_attachment
      WHERE council_id = ${ctx.councilId}::uuid AND mail_message_id = ${mailMessageId}::uuid
        AND staging_key IS NOT NULL AND document_id IS NULL
      ORDER BY created_at
    `);

    let filed = 0;
    for (const a of rows.rows) {
      try {
        await tx.transaction(async (sp) => {
          const committed = await this.documents.commit(sp, ctx, {
            caseFileId,
            storageKey: a.staging_key,
            title: a.filename,
            originalFilename: a.filename,
            documentClass: 'complaint_material',
          });
          await sp.execute(sql`
            UPDATE mail_attachment SET document_id = ${committed.documentId}::uuid
            WHERE id = ${a.id}::uuid
          `);
        });
        filed++;
      } catch (err) {
        this.log.warn(
          `${a.filename} did not reach the case yet, will retry: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    return filed;
  }

  /**
   * A copy of the Council's letter carries the files the officer attached to it - and the
   * officer attached them from the case, where they already are. Filed again they would
   * be listed twice under "Papers on file", and twice in the committee's bundle.
   *
   * So a staged attachment whose bytes are already a stored document on this case is
   * pointed at that document instead of becoming a second one: on the message page it then
   * reads "On the case file", which is true, and the reason says why no new document was
   * made. Having a document, it is never retried by fileHeldAttachments(); and should this
   * case one day be cancelled and the message filed elsewhere, restageFromCancelledCase()
   * copies that document onward as it would any other.
   *
   * Only for copies. A complainant who sends the same bill twice has sent it twice, and
   * that stays on the record as they sent it.
   */
  private async pointAtCaseDuplicates(
    tx: Tx,
    ctx: EngineContext,
    mailMessageId: string,
    caseFileId: string,
  ): Promise<void> {
    const dups = await tx.execute<{ id: string; document_id: string; title: string }>(sql`
      SELECT DISTINCT ON (a.id) a.id, d.id AS document_id, d.title
      FROM mail_attachment a
      JOIN document_version dv ON dv.sha256 = a.sha256 AND dv.council_id = ${ctx.councilId}::uuid
      JOIN document d ON d.id = dv.document_id AND d.council_id = ${ctx.councilId}::uuid
      WHERE a.council_id = ${ctx.councilId}::uuid AND a.mail_message_id = ${mailMessageId}::uuid
        AND a.staging_key IS NOT NULL AND a.document_id IS NULL
        AND d.case_file_id = ${caseFileId}::uuid AND d.status = 'stored'
      ORDER BY a.id, d.created_at
    `);
    for (const dup of dups.rows) {
      await tx.execute(sql`
        UPDATE mail_attachment
        SET document_id = ${dup.document_id}::uuid,
            skipped_reason = ${noNul(
              `${DUPLICATE_REASON_PREFIX}"${dup.title}" - the same file, attached to the ` +
                "Council's letter from the case. Not filed a second time.",
            )}
        WHERE id = ${dup.id}::uuid
      `);
    }
  }

  /**
   * A message back in the tray from a case cancelled as opened in error, being filed again:
   * its files are already documents - on the cancelled case. Stage a copy of each, so the
   * loop in fileAttachments() files it on the new case exactly as it would a fresh one.
   *
   * This is the duplicate the feature exists for. The complainant's email, with the bills
   * and the OPG, was opened as a second case by mistake; that case is cancelled, and the
   * message is added to the real one. Without this the email would reach the real case and
   * its evidence would not - staying on a case no list leads to, out of the committee's
   * bundle.
   *
   * Copied, not moved. The document on the cancelled case is part of that case's record -
   * the register still lists the case, and its page still shows what it held - so it is
   * left exactly where it is. The copy is the same bytes, and commit() re-hashes them, so
   * the two can be shown to be the same file. The attachment then points at its new
   * document; the old link is in the audit trail.
   *
   * Not a file withdrawn from the cancelled case as misfiled: that was the officer saying
   * it does not belong to this complainant, and a copy would undo it.
   *
   * A file whose copy cannot be made now is left pointing at the cancelled case and said
   * in the log. It is not retried: the original is safe where it is, which is the one
   * thing that must not go wrong here.
   */
  private async restageFromCancelledCase(
    tx: Tx,
    ctx: EngineContext,
    mailMessageId: string,
    caseFileId: string,
  ): Promise<void> {
    const rows = await tx.execute<{
      id: string;
      filename: string;
      storage_key: string;
      mime_type: string;
    }>(sql`
      SELECT a.id, a.filename, dv.storage_key, dv.mime_type
      FROM mail_attachment a
      JOIN document d ON d.id = a.document_id
      JOIN document_version dv ON dv.id = d.current_version_id
      JOIN case_file c ON c.id = d.case_file_id
      WHERE a.council_id = ${ctx.councilId}::uuid AND a.mail_message_id = ${mailMessageId}::uuid
        AND c.deleted_at IS NOT NULL AND d.case_file_id <> ${caseFileId}::uuid
        AND d.status = 'stored'
      ORDER BY a.created_at
    `);

    for (const a of rows.rows) {
      // Only the store is inside the try. A failed SQL statement cannot be caught and
      // carried on from - it aborts the whole transaction - so the row is written after.
      const stagingKey = `${STAGING_PREFIX}${randomUUID()}`;
      try {
        const bytes = await this.storage.read(a.storage_key);
        await this.storage.write(stagingKey, bytes, a.mime_type);
      } catch (err) {
        this.log.warn(
          `${a.filename} could not be copied from the cancelled case, and stays there: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        continue;
      }
      // From here it is an ordinary held file: if commit() then fails, the reader retries
      // it from this staged copy like any other (fileHeldAttachments).
      await tx.execute(sql`
        UPDATE mail_attachment
        SET staging_key = ${stagingKey}, document_id = NULL,
            skipped_reason = CASE WHEN skipped_reason LIKE ${DUPLICATE_REASON_PREFIX + '%'}
                                  THEN NULL ELSE skipped_reason END
        WHERE id = ${a.id}::uuid
      `);
    }
  }

  /**
   * Try again: attachments of messages already on a case that did not reach it.
   *
   * Called by every sweep. Normally there are none; after a moment when the file store did
   * not answer, this is what puts the complainant's bills on the case without anybody
   * having to notice they were missing.
   */
  async fileHeldAttachments(tx: Tx, ctx: EngineContext): Promise<number> {
    // Newest first, so a file that can never be moved (its staged copy gone) cannot hold
    // the front of the queue and starve the ones that can.
    //
    // Not onto a cancelled case: documents.commit() refuses one, so retrying would fail
    // every ten minutes for ever and fill the log with it. Cancelling sends the case's mail
    // back to the tray, so status = 'filed' already leaves such messages out; the join is
    // the second line, not the first. Either way the files stay staged: they go with the
    // message to whichever case it is added to, or back onto this one if it is restored.
    const held = await tx.execute<{ mail_message_id: string; case_file_id: string }>(sql`
      SELECT m.id AS mail_message_id, m.case_file_id
      FROM mail_message m
      JOIN mail_attachment a ON a.mail_message_id = m.id
      JOIN case_file c ON c.id = m.case_file_id AND c.deleted_at IS NULL
      WHERE m.council_id = ${ctx.councilId}::uuid AND m.status = 'filed'
        AND a.staging_key IS NOT NULL AND a.document_id IS NULL
      GROUP BY m.id, m.case_file_id
      ORDER BY max(a.created_at) DESC
      LIMIT 20
    `);
    let filed = 0;
    const now = Date.now();
    for (const h of held.rows) {
      // At most every ten minutes per message, not on every thirty-second sweep: a file
      // that keeps failing should be retried, not fill the log.
      const last = this.heldRetries.get(h.mail_message_id);
      if (last !== undefined && now - last < 10 * 60_000) continue;
      this.heldRetries.set(h.mail_message_id, now);
      filed += await this.fileAttachments(tx, ctx, h.mail_message_id, h.case_file_id);
    }
    return filed;
  }

  /** When each message's held files were last retried. In memory: a restart just retries. */
  private readonly heldRetries = new Map<string, number>();

  /**
   * A reply arriving is the thing the case was waiting for.
   *
   * Only the stages that are genuinely answered by inbound mail. Closing an
   * `await_despatch_entry` because a complainant wrote in would be wrong, and worse than
   * wrong: it would clear a reminder that nothing had actually satisfied.
   */
  private async satisfyWaiting(
    tx: Tx,
    ctx: EngineContext,
    caseFileId: string,
    mailMessageId: string,
  ): Promise<number> {
    const live = await this.followups.liveForCase(tx, ctx, caseFileId);
    const answerable = live.filter((f) => ANSWERED_BY_A_REPLY.includes(f.stage as FollowupStage));
    for (const f of answerable) {
      await this.followups.satisfy(tx, ctx, {
        followUpId: f.id,
        // NOT contactEventId: that column is a foreign key to contact_event, and passing a
        // correspondence id there raises a constraint violation and rolls the whole
        // filing back.
        note: `Answered by mail filed from the tray (${mailMessageId}).`,
      });
    }
    return answerable.length;
  }

  private async find(tx: Tx, ctx: EngineContext, id: string) {
    const rows = await tx.execute<{
      id: string;
      subject: string;
      body_text: string | null;
      body_html: string | null;
      snippet: string;
      message_id: string | null;
      envelope_from: string;
      envelope_from_name: string | null;
      envelope_to: string | null;
      envelope_date: Date;
      ingested_at: Date;
      forward_kind: MailForwardKind;
      original_from: string | null;
      original_from_name: string | null;
      original_to: string | null;
      original_subject: string | null;
      original_date: Date | null;
      original_date_text: string | null;
      original_body: string | null;
      status: MailStatus;
      matched_rung: MailMatchRung | null;
      case_file_id: string | null;
      case_number: string | null;
      // Set when the case the message is (or was) on has been cancelled as opened in
      // error. The message page says so rather than showing a green "Filed" over a case
      // nobody can reach from a list. See mail/cancelled-case.
      case_deleted_at: Date | null;
      case_deletion_reason: string | null;
      suggestion_note: string | null;
      dismissed_reason: string | null;
      mailbox: string | null;
      /** The officer said it is not a copy of the Council's letter (see copyOf). */
      not_council_copy_at: Date | null;
      /** Who sent it, against the council's list (sender-check.ts). Null: no list. */
      sender_check: MailSenderCheck | null;
    }>(sql`
      SELECT m.id, m.subject, m.body_text, m.body_html, m.snippet, m.message_id,
             m.envelope_from, m.envelope_from_name, m.envelope_to, m.envelope_date,
             m.ingested_at, m.forward_kind, m.original_from, m.original_from_name,
             m.original_to, m.original_subject, m.original_date, m.original_date_text,
             m.original_body, m.status, m.matched_rung, m.case_file_id,
             c.case_number, c.deleted_at AS case_deleted_at,
             c.deletion_reason AS case_deletion_reason,
             m.suggestion_note, m.dismissed_reason, m.mailbox, m.not_council_copy_at,
             m.sender_check
      FROM mail_message m
      LEFT JOIN case_file c ON c.id = m.case_file_id
      WHERE m.council_id = ${ctx.councilId}::uuid AND m.id = ${id}::uuid
    `);
    return rows.rows[0] ?? null;
  }

  private async councilAddresses(
    tx: Tx,
    ctx: EngineContext,
  ): Promise<{ officialEmail: string | null; website: string | null }> {
    const rows = await tx.execute<{ official_email: string | null; website: string | null }>(sql`
      SELECT official_email, website FROM council WHERE id = ${ctx.councilId}::uuid
    `);
    const r = rows.rows[0];
    return { officialEmail: r?.official_email ?? null, website: r?.website ?? null };
  }

  private async ownAddresses(
    tx: Tx,
    ctx: EngineContext,
    mailbox: string | null,
  ): Promise<OwnAddresses> {
    const council = await this.councilAddresses(tx, ctx);
    return ownAddressesOf({ ...council, intakeAccount: intakeAccountOf(mailbox) });
  }

  /**
   * Is this stored message a copy of a Council letter? councilCopyOf(), unless the officer
   * has said it is not one (not_council_copy_at, set by the "it is a reply" and "it is a
   * complaint" overrides): that answer is kept, so the page stops calling the message the
   * Council's letter, and a message sent back to the tray by a cancelled case is not taken
   * for a copy all over again.
   */
  private copyOf(
    m: Parameters<typeof councilCopyOf>[0] & { not_council_copy_at?: Date | string | null },
    own: OwnAddresses,
  ): CouncilCopy | null {
    return m.not_council_copy_at ? null : councilCopyOf(m, own);
  }

  /** Keep the officer's word that this message is not a copy of the Council's letter. */
  private async markNotACopy(tx: Tx, ctx: EngineContext, mailMessageId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE mail_message SET not_council_copy_at = coalesce(not_council_copy_at, now())
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${mailMessageId}::uuid
    `);
  }

  private async mustFind(tx: Tx, ctx: EngineContext, id: string) {
    const m = await this.find(tx, ctx, id);
    if (!m) throw new DomainError('That message is not in the tray.');
    return m;
  }
}
