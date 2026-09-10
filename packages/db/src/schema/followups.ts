import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, council } from './platform.js';
import { caseFile, caseRespondent, contactEvent, party } from './cases.js';
import { followupStageEnum, followupStatusEnum, waitingOnEnum } from './enums.js';

/**
 * The follow-up engine — the answer to "I keep forgetting to reach out".
 *
 * The invariant: every open case owns at least one open follow-up, or it is flagged as
 * having no next step. Forgetting almost always means nothing was ever scheduled, and a
 * case with no timer is invisible to a timer-based system.
 */
export const followUp = pgTable(
  'follow_up',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    caseFileId: uuid('case_file_id').references(() => caseFile.id, { onDelete: 'restrict' }),
    caseRespondentId: uuid('case_respondent_id').references(() => caseRespondent.id, {
      onDelete: 'restrict',
    }),

    stage: followupStageEnum('stage').notNull(),
    /** Who we are chasing. Mirrors the case's waiting_on, and drives the Today grouping. */
    waitingOnKind: waitingOnEnum('waiting_on_kind').notNull(),
    waitingOnPartyId: uuid('waiting_on_party_id').references(() => party.id, {
      onDelete: 'set null',
    }),
    assigneeUserId: uuid('assignee_user_id').references(() => appUser.id, { onDelete: 'set null' }),

    title: text('title').notNull(),
    detail: text('detail'),

    /**
     * Dates, not timestamps. The domain speaks in days ("give them seven days"); a date
     * column makes working-day arithmetic and overdue counts correct with no DST reasoning.
     */
    openedOn: date('opened_on').notNull(),
    dueOn: date('due_on').notNull(),
    /** Statutory clocks (RTI) cannot be snoozed past their due date. */
    isStatutory: boolean('is_statutory').notNull().default(false),

    status: followupStatusEnum('status').notNull().default('open'),

    /**
     * Escalation creates a NEW row linked by escalated_from_id and marks the old one
     * `escalated`. Nothing is mutated in place, so notice 1 → 2 → 3 is provable as three
     * obligations with three dates.
     */
    escalationLevel: integer('escalation_level').notNull().default(0),
    escalatedFromId: uuid('escalated_from_id'),

    /**
     * Snoozing sets snoozed_until and NEVER touches due_on — snoozing can never launder an
     * overdue case into a clean one. The snoozed group shows "(2 · 1 overdue)" permanently.
     */
    snoozedUntil: date('snoozed_until'),
    snoozeCount: integer('snooze_count').notNull().default(0),

    satisfiedAt: timestamp('satisfied_at', { withTimezone: true }),
    satisfiedBy: uuid('satisfied_by').references(() => appUser.id, { onDelete: 'set null' }),
    satisfiedByContactEventId: uuid('satisfied_by_contact_event_id').references(
      () => contactEvent.id,
      { onDelete: 'set null' },
    ),
    /** Manual dismissal requires a reason — a follow-up cannot vanish silently. */
    resolutionNote: text('resolution_note'),

    /**
     * Stops the engine opening a second identical obligation on a retried tick or a
     * repeated transition. Unique among live rows only.
     */
    dedupeKey: text('dedupe_key').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('follow_up_dedupe_uq')
      .on(t.councilId, t.dedupeKey)
      .where(sql`status IN ('open','snoozed')`),
    // The Today screen's query: live rows for a council, ordered by lateness.
    index('follow_up_queue_ix')
      .on(t.councilId, t.dueOn)
      .where(sql`status IN ('open','snoozed')`),
    index('follow_up_case_ix').on(t.councilId, t.caseFileId, t.status),
    index('follow_up_group_ix')
      .on(t.councilId, t.waitingOnKind, t.dueOn)
      .where(sql`status IN ('open','snoozed')`),
  ],
);

/**
 * Delivery log for the daily digest, so a retried scheduler delivery cannot send twice
 * and so "did the officer actually get told?" is answerable.
 */
export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(), // 'daily_digest' | 'otp' | …
    channel: text('channel').notNull().default('email'),
    /** The council-local date this notification is *for*. */
    logicalDate: date('logical_date').notNull(),
    subject: text('subject'),
    itemCount: integer('item_count'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('notification_log_uq').on(t.appUserId, t.kind, t.logicalDate)],
);
