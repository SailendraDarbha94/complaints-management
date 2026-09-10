import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { roleEnum } from './enums.js';

/**
 * Tenancy, identity and scheduler bookkeeping.
 *
 * Shared schema, `council_id` on every business table, row-level security as the
 * enforcement point — not ORM middleware. An unset `app.council_id` yields NULL, which
 * matches no row, so a missing scope returns zero rows rather than another council's data.
 */

// ─── Tenant root ─────────────────────────────────────────────────────────────

export const council = pgTable(
  'council',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(), // KSDC — appears in every case number
    name: text('name').notNull(),
    addressLines: jsonb('address_lines').$type<string[]>().notNull(),
    phone: text('phone'),
    website: text('website'),
    officialEmail: text('official_email').notNull(),
    registrarName: text('registrar_name').notNull(),
    registrarTitle: text('registrar_title').notNull().default('Registrar'),
    presidentTitle: text('president_title').notNull().default('President'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),

    /**
     * Stays NULL until four artefacts exist in docs/authorisation/: the signed letterhead
     * authorisation, the Registrar's email to the project account, proof the domain is
     * registered to the council, and proof the cloud billing account is the council's.
     *
     * While NULL the API refuses to create a non-synthetic case and the dashboard shows
     * DEMO DATA. The legal register of a statutory body must never end up inside one
     * individual's personal cloud account by drift.
     */
    productionAuthorisedAt: timestamp('production_authorised_at', { withTimezone: true }),
    isSynthetic: boolean('is_synthetic').notNull().default(false),

    /**
     * Set once, by the gated "Retire the physical register" action, after 90 days of
     * dual-running, 90 verified exports, an officer-executed restore drill and four clean
     * reconciliations. Until then the paper book is authoritative.
     */
    physicalRegisterRetiredAt: timestamp('physical_register_retired_at', { withTimezone: true }),
    dualRunningStartedOn: date('dual_running_started_on'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('council_code_uq').on(t.code)],
);

/** One row per council. A validated JSONB document — see @ksdc/config. */
export const councilConfig = pgTable('council_config', {
  councilId: uuid('council_id')
    .primaryKey()
    .references(() => council.id, { onDelete: 'restrict' }),
  config: jsonb('config').notNull(),
  schemaVersion: text('schema_version').notNull().default('1'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

// ─── Identity ────────────────────────────────────────────────────────────────

/**
 * Global, NOT council-owned. One person may sit on two councils' committees; that is the
 * whole reason the council picker exists from day one (requirement 38).
 */
export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    mobile: text('mobile'),
    fullName: text('full_name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('app_user_email_uq').on(sql`lower(${t.email})`)],
);

export const councilMembership = pgTable(
  'council_membership',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'restrict' }),
    role: roleEnum('role').notNull(),
    startsOn: date('starts_on').notNull(),
    /** A committee member's term. Access to case documents ends here. */
    endsOn: date('ends_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('council_membership_uq').on(t.councilId, t.appUserId, t.role),
    index('council_membership_user_ix').on(t.appUserId),
  ],
);

/**
 * Identity rows for people who never log in — the Registrar signs letters, the President
 * chairs sittings. They need attribution, not accounts (build plan D6).
 */
export const councilOfficeHolder = pgTable(
  'council_office_holder',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    office: text('office').notNull(), // 'registrar' | 'president' | 'committee_member'
    fullName: text('full_name').notNull(),
    designation: text('designation'),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on'),
  },
  (t) => [index('office_holder_council_ix').on(t.councilId, t.office)],
);

// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * Passwordless email sign-in: a 6-digit code, ten minutes, hashed, rate limited.
 *
 * Hashed with scrypt from `node:crypto` rather than argon2id as the build plan proposed.
 * The hash's only job is that someone who reads the table cannot use an in-flight code;
 * brute force is answered by the ten-minute expiry, the attempt counter and the rate
 * limit, not by hash hardness. scrypt is memory-hard, built in, and adds no native
 * dependency - which matters when the only maintainer builds on Windows and deploys to
 * Cloud Run.
 */
export const authOtp = pgTable(
  'auth_otp',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    /** 'sign_in' creates a session; 'step_up' confirms a consequential action. */
    purpose: text('purpose').notNull().default('sign_in'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    requestIp: text('request_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_otp_email_ix').on(sql`lower(${t.email})`, t.createdAt)],
);

/** Opaque rotating refresh token with reuse detection. */
export const authSession = pgTable(
  'auth_session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    /** Set when this token is rotated. A second use of a rotated token revokes the family. */
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    familyId: uuid('family_id').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_session_token_uq').on(t.refreshTokenHash),
    index('auth_session_user_ix').on(t.appUserId),
  ],
);

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Idempotency for the reminder ticker. Cloud Run scales to zero and throttles CPU
 * between requests, so all periodic work is Cloud Scheduler → OIDC → a Nest endpoint.
 * `(job_name, logical_date)` unique means a retried delivery cannot double-fire.
 */
export const jobRun = pgTable(
  'job_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobName: text('job_name').notNull(),
    /** The council-local date the run is *for*, not when it happened to execute. */
    logicalDate: date('logical_date').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').notNull().default('running'), // running | ok | failed
    error: text('error'),
    stats: jsonb('stats').$type<Record<string, number>>(),
  },
  (t) => [uniqueIndex('job_run_uq').on(t.jobName, t.logicalDate)],
);
