import { bigint, index, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * The audit chain. One chain, not four (build plan D13).
 *
 * Lives in its own `audit` schema so grants can differ from everything else: the
 * application role has INSERT and SELECT only, no UPDATE, no DELETE, and a
 * BEFORE UPDATE OR DELETE trigger raises regardless. Appends go through a SECURITY
 * DEFINER function holding a per-council advisory lock, so `seq` is gapless.
 *
 * `canonical_payload` stores the exact string that was hashed. It costs about 50 MB per
 * decade and removes the sharpest edge in the design: a Postgres major-version change to
 * jsonb::text silently invalidating every historical verification.
 */
export const auditSchema = pgSchema('audit');

export const auditEvents = auditSchema.table(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id').notNull(),
    /** Gapless per council. Allocated under pg_advisory_xact_lock. */
    seq: bigint('seq', { mode: 'number' }).notNull(),

    /** Hash of the previous event in this council's chain; NULL for the first. */
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
    canonicalPayload: text('canonical_payload').notNull(),

    /**
     * Two writers: a row-level trigger on every business table (column diffs, actor read
     * from the session GUCs), and explicit semantic events. The timeline UI renders the
     * semantic ones; `case_milestone` remains the register projection, rebuildable from here.
     */
    action: text('action').notNull(),
    entityTable: text('entity_table'),
    entityId: uuid('entity_id'),
    caseFileId: uuid('case_file_id'),

    actorUserId: uuid('actor_user_id'),
    actorRole: text('actor_role'),

    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),

    ip: text('ip'),
    userAgent: text('user_agent'),
    requestId: uuid('request_id'),

    /**
     * `unattributed: true` is the canary for a write that reached the database without
     * going through withCouncil(). It should never appear; an alert fires if it does.
     */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('audit_events_seq_uq').on(t.councilId, t.seq),
    index('audit_events_entity_ix').on(t.councilId, t.entityTable, t.entityId),
    index('audit_events_case_ix').on(t.councilId, t.caseFileId, t.occurredAt),
  ],
);

/**
 * The nightly Ed25519 seal of each council's chain head, written to a retention-locked
 * bucket the API cannot write to. The head hash prints in the register PDF footer, so a
 * printout ties back to the chain. No blockchain anchoring — nobody at a state council
 * will verify a Merkle proof, and a retention-locked object already answers
 * "prove this wasn't backdated".
 */
export const auditSeal = auditSchema.table(
  'seal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id').notNull(),
    headSeq: bigint('head_seq', { mode: 'number' }).notNull(),
    headHash: text('head_hash').notNull(),
    signature: text('signature').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
    storageKey: text('storage_key'),
  },
  (t) => [uniqueIndex('audit_seal_uq').on(t.councilId, t.headSeq)],
);
