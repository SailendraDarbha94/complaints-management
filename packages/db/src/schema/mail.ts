import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, council } from './platform.js';
import { caseFile } from './cases.js';
import { mailForwardKindEnum, mailMatchRungEnum, mailStatusEnum } from './enums.js';

/**
 * The inward mail tray.
 *
 * The officer forwards a complaint to a mailbox the software watches, and this is where
 * that message lands: as itself, before anybody decides what it is. A message is not a
 * case. Turning every forward into one would spend a serial from a legal register on a
 * piece of spam, and a voided entry in that book is harder to explain than an empty tray.
 *
 * See migration 0013 for the full reasoning, including why the raw bytes are deliberately
 * not stored here.
 */
export const mailMessage = pgTable(
  'mail_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),

    /**
     * Three answers to "have we seen this before", in decreasing order of trust.
     *
     * `gmMsgId` is Gmail's X-GM-MSGID: server-assigned and the one identifier a sender
     * cannot influence. `messageId` is the RFC 5322 header - sender-controlled, optional,
     * and able to repeat legitimately, so deduping on it alone would silently DROP a
     * genuine second complaint. `rawSha256` is the hash of the complete source and is the
     * guard that never lies.
     */
    gmMsgId: text('gm_msg_id'),
    messageId: text('message_id'),
    rawSha256: text('raw_sha256').notNull(),

    mailbox: text('mailbox').notNull(),
    uid: bigint('uid', { mode: 'number' }),
    /** A BigInt on the wire; text here because comparing it is all we ever do. */
    uidValidity: text('uid_validity'),

    /**
     * The envelope as it arrived. On a forward this is the OFFICER, not the complainant -
     * which is the truth about how the message reached the Council. The complainant is in
     * `originalFrom`.
     */
    envelopeFrom: text('envelope_from').notNull(),
    envelopeFromName: text('envelope_from_name'),
    envelopeTo: text('envelope_to'),
    envelopeDate: timestamp('envelope_date', { withTimezone: true }).notNull(),
    subject: text('subject').notNull(),

    inReplyTo: text('in_reply_to'),
    referenceIds: text('reference_ids').array(),

    bodyText: text('body_text'),
    bodyHtml: text('body_html'),
    /** What the card shows. Stored so the tray renders in one query. */
    snippet: text('snippet').notNull().default(''),

    /**
     * The original, dug out of a forward.
     *
     * `originalDate` is a real timestamp and is set ONLY when the original came from a
     * message/rfc822 attachment, where a Date header with a true offset survives. In-body
     * forward headers carry no timezone at all, so parsing one into a timestamp would
     * invent an offset - silently the server's. Those are kept verbatim as text.
     */
    forwardKind: mailForwardKindEnum('forward_kind').notNull().default('none'),
    originalFrom: text('original_from'),
    originalFromName: text('original_from_name'),
    originalTo: text('original_to'),
    originalSubject: text('original_subject'),
    originalDate: timestamp('original_date', { withTimezone: true }),
    originalDateText: text('original_date_text'),
    originalBody: text('original_body'),

    status: mailStatusEnum('status').notNull().default('unfiled'),
    matchedRung: mailMatchRungEnum('matched_rung'),
    caseFileId: uuid('case_file_id').references(() => caseFile.id, { onDelete: 'restrict' }),
    /** FK added in 0013; not declared here to avoid a cycle with correspondence.ts. */
    correspondenceId: uuid('correspondence_id'),
    /**
     * A case the ladder found but would not file to on its own: the number resolved to a
     * closed case, two different numbers appeared, or the only signal was the sender.
     */
    suggestedCaseFileId: uuid('suggested_case_file_id').references(() => caseFile.id, {
      onDelete: 'set null',
    }),
    suggestionNote: text('suggestion_note'),

    filedAt: timestamp('filed_at', { withTimezone: true }),
    filedBy: uuid('filed_by').references(() => appUser.id, { onDelete: 'set null' }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    dismissedReason: text('dismissed_reason'),
    dismissedBy: uuid('dismissed_by').references(() => appUser.id, { onDelete: 'set null' }),

    /** When the software ingested it, which is not when it was sent. */
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('mail_message_gm_uq')
      .on(t.councilId, t.gmMsgId)
      .where(sql`gm_msg_id IS NOT NULL`),
    uniqueIndex('mail_message_raw_uq').on(t.councilId, t.rawSha256),
    index('mail_message_tray_ix')
      .on(t.councilId, t.ingestedAt)
      .where(sql`status = 'unfiled'`),
    index('mail_message_case_ix')
      .on(t.councilId, t.caseFileId)
      .where(sql`case_file_id IS NOT NULL`),
    // A dismissal without a reason is a message that vanished.
    check(
      'mail_dismissed_needs_reason',
      sql`status <> 'dismissed' OR (dismissed_reason IS NOT NULL AND dismissed_at IS NOT NULL)`,
    ),
    check(
      'mail_filed_needs_case',
      sql`status <> 'filed' OR (case_file_id IS NOT NULL AND filed_at IS NOT NULL)`,
    ),
  ],
);

/**
 * What came attached.
 *
 * Staged into object storage at ingest and promoted to a case document only when the
 * message is filed, which is why the staging key is recorded: without it the bytes are
 * unreachable and the officer is reading a complaint whose bills were thrown away.
 *
 * `skippedReason` is the column that matters. The register accepts PDFs and images; real
 * mail also carries .docx, .zip, calendar invitations and signature logos. Those are
 * refused, and refusing them silently would leave the officer believing they had it all.
 */
export const mailAttachment = pgTable(
  'mail_attachment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    mailMessageId: uuid('mail_message_id')
      .notNull()
      .references(() => mailMessage.id, { onDelete: 'restrict' }),

    filename: text('filename').notNull(),
    declaredType: text('declared_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),

    /** Where the bytes wait while the message sits in the tray. Null when refused. */
    stagingKey: text('staging_key'),
    /** FK added in 0013; not declared here to avoid a cycle with correspondence.ts. */
    documentId: uuid('document_id'),
    skippedReason: text('skipped_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mail_attachment_message_ix').on(t.councilId, t.mailMessageId)],
);
