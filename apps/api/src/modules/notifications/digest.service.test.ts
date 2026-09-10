import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, initDb, withCouncil, type Db, type Tx } from '@ksdc/db';
import { KSDC_CONFIG, type CouncilConfig } from '@ksdc/config';
import { FollowupService, type EngineContext } from '../followups/followup.service.js';
import { QueueService } from '../followups/queue.service.js';
import { CaseIntakeService } from '../cases/case-intake.service.js';
import { CaseLifecycleService } from '../cases/case-lifecycle.service.js';
import { DigestService, digestSubject, renderDigest } from './digest.service.js';
import { MailerPort, assertSendable, type OutboundMessage } from './mailer.js';
import { seedCouncilAndOfficer } from '../../test-support/fixtures.js';

/**
 * The daily digest. Its job is to be the one message that reaches the officer when they
 * are not looking at the app, so the tests are mostly about when it does and does not go.
 */

let db: Db;
const councilId = '10101010-1010-4101-8101-101010101010';
const officerId = '20202020-2020-4202-8202-202020202020';

class CapturingMailer extends MailerPort {
  sent: OutboundMessage[] = [];
  failNext = false;
  async send(message: OutboundMessage) {
    assertSendable(message.to);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('SMTP unavailable');
    }
    this.sent.push(message);
    return { transport: 'console' as const, messageId: crypto.randomUUID() };
  }
}

const followups = new FollowupService();
const queue = new QueueService();
const intake = new CaseIntakeService(followups);
const lifecycle = new CaseLifecycleService(followups);

let mailer: CapturingMailer;
let digest: DigestService;

const ctx: EngineContext = { councilId, userId: officerId, config: KSDC_CONFIG };

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId }, (tx) =>
    seedCouncilAndOfficer(tx, { councilId, officerId, code: 'DGST' }),
  );
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  mailer = new CapturingMailer();
  digest = new DigestService(queue, mailer);
  await withCouncil({ councilId }, async (tx) => {
    await tx.execute(sql`
      UPDATE notification_log SET logical_date = logical_date - interval '400 days'
      WHERE council_id = ${councilId}::uuid
    `);
    await tx.execute(sql`UPDATE follow_up SET status = 'cancelled', resolution_note = 'reset'
                         WHERE council_id = ${councilId}::uuid AND status IN ('open','snoozed')`);
    await tx.execute(sql`UPDATE case_file SET state = 'closed', closed_at = now(),
                           closure_reason = 'withdrawn'
                         WHERE council_id = ${councilId}::uuid AND state <> 'closed'`);
  });
});

let serial = 500;
async function overdueCase(tx: Tx, summary: string) {
  const received = new Date('2026-08-01T05:30:00Z');
  const c = await intake.create(tx, ctx, {
    summary,
    receivedAt: received,
    complainant: { fullName: 'Smt. Test Complainant', mobile: '9800000000' },
  });
  serial++;
  await lifecycle.apply(tx, ctx, {
    caseFileId: c.caseFileId,
    event: 'REQUEST_DOCUMENTS',
    occurredAt: received,
  });
  return c;
}

// Thursday 10 September 2026 — a working day for KSDC (Mon–Sat).
const WORKING_DAY = '2026-09-10';
const SUNDAY = '2026-09-13';

describe('sending', () => {
  it('emails the officer, with the counts in the subject line', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      await overdueCase(tx, 'Crown came off within a week');
      const result = await digest.sendDaily(tx, ctx, WORKING_DAY);

      expect(result.sent).toBe(1);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to).toBe('officer@dgst.test');
      // Read on a lock screen, one-handed.
      expect(mailer.sent[0]!.subject).toMatch(/^\[DGST\] .*overdue/);
      expect(mailer.sent[0]!.text).toContain('DGST/COMP/2026-27/');
    });
  });

  it('sends on a quiet day too, because an empty digest is proof it is alive', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const result = await digest.sendDaily(tx, ctx, WORKING_DAY);
      expect(result.sent).toBe(1);
      expect(mailer.sent[0]!.subject).toMatch(/Nothing needs you today/);
      expect(mailer.sent[0]!.text).toMatch(/Nothing needs you today/);
    });
  });

  it('stays quiet on a day the office is shut', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      await overdueCase(tx, 'Sunday probe');
      const result = await digest.sendDaily(tx, ctx, SUNDAY);
      expect(result.sent).toBe(0);
      expect(mailer.sent).toHaveLength(0);
    });
  });

  it('stays quiet on a declared holiday', async () => {
    const withHoliday: CouncilConfig = {
      ...KSDC_CONFIG,
      calendar: { ...KSDC_CONFIG.calendar, holidays: [WORKING_DAY] },
    };
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const result = await digest.sendDaily(tx, { ...ctx, config: withHoliday }, WORKING_DAY);
      expect(result.sent).toBe(0);
    });
  });

  it('does not send twice for the same day', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      await overdueCase(tx, 'Retry probe');
      const first = await digest.sendDaily(tx, ctx, WORKING_DAY);
      const second = await digest.sendDaily(tx, ctx, WORKING_DAY);

      // A retried Cloud Scheduler delivery must not mail the officer twice.
      expect(first.sent).toBe(1);
      expect(second.sent).toBe(0);
      expect(second.skipped).toBe(1);
      expect(mailer.sent).toHaveLength(1);
    });
  });

  it('retries a send that failed, rather than marking the day done', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      await overdueCase(tx, 'Failure probe');

      mailer.failNext = true;
      const failed = await digest.sendDaily(tx, ctx, WORKING_DAY);
      expect(failed.failed).toBe(1);
      expect(mailer.sent).toHaveLength(0);

      // The claim row exists but was never sent, so the next run may re-claim it.
      // Otherwise a transient SMTP blip would silently cost a whole day's reminder.
      const retried = await digest.sendDaily(tx, ctx, WORKING_DAY);
      expect(retried.sent).toBe(1);
      expect(mailer.sent).toHaveLength(1);
    });
  });

  it('records what it reported, so a later question has an answer', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await overdueCase(tx, 'Payload probe');
      await digest.sendDaily(tx, ctx, WORKING_DAY);

      const row = await tx.execute<{
        item_count: number;
        payload: { items: Array<{ caseNumber: string }> };
      }>(sql`
        SELECT item_count, payload FROM notification_log
        WHERE app_user_id = ${officerId}::uuid AND logical_date = ${WORKING_DAY}::date
      `);
      expect(row.rows[0]!.item_count).toBeGreaterThan(0);
      expect(row.rows[0]!.payload.items.map((i) => i.caseNumber)).toContain(c.caseNumber);
    });
  });

  it('never writes to the inbox complaints arrive in', async () => {
    // The digest goes to a person. registrar@ is the pile they are digging out of.
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      await tx.execute(sql`
        UPDATE app_user SET email = 'registrar@ksdc.in' WHERE id = ${officerId}::uuid
      `);
      const result = await digest.sendDaily(tx, ctx, WORKING_DAY);
      expect(result.failed).toBe(1);
      expect(mailer.sent).toHaveLength(0);

      const err = await tx.execute<{ error: string }>(sql`
        SELECT error FROM notification_log
        WHERE app_user_id = ${officerId}::uuid AND logical_date = ${WORKING_DAY}::date
      `);
      expect(err.rows[0]!.error).toMatch(/Refusing to send/);

      await tx.execute(sql`
        UPDATE app_user SET email = 'officer@dgst.test' WHERE id = ${officerId}::uuid
      `);
    });
  });
});

describe('what the digest says', () => {
  const emptyQueue = {
    summary: {
      today: WORKING_DAY,
      total: 0,
      needsDecision: 0,
      overdue: 0,
      dueToday: 0,
      thisWeek: 0,
      snoozed: 0,
      snoozedOverdue: 0,
    },
    byUrgency: [],
    byWaitingOn: [],
  };

  it('leads the subject with decisions, then lateness', async () => {
    const q = {
      ...emptyQueue,
      summary: { ...emptyQueue.summary, needsDecision: 2, overdue: 3, dueToday: 1, total: 6 },
    };
    expect(digestSubject(q, 'KSDC')).toBe('[KSDC] 2 to decide, 3 overdue, 1 due today');
  });

  it('says so plainly when there is nothing', () => {
    expect(digestSubject(emptyQueue, 'KSDC')).toBe('[KSDC] Nothing needs you today');
    const body = renderDigest(emptyQueue, { councilName: 'KSDC', officerName: 'Officer' });
    expect(body).toMatch(/Nothing needs you today/);
    expect(body).toMatch(/Open the queue/);
  });

  it('names snoozed items that are already late', () => {
    const q = {
      ...emptyQueue,
      summary: { ...emptyQueue.summary, snoozed: 2, snoozedOverdue: 1 },
    };
    const body = renderDigest(q, { councilName: 'KSDC', officerName: 'Officer' });
    // Snoozing never moved the due date, so pressing snooze cannot make the count vanish.
    expect(body).toMatch(/1 snoozed item is already past its due date/);
  });

  it('says it is not council correspondence', () => {
    const body = renderDigest(emptyQueue, { councilName: 'KSDC', officerName: 'Officer' });
    // The officer must never mistake a reminder for something a party was sent.
    expect(body).toMatch(/not council correspondence/i);
  });
});
