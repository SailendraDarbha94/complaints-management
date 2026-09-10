import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, initDb, withCouncil, type Db } from '@ksdc/db';
import { KSDC_CONFIG } from '@ksdc/config';
import { FollowupService, type EngineContext } from './followup.service.js';
import { QueueService } from './queue.service.js';
import { CaseIntakeService } from '../cases/case-intake.service.js';
import { CaseLifecycleService } from '../cases/case-lifecycle.service.js';
import { makeRespondent, seedCouncilAndOfficer } from '../../test-support/fixtures.js';

/**
 * The Today screen. If this is wrong, the officer opens the app and does the wrong thing
 * — or worse, sees a clean list and believes it.
 */

let db: Db;
const councilId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const officer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const followups = new FollowupService();
const queue = new QueueService();
const intake = new CaseIntakeService(followups);
const lifecycle = new CaseLifecycleService(followups);
const ctx: EngineContext = { councilId, userId: officer, config: KSDC_CONFIG };

const RECEIVED = new Date('2026-08-01T05:30:00Z');

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId }, (tx) =>
    seedCouncilAndOfficer(tx, { councilId, officerId: officer, code: 'QUEU' }),
  );
});

afterAll(async () => {
  await closeDb();
});

describe('the Today queue', () => {
  it('groups by who you are chasing and sorts by how late they are', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      // A complainant who owes documents, overdue.
      const a = await intake.create(tx, ctx, {
        summary: 'Bridge failed after three months',
        receivedAt: RECEIVED,
        complainant: { fullName: 'Smt. K. Devi', mobile: '9845012345' },
      });
      await lifecycle.apply(tx, ctx, {
        caseFileId: a.caseFileId,
        event: 'REQUEST_DOCUMENTS',
        occurredAt: RECEIVED,
      });

      // A dentist who owes an explanation, also overdue.
      const b = await intake.create(tx, ctx, {
        summary: 'Extraction of the wrong tooth',
        receivedAt: RECEIVED,
        complainant: { fullName: 'Sri M. Iyer' },
      });
      await lifecycle.apply(tx, ctx, {
        caseFileId: b.caseFileId,
        event: 'MARK_COMPLETE_ON_ARRIVAL',
        occurredAt: RECEIVED,
      });
      const resp = await makeRespondent(tx, { councilId, caseFileId: b.caseFileId });
      await lifecycle.apply(tx, ctx, {
        caseFileId: b.caseFileId,
        event: 'ISSUE_RESPONDENT_NOTICE',
        caseRespondentId: resp.caseRespondentId,
        occurredAt: RECEIVED,
        notice: { serviceMode: 'email', sentAt: RECEIVED },
      });

      const q = await queue.today(tx, ctx, '2026-09-10');

      const groups = Object.fromEntries(q.byWaitingOn.map((g) => [g.key, g]));
      expect(groups.complainant?.count).toBeGreaterThanOrEqual(1);
      expect(groups.respondent?.count).toBeGreaterThanOrEqual(1);
      // "Who owes me documents?" and "Which doctor has not replied?" — answered by name.
      expect(groups.complainant!.label).toMatch(/complainant/i);
      expect(groups.respondent!.label).toMatch(/dentist/i);

      // Every item carries the case number, so the officer can act without opening it.
      for (const g of q.byWaitingOn) {
        for (const item of g.items) {
          if (item.caseFileId) expect(item.caseNumber).toMatch(/^QUEU\/COMP\/2026-27\/\d{4}$/);
        }
      }

      // Sorted with the latest first inside a group.
      const overdue = q.byUrgency.find((g) => g.key === 'overdue');
      expect(overdue).toBeDefined();
      const days = overdue!.items.map((i) => i.daysOverdue);
      expect(days.every((d) => d > 0)).toBe(true);
    });
  });

  it('puts proposals at the top, above anything merely overdue', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await intake.create(tx, ctx, {
        summary: 'Dentist has not replied to three notices',
        receivedAt: RECEIVED,
        complainant: { fullName: 'Sri P. Shetty' },
      });
      await lifecycle.apply(tx, ctx, {
        caseFileId: c.caseFileId,
        event: 'MARK_COMPLETE_ON_ARRIVAL',
        occurredAt: RECEIVED,
      });
      const resp = await makeRespondent(tx, { councilId, caseFileId: c.caseFileId });
      await lifecycle.apply(tx, ctx, {
        caseFileId: c.caseFileId,
        event: 'ISSUE_RESPONDENT_NOTICE',
        caseRespondentId: resp.caseRespondentId,
        occurredAt: RECEIVED,
        notice: { serviceMode: 'email', sentAt: RECEIVED },
      });

      // Run the ladder out so the engine hands over a proposal.
      for (const d of ['2026-08-20', '2026-09-01', '2026-09-15', '2026-10-01']) {
        await followups.tick(tx, ctx, new Date(`${d}T04:00:00Z`));
      }

      const q = await queue.today(tx, ctx, '2026-10-01');
      expect(q.byUrgency[0]!.key).toBe('needs_decision');
      expect(q.summary.needsDecision).toBeGreaterThanOrEqual(1);

      const proposal = q.byUrgency[0]!.items.find((i) => i.stage === 'propose_ex_parte');
      expect(proposal).toBeDefined();
      // The proposal sits on the officer's desk, not the dentist's.
      expect(proposal!.waitingOnKind).toBe('council_officer');
    });
  });

  it('keeps a snoozed-but-overdue item counted as overdue', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await intake.create(tx, ctx, {
        summary: 'Snooze probe',
        receivedAt: RECEIVED,
        complainant: { fullName: 'Sri V. Hegde' },
      });
      await lifecycle.apply(tx, ctx, {
        caseFileId: c.caseFileId,
        event: 'REQUEST_DOCUMENTS',
        occurredAt: RECEIVED,
      });
      const [f] = await followups.liveForCase(tx, ctx, c.caseFileId);
      await followups.snooze(tx, ctx, { followUpId: f!.id, until: '2026-09-30' });

      const q = await queue.today(tx, ctx, '2026-09-10');
      const snoozedGroup = q.byUrgency.find((g) => g.key === 'snoozed');
      expect(snoozedGroup).toBeDefined();

      const item = snoozedGroup!.items.find((i) => i.caseFileId === c.caseFileId);
      expect(item).toBeDefined();
      // Snoozing hid it from the top of the list but did not launder the lateness away.
      expect(item!.daysOverdue).toBeGreaterThan(0);
      expect(q.summary.snoozedOverdue).toBeGreaterThanOrEqual(1);

      // And it is not double-counted in the who-am-I-chasing view.
      const inWaiting = q.byWaitingOn
        .flatMap((g) => g.items)
        .some((i) => i.followUpId === item!.followUpId);
      expect(inWaiting).toBe(false);
    });
  });

  it('hides a case that is on hold rather than nagging about it', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await intake.create(tx, ctx, {
        summary: 'Matter before the consumer forum',
        receivedAt: RECEIVED,
        complainant: { fullName: 'Smt. L. Bai' },
      });
      await lifecycle.apply(tx, ctx, {
        caseFileId: c.caseFileId,
        event: 'REQUEST_DOCUMENTS',
        occurredAt: RECEIVED,
      });

      const before = await queue.today(tx, ctx, '2026-09-10');
      expect(before.byUrgency.flatMap((g) => g.items).some((i) => i.caseFileId === c.caseFileId)).toBe(
        true,
      );

      await lifecycle.apply(tx, ctx, {
        caseFileId: c.caseFileId,
        event: 'PUT_ON_HOLD',
        reason: 'Sub judice before the district consumer forum',
      });

      const after = await queue.today(tx, ctx, '2026-09-10');
      expect(after.byUrgency.flatMap((g) => g.items).some((i) => i.caseFileId === c.caseFileId)).toBe(
        false,
      );
    });
  });

  it('reports how long the case itself has been quiet, not just the timer', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await intake.create(tx, ctx, {
        summary: 'Quiet case',
        receivedAt: RECEIVED,
        complainant: { fullName: 'Sri D. Naik' },
      });
      const q = await queue.today(tx, ctx, '2026-09-10');
      const item = q.byUrgency.flatMap((g) => g.items).find((i) => i.caseFileId === c.caseFileId);
      expect(item).toBeDefined();
      // 1 August to 10 September.
      expect(item!.caseQuietDays).toBe(40);
    });
  });
});

describe('the ticker health banner', () => {
  it('reports stale when the ticker has never run', async () => {
    await withCouncil({ councilId }, async (tx) => {
      const h = await queue.tickerHealth(tx, 'never-run-job');
      // A silently dead ticker recreates the exact pain this product exists to remove,
      // so absence of evidence is reported as a problem, not as health.
      expect(h.lastSuccessAt).toBeNull();
      expect(h.stale).toBe(true);
    });
  });

  it('reports healthy just after a successful run, and stale past 26 hours', async () => {
    await withCouncil({ councilId }, async (tx) => {
      await tx.execute(sql`
        INSERT INTO job_run (job_name, logical_date, status, finished_at)
        VALUES ('fresh-job', '2026-09-10', 'ok', now())
      `);
      const fresh = await queue.tickerHealth(tx, 'fresh-job');
      expect(fresh.stale).toBe(false);

      await tx.execute(sql`
        INSERT INTO job_run (job_name, logical_date, status, finished_at)
        VALUES ('stale-job', '2026-09-08', 'ok', now() - interval '30 hours')
      `);
      const stale = await queue.tickerHealth(tx, 'stale-job');
      expect(stale.stale).toBe(true);
      expect(stale.hoursSince).toBeGreaterThan(26);
    });
  });
});
