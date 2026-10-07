import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, council } from './platform.js';
import { caseFile } from './cases.js';
import { mailMessage } from './mail.js';
import {
  mailSuggestionConfidenceEnum,
  mailSuggestionDecisionEnum,
  mailSuggestionStatusEnum,
} from './enums.js';

/**
 * What the mail assistant suggested for a message in the tray, what it cost, and what the
 * officer did about it.
 *
 * Not part of the register. In stage 1 the model only reads; a suggestion becomes a
 * change only when the officer clicks, and is then carried out by the same services the
 * ordinary buttons use. This table is the record of the suggestion and of its fate -
 * including when the officer ignored it and used the ordinary buttons ('handled'), which
 * is what keeps the agreement figure honest. See migration 0017.
 *
 * A row per attempt, not per message: asking again supersedes the card's suggestion but
 * keeps the old row, because it cost money and the month's cost has to add up.
 */
export const mailSuggestion = pgTable(
  'mail_suggestion',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    mailMessageId: uuid('mail_message_id')
      .notNull()
      .references(() => mailMessage.id, { onDelete: 'restrict' }),

    status: mailSuggestionStatusEnum('status').notNull().default('pending'),

    decision: mailSuggestionDecisionEnum('decision'),
    confidence: mailSuggestionConfidenceEnum('confidence'),
    reasoning: text('reasoning'),
    /**
     * The TriageProposal as the model returned it (see core's modules/assistant/types.ts).
     * Typed loosely here because this package cannot import core; the service owns the
     * shape.
     */
    proposal: jsonb('proposal').$type<Record<string, unknown>>(),

    /** The model and the playbook's sha256, so a change in accuracy can be traced. */
    model: text('model').notNull(),
    effort: text('effort').notNull(),
    playbookVersion: text('playbook_version').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    /** To the millionth of a dollar: a month is hundreds of sub-cent amounts. */
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    /** Plain English, safe to show the officer. Never the email's text. */
    error: text('error'),

    /** 'opened_case' | 'filed_on_case' | 'set_aside' | 'rejected' - checked in the table. */
    outcomeAction: text('outcome_action'),
    outcomeCaseFileId: uuid('outcome_case_file_id').references(() => caseFile.id, {
      onDelete: 'restrict',
    }),
    /** Did what happened match the suggestion? Null for 'unsure' and for rejections. */
    outcomeAgreed: boolean('outcome_agreed'),
    outcomeNote: text('outcome_note'),
    actedAt: timestamp('acted_at', { withTimezone: true }),
    actedBy: uuid('acted_by').references(() => appUser.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** The mail robot when the reader asked; the officer when they asked again. */
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  },
  (t) => [
    // One suggestion on the card at a time.
    uniqueIndex('mail_suggestion_one_pending_uq')
      .on(t.councilId, t.mailMessageId)
      .where(sql`status = 'pending'`),
    index('mail_suggestion_message_ix').on(t.councilId, t.mailMessageId, t.createdAt),
    index('mail_suggestion_created_ix').on(t.councilId, t.createdAt),
    check(
      'mail_suggestion_outcome_action_ck',
      sql`outcome_action IS NULL OR outcome_action IN ('opened_case', 'filed_on_case', 'set_aside', 'rejected')`,
    ),
    check(
      'mail_suggestion_acted_has_outcome',
      sql`status NOT IN ('accepted', 'edited', 'rejected', 'handled') OR (outcome_action IS NOT NULL AND acted_at IS NOT NULL)`,
    ),
    check('mail_suggestion_failed_says_why', sql`status <> 'failed' OR error IS NOT NULL`),
    check('mail_suggestion_has_decision', sql`status = 'failed' OR decision IS NOT NULL`),
    check(
      'mail_suggestion_counts_not_negative',
      sql`input_tokens >= 0 AND output_tokens >= 0 AND cache_read_tokens >= 0 AND cache_write_tokens >= 0 AND tool_calls >= 0 AND cost_usd >= 0`,
    ),
  ],
);
