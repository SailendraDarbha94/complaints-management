import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Attachment, ParsedMail } from 'mailparser';
import type { Tx } from '@ksdc/db';
import type { IntakeSource, MailForwardKind, MailMatchRung, MailStatus } from '@ksdc/contracts';
import { ConflictError, DomainError } from '../../common/domain-error.js';
import { Logger } from '../../common/logger.js';
import type { EngineContext } from '../followups/followup.service.js';
import type { FollowupService } from '../followups/followup.service.js';
import type { CaseIntakeService } from '../cases/case-intake.service.js';
import type { CorrespondenceService } from '../correspondence/correspondence.service.js';
import type { DocumentsService } from '../documents/documents.service.js';
import { STAGING_PREFIX, sniff, MAX_UPLOAD_BYTES } from '../documents/storage.js';
import type { StoragePort } from '../documents/storage.js';
import { pgTextArray } from '../../common/pg-array.js';
import { assertCaseLive, CaseCancelledError } from '../cases/case-guard.js';
import { returnedToTrayNote } from './cancelled-case.js';
import { snippetOf, unwrapForward } from './forwarded.js';
import { parseMessage } from './parse.js';
import { imageSize } from './image-size.js';
import { matchMessage, type MatchCandidate } from './matching.js';
import {
  intakeAccountOf,
  ownAddressesOf,
  suggestedComplainant,
  type OwnAddresses,
  type SuggestedComplainant,
} from './complainant.js';

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

/** How deep to open emails attached inside emails. Real forwards nest one or two levels. */
const MAX_EMBED_DEPTH = 3;

/** The fixed identity every automatic write is attributed to. Created in migration 0013. */
export const MAIL_ROBOT_USER_ID = '00000000-0000-4000-8000-000000000001';

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

export class MailIntakeService {
  private readonly log = new Logger('mail');

  constructor(
    private readonly storage: StoragePort,
    private readonly intake: CaseIntakeService,
    private readonly correspondence: CorrespondenceService,
    private readonly documents: DocumentsService,
    private readonly followups: FollowupService,
  ) {}

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

    const seen = await tx.execute<{ id: string; status: MailStatus }>(sql`
      SELECT id, status FROM mail_message
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
      };
    }

    const original = await unwrapForward(parsed);
    const envelope = parsed.from?.value?.[0];
    const bodyText = parsed.text ?? '';
    // The card should show the complainant's words, not the officer's covering note.
    const snippet = snippetOf(original.body ?? bodyText);

    const council = await tx.execute<{ code: string }>(
      sql`SELECT code FROM council WHERE id = ${ctx.councilId}::uuid`,
    );
    const councilCode = council.rows[0]?.code ?? '';

    // Both the forwarder and the original sender are offered to the matcher. The forwarder
    // is usually the officer and will match nothing, which is harmless; the original is
    // the one that can find a case.
    const match = await matchMessage(tx, ctx, councilCode, {
      subject: [parsed.subject ?? '', original.subject ?? ''].join('\n'),
      body: [bodyText, original.body ?? ''].join('\n'),
      senderAddresses: [original.fromAddress, envelope?.address ?? null].filter(
        (a): a is string => Boolean(a),
      ),
    });

    const id = randomUUID();
    await tx.execute(sql`
      INSERT INTO mail_message (
        id, council_id, gm_msg_id, message_id, raw_sha256, mailbox, uid, uid_validity,
        envelope_from, envelope_from_name, envelope_to, envelope_date, subject,
        in_reply_to, reference_ids, body_text, body_html, snippet,
        forward_kind, original_from, original_from_name, original_to, original_subject,
        original_date, original_date_text, original_body,
        suggested_case_file_id, suggestion_note, created_by
      ) VALUES (
        ${id}::uuid, ${ctx.councilId}::uuid, ${meta.gmMsgId ?? null},
        ${noNul(parsed.messageId ?? null)}, ${rawSha256}, ${meta.mailbox},
        ${meta.uid ?? null}, ${meta.uidValidity ?? null},
        ${noNul(envelope?.address?.toLowerCase() ?? 'unknown')}, ${noNul(envelope?.name || null)},
        ${noNul(parsed.to && 'text' in parsed.to ? parsed.to.text : null)},
        ${parsed.date ?? new Date()}, ${noNul(parsed.subject ?? '(no subject)')},
        ${noNul(parsed.inReplyTo ?? null)},
        ${pgTextArray(([] as string[]).concat(parsed.references ?? []).map(noNul))}::text[],
        ${noNul(bodyText || null)}, ${noNul(parsed.html || null)}, ${noNul(snippet)},
        ${original.kind}::mail_forward_kind, ${noNul(original.fromAddress)},
        ${noNul(original.fromName)}, ${noNul(original.to)}, ${noNul(original.subject)},
        ${original.date}, ${noNul(original.dateText)}, ${noNul(original.body)},
        ${match.candidates[0]?.caseFileId ?? null}::uuid, ${noNul(match.note)}, ${ctx.userId ?? null}
      )
    `);

    const stored = await this.stageAttachments(tx, ctx, id, parsed);

    // The mailbox provider writing to its own account holder. Set aside with a reason rather
    // than left in the tray - see ACCOUNT_NOTICE_SENDERS.
    if (envelope?.address && ACCOUNT_NOTICE_SENDERS.has(envelope.address.toLowerCase())) {
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
    let autoFile = match.autoFile;
    if (autoFile) {
      try {
        await assertCaseLive(tx, ctx, autoFile.caseFileId);
      } catch (err) {
        if (!(err instanceof CaseCancelledError)) throw err;
        autoFile = null;
      }
    }
    let autoFiledTo: string | null = null;
    if (autoFile) {
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
        (autoFiledTo ? ' -> auto-filed' : ' -> tray'),
    );

    return {
      mailMessageId: id,
      status: autoFiledTo ? 'filed' : 'unfiled',
      duplicate: false,
      autoFiledTo,
      note: match.note,
      attachmentsStored: stored.stored,
      attachmentsSkipped: stored.skipped,
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
        ${'This message could not be read automatically. Open it in the mailbox.'},
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
    const suggested = suggestedComplainant(m, await this.ownAddresses(tx, ctx, m.mailbox));
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
      body: m.original_body ?? m.body_text ?? '',
      fromEmail: m.original_from ?? m.envelope_from,
      receivedAt,
      messageId: m.message_id,
    });

    const documentsFiled = await this.fileAttachments(tx, ctx, m.id, created.caseFileId);
    return { ...created, documentsFiled };
  }

  /** File a message onto a case that already exists. */
  async fileOnCase(
    tx: Tx,
    ctx: EngineContext,
    args: { mailMessageId: string; caseFileId: string },
  ): Promise<{ documentsFiled: number }> {
    const m = await this.mustFind(tx, ctx, args.mailMessageId);
    if (m.status === 'filed') throw new ConflictError('That message is already on a case.');
    // The picker no longer offers a cancelled case, but a tab opened before the case was
    // cancelled still does. Filing onto it would put the message - and its attachments -
    // on a case no list leads to, and take the message out of the tray where it was
    // visible. See case-guard.
    await assertCaseLive(tx, ctx, args.caseFileId);

    await this.attachToCase(tx, ctx, {
      mailMessageId: m.id,
      caseFileId: args.caseFileId,
      rung: 'officer',
      subject: m.subject,
      body: m.original_body ?? m.body_text ?? '',
      fromEmail: m.original_from ?? m.envelope_from,
      receivedAt: asDate(m.original_date ?? m.envelope_date),
      messageId: m.message_id,
    });

    const documentsFiled = await this.fileAttachments(tx, ctx, m.id, args.caseFileId);
    return { documentsFiled };
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
      Omit<TrayRow, 'complainant'> & {
        mailbox: string | null;
        returned_from: string | null;
        returned_reason: string | null;
      }
    >(sql`
      SELECT m.id, m.subject, m.snippet, m.envelope_from, m.envelope_from_name,
             m.envelope_date, m.ingested_at, m.forward_kind, m.mailbox,
             m.original_from, m.original_from_name, m.original_subject, m.original_date_text,
             m.status,
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
                 AND a.skipped_reason <> ${SIGNATURE_LOGO_REASON}) AS skipped_count
      FROM mail_message m
      LEFT JOIN case_file sc ON sc.id = m.suggested_case_file_id AND sc.deleted_at IS NULL
      LEFT JOIN case_file pc ON pc.id = m.case_file_id AND pc.deleted_at IS NOT NULL
      WHERE m.council_id = ${ctx.councilId}::uuid AND m.status = ${status}::mail_status
      ORDER BY m.ingested_at DESC
      LIMIT 200
    `);
    const council = await this.councilAddresses(tx, ctx);
    return rows.rows.map(({ mailbox, returned_from, returned_reason, ...row }) => ({
      ...row,
      suggestion_note: returned_from
        ? returnedToTrayNote(returned_from, returned_reason)
        : row.suggestion_note,
      complainant: suggestedComplainant(
        row,
        ownAddressesOf({ ...council, intakeAccount: intakeAccountOf(mailbox) }),
      ),
    }));
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
    const match = await matchMessage(tx, ctx, council.rows[0]?.code ?? '', {
      subject: [m.subject, m.original_subject ?? ''].join('\n'),
      body: [m.body_text ?? '', m.original_body ?? ''].join('\n'),
      senderAddresses: [m.original_from, m.envelope_from].filter((a): a is string => Boolean(a)),
    });

    const complainant = suggestedComplainant(m, await this.ownAddresses(tx, ctx, m.mailbox));
    return {
      message: { ...m, complainant } as unknown as Record<string, unknown>,
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
  ): Promise<number> {
    await this.restageFromCancelledCase(tx, ctx, mailMessageId, caseFileId);

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
        UPDATE mail_attachment SET staging_key = ${stagingKey}, document_id = NULL
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
    const answerable = live.filter((f) =>
      (['await_patient_docs', 'await_respondent_explanation', 'await_ev_explanation'] as const).includes(
        f.stage as 'await_patient_docs',
      ),
    );
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
    }>(sql`
      SELECT m.id, m.subject, m.body_text, m.body_html, m.snippet, m.message_id,
             m.envelope_from, m.envelope_from_name, m.envelope_to, m.envelope_date,
             m.ingested_at, m.forward_kind, m.original_from, m.original_from_name,
             m.original_to, m.original_subject, m.original_date, m.original_date_text,
             m.original_body, m.status, m.matched_rung, m.case_file_id,
             c.case_number, c.deleted_at AS case_deleted_at,
             c.deletion_reason AS case_deletion_reason,
             m.suggestion_note, m.dismissed_reason, m.mailbox
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

  private async mustFind(tx: Tx, ctx: EngineContext, id: string) {
    const m = await this.find(tx, ctx, id);
    if (!m) throw new DomainError('That message is not in the tray.');
    return m;
  }
}
