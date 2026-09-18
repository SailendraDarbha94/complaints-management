import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, council } from './platform.js';
import { caseFile, party } from './cases.js';
import {
  contactDirectionEnum,
  correspondenceKindEnum,
  documentClassEnum,
  documentStatusEnum,
} from './enums.js';

/** Templates, letters, documents and the two numbering series the software owns. */

/**
 * Templates are a textarea with a field picker, not an IDE (build plan §6). Rendering is
 * a ~30-line function supporting {{field}} and {{#if field}}…{{/if}}, escaping everything
 * it inserts, validated against a whitelisted field list per kind.
 */
export const template = pgTable(
  'template',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    kind: correspondenceKindEnum('kind').notNull(),
    name: text('name').notNull(),
    /** Editing a system template changes the terms of reference; publishing warns. */
    isSystem: boolean('is_system').notNull().default(false),
    requiresRegistrarSignature: boolean('requires_registrar_signature').notNull().default(false),
    currentVersionId: uuid('current_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('template_kind_uq').on(t.councilId, t.kind)],
);

/**
 * Versioned. A quasi-judicial record must be able to show which template version produced
 * a given letter — in 2031, about a 2026 letter.
 */
export const templateVersion = pgTable(
  'template_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => template.id, { onDelete: 'restrict' }),
    versionNo: integer('version_no').notNull(),
    subjectTpl: text('subject_tpl').notNull(),
    body: text('body').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by').references(() => appUser.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('template_version_uq').on(t.templateId, t.versionNo)],
);

/**
 * Every letter and email, in or out. Inbound is symmetrical from day one (paste + upload)
 * so the register shows a real two-way chronology before any mailbox is connected.
 */
export const correspondence = pgTable(
  'correspondence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    caseFileId: uuid('case_file_id').references(() => caseFile.id, { onDelete: 'restrict' }),
    /**
     * An RTI reply hangs off the RTI application, not off a case, and often there is no
     * case at all. Exactly one of the two anchors is set.
     *
     * The foreign key is declared in migration 0011 rather than here: rti_request
     * references correspondence (for the reply it was answered by), so declaring the
     * reverse in this file would make the two schema modules import each other. The
     * constraint is real either way - it lives in the database, which is where it is
     * enforced.
     */
    rtiRequestId: uuid('rti_request_id'),
    kind: correspondenceKindEnum('kind').notNull(),
    direction: contactDirectionEnum('direction').notNull(),

    toPartyId: uuid('to_party_id').references(() => party.id, { onDelete: 'set null' }),
    toName: text('to_name'),
    toEmail: text('to_email'),
    fromEmail: text('from_email'),

    subject: text('subject').notNull(),
    body: text('body').notNull(),

    templateVersionId: uuid('template_version_id').references(() => templateVersion.id, {
      onDelete: 'set null',
    }),
    /**
     * The exact merge context that produced this letter, snapshotted. This is how we prove
     * in 2031 what wording and what data produced a 2026 letter.
     */
    mergeContext: jsonb('merge_context').$type<Record<string, unknown>>(),

    /**
     * The RFC 5322 Message-ID, where one is known.
     *
     * Written today only on an INBOUND message filed from the mail tray. Phase 1 letters
     * go out by hand from council webmail, so there is no outbound Message-ID to record -
     * but when there is, a reply that threads perfectly should not fall to the tray for
     * want of a column.
     */
    messageId: text('message_id'),

    /** Set by the officer's "I have sent this" click. THIS is what starts the clock. */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),

    /**
     * The office-wide outward despatch number, typed in AFTER the letter is stamped.
     * The software never generates it — that book is shared with certificates and
     * circulars issued by people who will never touch this system (build plan D2).
     */
    despatchNo: text('despatch_no'),
    despatchDate: date('despatch_date'),
    despatchRegisterPage: text('despatch_register_page'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('correspondence_case_ix').on(t.councilId, t.caseFileId, t.createdAt),
    index('correspondence_rti_ix').on(t.councilId, t.rtiRequestId, t.createdAt),
    uniqueIndex('correspondence_message_id_uq')
      .on(t.councilId, t.messageId)
      .where(sql`message_id IS NOT NULL`),
    // Two letters cannot claim the same despatch number in the same financial year.
    // Partial: most letters have none until the office stamps them.
    uniqueIndex('correspondence_despatch_uq')
      .on(t.councilId, t.despatchNo)
      .where(sql`despatch_no IS NOT NULL`),
    check(
      'correspondence_despatch_needs_date',
      sql`(despatch_no IS NULL) OR (despatch_date IS NOT NULL)`,
    ),
  ],
);

/** Metadata over object storage. Versions are immutable; nothing is overwritten. */
export const document = pgTable(
  'document',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    caseFileId: uuid('case_file_id').references(() => caseFile.id, { onDelete: 'restrict' }),
    /** The RTI application this belongs to, where it is not a case document. FK in 0011. */
    rtiRequestId: uuid('rti_request_id'),
    title: text('title').notNull(),
    documentClass: documentClassEnum('document_class').notNull().default('complaint_material'),
    /**
     * `stored` or `misfiled_withdrawn`. The 11pm mistake — patient A's OPG on patient B's
     * case — gets a first-class path: the object moves to a quarantine prefix no case
     * sheet, bundle or export reads. Nothing is deleted; the audit records the move.
     */
    status: documentStatusEnum('status').notNull().default('stored'),
    misfiledReason: text('misfiled_reason'),
    currentVersionId: uuid('current_version_id'),
    /** The council sometimes holds physical originals that must go back. */
    physicalOriginalHeld: boolean('physical_original_held').notNull().default(false),
    physicalReturnedAt: timestamp('physical_returned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('document_case_ix').on(t.councilId, t.caseFileId, t.createdAt),
    index('document_rti_ix').on(t.councilId, t.rtiRequestId, t.createdAt),
  ],
);

export const documentVersion = pgTable(
  'document_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => document.id, { onDelete: 'restrict' }),
    versionNo: integer('version_no').notNull(),
    /**
     * UUID-only object key — no patient names, no original filenames. Keys appear in logs
     * and browser history; the filename is applied at download time instead.
     */
    storageKey: text('storage_key').notNull(),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    uploadedBy: uuid('uploaded_by').references(() => appUser.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('document_version_uq').on(t.documentId, t.versionNo),
    uniqueIndex('document_version_key_uq').on(t.storageKey),
  ],
);

/** Who opened which document, and when. Shown to committee members as a visible banner. */
export const documentAccessLog = pgTable(
  'document_access_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    documentVersionId: uuid('document_version_id')
      .notNull()
      .references(() => documentVersion.id, { onDelete: 'restrict' }),
    appUserId: uuid('app_user_id').references(() => appUser.id, { onDelete: 'set null' }),
    action: text('action').notNull(), // 'signed_url_issued' | 'downloaded'
    ip: text('ip'),
    userAgent: text('user_agent'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('document_access_log_ix').on(t.councilId, t.documentVersionId, t.occurredAt)],
);

/**
 * The two series the software owns: the case serial and the RTI serial. NOT the outward
 * despatch number. Allocation is `UPDATE … RETURNING` inside the caller's transaction, so
 * two concurrent intakes cannot take the same serial.
 */
export const numberSequence = pgTable(
  'number_sequence',
  {
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    series: text('series').notNull(), // 'COMP' | 'ETH' | 'RTI'
    fiscalYear: text('fiscal_year').notNull(),
    nextValue: integer('next_value').notNull().default(1),
  },
  (t) => [uniqueIndex('number_sequence_pk').on(t.councilId, t.series, t.fiscalYear)],
);

/** Every serial ever handed out, so a gap can be explained rather than guessed at. */
export const numberAllocation = pgTable(
  'number_allocation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    series: text('series').notNull(),
    fiscalYear: text('fiscal_year').notNull(),
    value: integer('value').notNull(),
    formatted: text('formatted').notNull(),
    caseFileId: uuid('case_file_id').references(() => caseFile.id, { onDelete: 'set null' }),
    allocatedAt: timestamp('allocated_at', { withTimezone: true }).notNull().defaultNow(),
    allocatedBy: uuid('allocated_by').references(() => appUser.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('number_allocation_uq').on(t.councilId, t.series, t.fiscalYear, t.value)],
);
