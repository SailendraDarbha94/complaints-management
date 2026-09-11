import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, initDb, withCouncil, type Db } from '@ksdc/db';
import { KSDC_CONFIG } from '@ksdc/config';
import { FollowupService, type EngineContext } from '../followups/followup.service.js';
import { QueueService } from '../followups/queue.service.js';
import { CaseIntakeService } from '../cases/case-intake.service.js';
import { CaseLifecycleService } from '../cases/case-lifecycle.service.js';
import { DigestService } from '../notifications/digest.service.js';
import { MailerPort, assertSendable, type OutboundMessage } from '../notifications/mailer.js';
import { SchedulerService } from './scheduler.service.js';
import { seedCouncilAndOfficer } from '../../test-support/fixtures.js';

/**
 * The daily job, driven through the scheduler rather than by calling the engine directly.
 *
 * This file exists because of a bug that every other test missed: `councils()` listed the
 * councils to process from a table protected by row-level security, before any council
 * scope existed, and so found none. The job did nothing at all, every day, and reported
 * {"status":"ok"} while doing it. Testing the engine in isolation could never have caught
 * that; only running the job end to end does.
 */

let db: Db;
const councilId = '30303030-3030-4303-8303-303030303030';
const officerId = '40404040-4040-4404-8404-404040404040';

class CapturingMailer extends MailerPort {
  sent: OutboundMessage[] = [];
  async send(message: OutboundMessage) {
    assertSendable(message.to);
    this.sent.push(message);
    return { transport: 'console' as const, messageId: crypto.randomUUID() };
  }
}

const followups = new FollowupService();
const queue = new QueueService();
const intake = new CaseIntakeService(followups);
const lifecycle = new CaseLifecycleService(followups);
const ctx: EngineContext = { councilId, userId: officerId, config: KSDC_CONFIG };

let mailer: CapturingMailer;
let scheduler: SchedulerService;

/**
 * Each test runs the job on its OWN day.
 *
 * Both job_run and notification_log are keyed by logical date, so resetting between tests
 * would mean reassigning a permutation over a unique column -- which fights itself,
 * because the index is checked per row as the UPDATE proceeds and a row can land on a
 * date its neighbour has not vacated yet. Distinct days need no reset at all, and match
 * how the job actually runs: once per day, forwards.
 *
 * All of these are Tue-Sat in September 2026, so every one is a working day for KSDC.
 */
const DAYS = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-08'];
let dayIndex = -1;

function nextDay(): { date: string; at: Date } {
  dayIndex += 1;
  const date = DAYS[dayIndex];
  if (!date) throw new Error('Add more working days to DAYS');
  // 09:00 IST, which is 03:30 UTC.
  return { date, at: new Date(`${date}T03:30:00Z`) };
}

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId }, async (tx) => {
    await seedCouncilAndOfficer(tx, { councilId, officerId, code: 'SCHD' });
    await tx.execute(sql`
      INSERT INTO council_config (council_id, config)
      VALUES (${councilId}::uuid, ${JSON.stringify(KSDC_CONFIG)}::jsonb)
      ON CONFLICT (council_id) DO UPDATE SET config = EXCLUDED.config
    `);
  });
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  mailer = new CapturingMailer();
  scheduler = new SchedulerService(followups, new DigestService(queue, mailer));
});

describe('the daily job', () => {
  it('finds the councils it is supposed to process', async () => {
    // The regression. If this is ever zero again, everything below is meaningless and
    // the job would still say it succeeded.
    const { date, at } = nextDay();
    const result = await scheduler.run('daily', date, () => scheduler.daily(at));
    expect(result.status).toBe('ok');
    expect(result.result).toBeDefined();
    // A digest going out is the proof a council was actually visited.
    expect(mailer.sent.length).toBeGreaterThan(0);
  });

  it('escalates an overdue follow-up and tells the officer about it', async () => {
    const { date, at } = nextDay();
    const received = new Date('2026-06-01T05:30:00Z');
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await intake.create(tx, ctx, {
        summary: 'Long-overdue document request',
        receivedAt: received,
        complainant: { fullName: 'Smt. Scheduler Probe' },
      });
      await lifecycle.apply(tx, ctx, {
        caseFileId: c.caseFileId,
        event: 'REQUEST_DOCUMENTS',
        occurredAt: received,
      });
    });

    const result = await scheduler.run('daily', date, () => scheduler.daily(at));
    const stats = result.result as Record<string, number>;

    expect(result.status).toBe('ok');
    expect(stats.escalated).toBeGreaterThan(0);
    expect(stats.digestsSent).toBe(1);

    // The escalated obligation is created due TODAY -- the reminder is owed now -- so the
    // digest reports it as due today rather than as overdue. The overdue rung it replaced
    // has been retired.
    expect(mailer.sent[0]!.subject).toMatch(/due today/);
    expect(mailer.sent[0]!.text).toMatch(/SCHD\/COMP\/2026-27\//);
    expect(mailer.sent[0]!.text).toMatch(/no reply logged/);
  });

  it('does not run twice for the same day', async () => {
    const { date, at } = nextDay();
    const first = await scheduler.run('daily', date, () => scheduler.daily(at));
    const second = await scheduler.run('daily', date, () => scheduler.daily(at));
    expect(first.status).toBe('ok');
    // A retried Cloud Scheduler delivery must not escalate the ladder twice.
    expect(second.status).toBe('skipped');
  });

  it('lets a failed day be retried, rather than losing it forever', async () => {
    const { date, at } = nextDay();
    const failed = await scheduler.run('daily', date, async () => {
      throw new Error('database went away');
    });
    expect(failed.status).toBe('failed');

    // The application role has no DELETE grant, so if a failed run kept its claim the
    // day could never be re-run and its escalations would be lost permanently.
    const retried = await scheduler.run('daily', date, () => scheduler.daily(at));
    expect(retried.status).toBe('ok');
  });

  it('records the run so the Today banner can prove the engine is alive', async () => {
    const { date, at } = nextDay();
    await scheduler.run('daily', date, () => scheduler.daily(at));
    const row = await db.execute<{ status: string; finished_at: Date; stats: unknown }>(sql`
      SELECT status, finished_at, stats FROM job_run
      WHERE job_name = 'daily' AND logical_date = ${date}::date
    `);
    expect(row.rows[0]!.status).toBe('ok');
    expect(row.rows[0]!.finished_at).toBeTruthy();
    expect(row.rows[0]!.stats).toBeTruthy();
  });
});

describe('the scheduler scan exception', () => {
  it('reaches council_config and nothing else', async () => {
    // Migration 0004 cuts a SELECT-only hole on council_config alone. If this ever
    // returns a case, the hole has grown.
    const leaked = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.scheduler_scan', 'on', true)`);
      const configs = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM council_config`,
      );
      const cases = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM case_file`,
      );
      const parties = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM party`);
      return {
        configs: configs.rows[0]!.n,
        cases: cases.rows[0]!.n,
        parties: parties.rows[0]!.n,
      };
    });

    expect(leaked.configs).toBeGreaterThan(0);
    expect(leaked.cases).toBe(0);
    expect(leaked.parties).toBe(0);
  });

  it('shows nothing when the flag is not set', async () => {
    const none = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM council_config`,
    );
    expect(none.rows[0]!.n).toBe(0);
  });
});
