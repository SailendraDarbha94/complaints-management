import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ParsedMail } from 'mailparser';
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
import { snippetOf, unwrapForward } from './forwarded.js';
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
  'noreply@google.com',
  'mail-noreply@google.com',
]);

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
        ${parsed.messageId ?? null}, ${rawSha256}, ${meta.mailbox},
        ${meta.uid ?? null}, ${meta.uidValidity ?? null},
        ${envelope?.address?.toLowerCase() ?? 'unknown'}, ${envelope?.name || null},
        ${parsed.to && 'text' in parsed.to ? parsed.to.text : null},
        ${parsed.date ?? new Date()}, ${parsed.subject ?? '(no subject)'},
        ${parsed.inReplyTo ?? null},
        ${pgTextArray(([] as string[]).concat(parsed.references ?? []))}::text[],
        ${bodyText || null}, ${parsed.html || null}, ${snippet},
        ${original.kind}::mail_forward_kind, ${original.fromAddress}, ${original.fromName},
        ${original.to}, ${original.subject}, ${original.date}, ${original.dateText},
        ${original.body},
        ${match.candidates[0]?.caseFileId ?? null}::uuid, ${match.note}, ${ctx.userId ?? null}
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
    let autoFiledTo: string | null = null;
    if (match.autoFile) {
      await this.attachToCase(tx, ctx, {
        mailMessageId: id,
        caseFileId: match.autoFile.caseFileId,
        rung: match.autoFile.rung,
        subject: parsed.subject ?? '(no subject)',
        body: original.body ?? bodyText,
        fromEmail: original.fromAddress ?? envelope?.address ?? null,
        receivedAt: parsed.date ?? new Date(),
        messageId: parsed.messageId ?? null,
      });
      autoFiledTo = match.autoFile.caseFileId;
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
    let stored = 0;
    let skipped = 0;

    for (const a of parsed.attachments ?? []) {
      // The forwarded original itself is not an attachment of the complaint; it IS the
      // complaint, and it has already been unwrapped into the message's own columns.
      if (a.contentType === 'message/rfc822') continue;

      const bytes = a.content as Buffer;
      const filename = a.filename || `attachment-${stored + skipped + 1}`;
      const sha256 = createHash('sha256').update(bytes).digest('hex');

      let stagingKey: string | null = null;
      let skippedReason: string | null = null;

      if (bytes.length === 0) {
        skippedReason = 'The file was empty.';
      } else if (bytes.length > MAX_UPLOAD_BYTES) {
        skippedReason =
          `${Math.round(bytes.length / 1_048_576)} MB, over the ` +
          `${MAX_UPLOAD_BYTES / 1_048_576} MB limit.`;
      } else if (!sniff(bytes)) {
        // Sniffed from the bytes, never trusted from the declared type - the same rule
        // the browser upload path follows.
        skippedReason = `Not a kind the register stores (declared ${a.contentType}).`;
      } else {
        stagingKey = `${STAGING_PREFIX}${randomUUID()}`;
        await this.storage.write(stagingKey, bytes, a.contentType);
      }

      await tx.execute(sql`
        INSERT INTO mail_attachment (council_id, mail_message_id, filename, declared_type,
                                     size_bytes, sha256, staging_key, skipped_reason)
        VALUES (${ctx.councilId}::uuid, ${mailMessageId}::uuid, ${filename},
                ${a.contentType}, ${bytes.length}, ${sha256}, ${stagingKey}, ${skippedReason})
      `);

      if (stagingKey) stored++;
      else skipped++;
    }

    return { stored, skipped };
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
    const rows = await tx.execute<Omit<TrayRow, 'complainant'> & { mailbox: string | null }>(sql`
      SELECT m.id, m.subject, m.snippet, m.envelope_from, m.envelope_from_name,
             m.envelope_date, m.ingested_at, m.forward_kind, m.mailbox,
             m.original_from, m.original_from_name, m.original_subject, m.original_date_text,
             m.status, m.suggestion_note, m.suggested_case_file_id,
             sc.case_number AS suggested_case_number,
             (SELECT count(*)::int FROM mail_attachment a
               WHERE a.mail_message_id = m.id AND a.staging_key IS NOT NULL) AS attachment_count,
             (SELECT count(*)::int FROM mail_attachment a
               WHERE a.mail_message_id = m.id AND a.skipped_reason IS NOT NULL) AS skipped_count
      FROM mail_message m
      LEFT JOIN case_file sc ON sc.id = m.suggested_case_file_id
      WHERE m.council_id = ${ctx.councilId}::uuid AND m.status = ${status}::mail_status
      ORDER BY m.ingested_at DESC
      LIMIT 200
    `);
    const council = await this.councilAddresses(tx, ctx);
    return rows.rows.map(({ mailbox, ...row }) => ({
      ...row,
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
      SELECT id, filename, declared_type, size_bytes, sha256, document_id, skipped_reason
      FROM mail_attachment WHERE mail_message_id = ${id}::uuid ORDER BY created_at
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
      subject: args.subject,
      body: args.body,
      fromEmail: args.fromEmail,
      receivedAt: args.receivedAt,
    });

    // The Message-ID goes on the letter so a later reply in the same thread can find it.
    if (args.messageId) {
      await tx.execute(sql`
        UPDATE correspondence SET message_id = ${args.messageId}
        WHERE council_id = ${ctx.councilId}::uuid AND id = ${correspondenceId}::uuid
      `);
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
   * commit() moves the object out of staging BEFORE any row is written, so a failure here
   * leaves the bytes at their permanent key with nothing pointing at them and the staging
   * key gone. Each attachment is therefore committed independently and a failure on one
   * does not take the others - the message still files, and the officer sees which files
   * did not make it.
   */
  private async fileAttachments(
    tx: Tx,
    ctx: EngineContext,
    mailMessageId: string,
    caseFileId: string,
  ): Promise<number> {
    const rows = await tx.execute<{ id: string; filename: string; staging_key: string }>(sql`
      SELECT id, filename, staging_key FROM mail_attachment
      WHERE council_id = ${ctx.councilId}::uuid AND mail_message_id = ${mailMessageId}::uuid
        AND staging_key IS NOT NULL AND document_id IS NULL
      ORDER BY created_at
    `);

    let filed = 0;
    for (const a of rows.rows) {
      const committed = await this.documents.commit(tx, ctx, {
        caseFileId,
        storageKey: a.staging_key,
        title: a.filename,
        originalFilename: a.filename,
        documentClass: 'complaint_material',
      });
      await tx.execute(sql`
        UPDATE mail_attachment SET document_id = ${committed.documentId}::uuid
        WHERE id = ${a.id}::uuid
      `);
      filed++;
    }
    return filed;
  }

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
      suggestion_note: string | null;
      dismissed_reason: string | null;
      mailbox: string | null;
    }>(sql`
      SELECT m.id, m.subject, m.body_text, m.body_html, m.snippet, m.message_id,
             m.envelope_from, m.envelope_from_name, m.envelope_to, m.envelope_date,
             m.ingested_at, m.forward_kind, m.original_from, m.original_from_name,
             m.original_to, m.original_subject, m.original_date, m.original_date_text,
             m.original_body, m.status, m.matched_rung, m.case_file_id,
             c.case_number, m.suggestion_note, m.dismissed_reason, m.mailbox
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
