import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, initDb, withCouncil, type Db, type Tx } from '@ksdc/db';
import { KSDC_CONFIG, type CouncilConfig } from '@ksdc/config';
import { FollowupService, type EngineContext } from './followup.service.js';
import { makeCaseFile, makeRespondent, seedCouncilAndOfficer } from '../../test-support/fixtures.js';

/**
 * The follow-up engine's invariants. These are the tests that decide whether the product
 * does the one thing it exists to do.
 */

let db: Db;
const councilId = '66666666-6666-4666-8666-666666666666';
const officer = '77777777-7777-4777-8777-777777777777';
const svc = new FollowupService();

// Thursday 10 September 2026, mid-morning IST.
const DAY0 = new Date('2026-09-10T04:00:00Z');
const at = (isoDate: string) => new Date(`${isoDate}T04:00:00Z`);

const config: CouncilConfig = KSDC_CONFIG;
const ctx: EngineContext = { councilId, userId: officer, config };

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId }, (tx) =>
    seedCouncilAndOfficer(tx, { councilId, officerId: officer, code: 'FUKS' }),
  );
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  // Nothing is ever deleted (the app role has no DELETE grant), so each test retires the
  // previous test's rows instead: follow-ups cancelled, cases closed with a reason.
  await withCouncil({ councilId }, async (tx) => {
    await tx.execute(sql`UPDATE follow_up SET status = 'cancelled', resolution_note = 'test reset'
                         WHERE council_id = ${councilId}::uuid AND status IN ('open','snoozed')`);
    await tx.execute(sql`UPDATE case_file SET state = 'closed', closed_at = now(),
                           closure_reason = 'withdrawn'
                         WHERE council_id = ${councilId}::uuid AND state <> 'closed'`);
  });
});

let serial = 0;
const makeCase = (tx: Tx, state = 'under_scrutiny') =>
  makeCaseFile(tx, { councilId, serial: ++serial, state, councilCode: 'FUKS' });

/** A case with one real respondent row, so foreign keys are actually exercised. */
async function makeCaseWithRespondent(tx: Tx) {
  const caseFileId = await makeCase(tx, 'awaiting_respondent_reply');
  const { caseRespondentId } = await makeRespondent(tx, { councilId, caseFileId });
  return { caseFileId, caseRespondentId };
}

describe('opening a follow-up', () => {
  it('computes the due date over working days from the council calendar', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = await makeCase(tx);
      const f = await svc.open(
        tx,
        ctx,
        { stage: 'await_patient_docs', caseFileId: caseId, waitingOnKind: 'complainant' },
        DAY0,
      );
      // KSDC works Mon-Sat, so from Thursday the 10th, seven working days lands on
      // Friday the 18th: only Sunday the 13th is skipped.
      expect(f.dueOn).toBe('2026-09-18');
      expect(f.escalationLevel).toBe(0);
      expect(f.status).toBe('open');
    });
  });

  it('is idempotent — a repeated transition cannot raise two identical obligations', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = await makeCase(tx);
      const input = {
        stage: 'await_patient_docs' as const,
        caseFileId: caseId,
        waitingOnKind: 'complainant' as const,
      };
      const a = await svc.open(tx, ctx, input, DAY0);
      const b = await svc.open(tx, ctx, input, DAY0);
      expect(b.id).toBe(a.id);
      expect(await svc.liveForCase(tx, ctx, caseId)).toHaveLength(1);
    });
  });

  it('keeps separate ladders for two respondents on one case', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = await makeCase(tx, 'awaiting_respondent_reply');
      const { caseRespondentId: r1 } = await makeRespondent(tx, {
        councilId,
        caseFileId: caseId,
        name: 'Dr A. Rao',
      });
      const { caseRespondentId: r2 } = await makeRespondent(tx, {
        councilId,
        caseFileId: caseId,
        name: 'Dr S. Kamath',
      });
      // caseRespondentId is part of the dedupe key, so two dentists get two obligations.
      const a = await svc.open(
        tx,
        ctx,
        {
          stage: 'await_respondent_explanation',
          caseFileId: caseId,
          caseRespondentId: r1,
          waitingOnKind: 'respondent',
        },
        DAY0,
      );
      const b = await svc.open(
        tx,
        ctx,
        {
          stage: 'await_respondent_explanation',
          caseFileId: caseId,
          caseRespondentId: r2,
          waitingOnKind: 'respondent',
        },
        DAY0,
      );
      expect(b.id).not.toBe(a.id);
      expect(await svc.liveForCase(tx, ctx, caseId)).toHaveLength(2);
    });
  });
});

describe('snoozing', () => {
  it('never moves the due date, so a late case cannot be laundered clean', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = await makeCase(tx);
      const f = await svc.open(
        tx,
        ctx,
        { stage: 'await_patient_docs', caseFileId: caseId, waitingOnKind: 'complainant' },
        DAY0,
      );
      await svc.snooze(tx, ctx, { followUpId: f.id, until: '2026-10-15' });

      const [after] = await svc.liveForCase(tx, ctx, caseId);
      expect(after!.status).toBe('snoozed');
      expect(after!.snoozedUntil).toBe('2026-10-15');
      expect(after!.dueOn).toBe(f.dueOn); // unchanged
    });
  });

  it('refuses to snooze a statutory deadline past its due date', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = await makeCase(tx);
      const f = await svc.open(
        tx,
        ctx,
        { stage: 'await_patient_docs', caseFileId: caseId, waitingOnKind: 'complainant' },
        DAY0,
      );
      // Force the statutory flag, as the RTI stage will carry in Phase 5.
      await tx.execute(sql`UPDATE follow_up SET is_statutory = true WHERE id = ${f.id}::uuid`);

      await expect(
        svc.snooze(tx, ctx, { followUpId: f.id, until: '2026-12-01' }),
      ).rejects.toThrow(/statutory deadline/i);

      // Snoozing to before the due date is still allowed.
      await expect(
        svc.snooze(tx, ctx, { followUpId: f.id, until: '2026-09-15' }),
      ).resolves.toBeUndefined();
    });
  });

  it('wakes on the tick once the snooze has expired', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = await makeCase(tx);
      const f = await svc.open(
        tx,
        ctx,
        { stage: 'await_patient_docs', caseFileId: caseId, waitingOnKind: 'complainant' },
        DAY0,
      );
      await svc.snooze(tx, ctx, { followUpId: f.id, until: '2026-09-20' });

      const early = await svc.tick(tx, ctx, at('2026-09-19'));
      expect(early.woken).toBe(0);

      const later = await svc.tick(tx, ctx, at('2026-09-20'));
      expect(later.woken).toBe(1);
      const [row] = await svc.liveForCase(tx, ctx, caseId);
      expect(row!.status).not.toBe('snoozed');
    });
  });
});

describe('escalation', () => {
  it('creates a new row rather than mutating the old one, so three notices are provable', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId: caseId, caseRespondentId: respondentId } =
        await makeCaseWithRespondent(tx);
      await svc.open(
        tx,
        ctx,
        {
          stage: 'await_respondent_explanation',
          caseFileId: caseId,
          caseRespondentId: respondentId,
          waitingOnKind: 'respondent',
        },
        DAY0,
      );

      // Due 18 Sep; the rule escalates 7 working days later.
      await svc.tick(tx, ctx, at('2026-09-28'));
      await svc.tick(tx, ctx, at('2026-10-08'));

      const all = await tx.execute<{
        status: string;
        escalation_level: number;
        escalated_from_id: string | null;
        title: string;
      }>(sql`
        SELECT status, escalation_level, escalated_from_id, title
        FROM follow_up
        WHERE case_file_id = ${caseId}::uuid AND stage = 'await_respondent_explanation'
        ORDER BY escalation_level
      `);

      expect(all.rows).toHaveLength(3);
      expect(all.rows.map((r) => r.escalation_level)).toEqual([0, 1, 2]);
      // The earlier obligations survive as evidence, marked escalated rather than erased.
      expect(all.rows[0]!.status).toBe('escalated');
      expect(all.rows[1]!.status).toBe('escalated');
      expect(all.rows[2]!.status).toBe('open');
      expect(all.rows[1]!.escalated_from_id).toBeTruthy();
    });
  });

  it('says "no reply logged", never "did not respond"', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId: caseId, caseRespondentId } = await makeCaseWithRespondent(tx);
      await svc.open(
        tx,
        ctx,
        {
          stage: 'await_respondent_explanation',
          caseFileId: caseId,
          caseRespondentId,
          waitingOnKind: 'respondent',
        },
        DAY0,
      );
      await svc.tick(tx, ctx, at('2026-09-28'));

      const [row] = await svc.liveForCase(tx, ctx, caseId);
      // In Phase 1 inbound mail is logged by hand, so the software cannot tell silence
      // from an unlogged reply — and must not imply otherwise about a named dentist.
      expect(row!.title).toMatch(/no reply logged/i);
      expect(row!.title).not.toMatch(/did not respond|failed to/i);
    });
  });

  it('waits the configured gap rather than escalating every single day', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId: caseId, caseRespondentId } = await makeCaseWithRespondent(tx);
      await svc.open(
        tx,
        ctx,
        {
          stage: 'await_respondent_explanation',
          caseFileId: caseId,
          caseRespondentId,
          waitingOnKind: 'respondent',
        },
        DAY0,
      );
      // One day past due is not yet an escalation.
      expect((await svc.tick(tx, ctx, at('2026-09-19'))).escalated).toBe(0);
      expect((await svc.tick(tx, ctx, at('2026-09-21'))).escalated).toBe(0);
      expect((await svc.tick(tx, ctx, at('2026-09-28'))).escalated).toBe(1);
    });
  });

  it('stops at a proposal and never declares anyone ex parte itself', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId: caseId, caseRespondentId: respondentId } =
        await makeCaseWithRespondent(tx);
      await svc.open(
        tx,
        ctx,
        {
          stage: 'await_respondent_explanation',
          caseFileId: caseId,
          caseRespondentId: respondentId,
          waitingOnKind: 'respondent',
        },
        DAY0,
      );

      // Run the ladder out: notice 1, escalation to 2, escalation to 3, then the proposal.
      for (const d of ['2026-09-28', '2026-10-08', '2026-10-20', '2026-11-02']) {
        await svc.tick(tx, ctx, at(d));
      }

      const proposals = await tx.execute<{ stage: string; waiting_on_kind: string; detail: string }>(
        sql`SELECT stage, waiting_on_kind, detail FROM follow_up
            WHERE case_file_id = ${caseId}::uuid AND stage = 'propose_ex_parte'`,
      );
      expect(proposals.rows).toHaveLength(1);
      // The decision is on the officer's desk, not the respondent's.
      expect(proposals.rows[0]!.waiting_on_kind).toBe('council_officer');
      expect(proposals.rows[0]!.detail).toMatch(/has not decided anything/i);

      // And crucially: the engine has not touched the respondent's notice ladder. The
      // count still reads zero, because no letter has been confirmed as despatched. A
      // timer-driven count here would become the legal basis for an ex parte finding
      // against a named dentist.
      const respondentRows = await tx.execute<{ notice_count: number; notice_state: string }>(
        sql`SELECT notice_count, notice_state FROM case_respondent WHERE id = ${respondentId}::uuid`,
      );
      expect(respondentRows.rows[0]!.notice_count).toBe(0);
      expect(respondentRows.rows[0]!.notice_state).toBe('not_issued');
    });
  });

  it('runs the whole ladder in about six weeks, not twelve', async () => {
    // Regression. The escalated row used to be created due one gap in the future, and the
    // escalation check then waited another gap on top — so three notices to a dentist took
    // twelve weeks instead of six, and nobody would have noticed except the dentist.
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId, caseRespondentId } = await makeCaseWithRespondent(tx);
      await svc.open(
        tx,
        ctx,
        {
          stage: 'await_respondent_explanation',
          caseFileId,
          caseRespondentId,
          waitingOnKind: 'respondent',
        },
        DAY0,
      );

      // Tick every day for twelve weeks and record when each rung actually fires.
      const fired: string[] = [];
      let cursor = new Date(DAY0);
      for (let i = 0; i < 84; i++) {
        cursor = new Date(cursor.getTime() + 86_400_000);
        const r = await svc.tick(tx, ctx, cursor);
        if (r.escalated || r.proposals) fired.push(cursor.toISOString().slice(0, 10));
      }

      // Notice 2, notice 3, then the proposal — three events, roughly a week apart each,
      // all inside six weeks of the original deadline.
      expect(fired).toHaveLength(3);
      const lastEvent = fired.at(-1)!;
      const weeks = (Date.parse(lastEvent) - Date.parse('2026-09-18')) / (7 * 86_400_000);
      expect(weeks).toBeLessThan(6);
    });
  });

  it('never escalates a proposal — it waits for a person indefinitely', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = await makeCase(tx);
      await svc.open(
        tx,
        ctx,
        { stage: 'propose_closure', caseFileId: caseId, waitingOnKind: 'council_officer' },
        DAY0,
      );
      const r = await svc.tick(tx, ctx, at('2027-01-01'));
      expect(r.escalated).toBe(0);
      const live = await svc.liveForCase(tx, ctx, caseId);
      expect(live).toHaveLength(1);
      expect(live[0]!.escalationLevel).toBe(0);
    });
  });
});

describe('the no-next-step invariant', () => {
  it('flags an open case that nobody is chasing', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = await makeCase(tx);
      const swept = await svc.sweepNoNextStep(tx, ctx, DAY0);
      expect(swept.flagged).toBeGreaterThanOrEqual(1);

      const live = await svc.liveForCase(tx, ctx, caseId);
      expect(live.map((f) => f.stage)).toContain('no_next_step');
      expect(live[0]!.title).toMatch(/no next step/i);
    });
  });

  it('does not flag a case that already has a live follow-up', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = await makeCase(tx);
      await svc.open(
        tx,
        ctx,
        { stage: 'await_patient_docs', caseFileId: caseId, waitingOnKind: 'complainant' },
        DAY0,
      );
      await svc.sweepNoNextStep(tx, ctx, DAY0);
      const live = await svc.liveForCase(tx, ctx, caseId);
      expect(live.map((f) => f.stage)).not.toContain('no_next_step');
    });
  });

  it('clears the flag once a real next step appears', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = await makeCase(tx);
      await svc.sweepNoNextStep(tx, ctx, DAY0);
      expect((await svc.liveForCase(tx, ctx, caseId)).map((f) => f.stage)).toContain(
        'no_next_step',
      );

      await svc.open(
        tx,
        ctx,
        { stage: 'await_patient_docs', caseFileId: caseId, waitingOnKind: 'complainant' },
        DAY0,
      );
      const swept = await svc.sweepNoNextStep(tx, ctx, DAY0);
      expect(swept.cleared).toBeGreaterThanOrEqual(1);
      expect((await svc.liveForCase(tx, ctx, caseId)).map((f) => f.stage)).not.toContain(
        'no_next_step',
      );
    });
  });

  it('leaves closed and on-hold cases alone', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const held = await makeCase(tx);
      await tx.execute(sql`
        UPDATE case_file SET on_hold = true, hold_reason = 'sub judice', held_since = now()
        WHERE id = ${held}::uuid
      `);
      await svc.sweepNoNextStep(tx, ctx, DAY0);
      expect(await svc.liveForCase(tx, ctx, held)).toHaveLength(0);
    });
  });
});

describe('satisfying and dismissing', () => {
  it('records which contact event satisfied the follow-up', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = await makeCase(tx);
      const f = await svc.open(
        tx,
        ctx,
        { stage: 'await_patient_docs', caseFileId: caseId, waitingOnKind: 'complainant' },
        DAY0,
      );

      const contact = await tx.execute<{ id: string }>(sql`
        INSERT INTO contact_event (council_id, case_file_id, channel, direction, summary, occurred_at)
        VALUES (${councilId}::uuid, ${caseId}::uuid, 'email'::contact_channel,
                'in'::contact_direction, 'Bills and prescriptions received', now())
        RETURNING id
      `);

      await svc.satisfy(tx, ctx, {
        followUpId: f.id,
        contactEventId: contact.rows[0]!.id,
        note: 'documents complete',
      });

      expect(await svc.liveForCase(tx, ctx, caseId)).toHaveLength(0);
      const row = await tx.execute<{ satisfied_by_contact_event_id: string }>(
        sql`SELECT satisfied_by_contact_event_id FROM follow_up WHERE id = ${f.id}::uuid`,
      );
      // "How do we know they replied?" has an answer that points at a record.
      expect(row.rows[0]!.satisfied_by_contact_event_id).toBe(contact.rows[0]!.id);
    });
  });

  it('refuses to dismiss without a reason', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = await makeCase(tx);
      const f = await svc.open(
        tx,
        ctx,
        { stage: 'await_patient_docs', caseFileId: caseId, waitingOnKind: 'complainant' },
        DAY0,
      );
      await expect(svc.dismiss(tx, ctx, { followUpId: f.id, reason: '  ' })).rejects.toThrow(
        /requires a reason/i,
      );
      await expect(
        svc.dismiss(tx, ctx, { followUpId: f.id, reason: 'complainant withdrew by phone' }),
      ).resolves.toBeUndefined();
    });
  });

  it('supersedes the right stages when a case moves on', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = await makeCase(tx);
      await svc.open(
        tx,
        ctx,
        { stage: 'await_patient_docs', caseFileId: caseId, waitingOnKind: 'complainant' },
        DAY0,
      );
      await svc.open(
        tx,
        ctx,
        { stage: 'ad_hoc', caseFileId: caseId, waitingOnKind: 'council_officer' },
        DAY0,
      );

      const n = await svc.supersede(tx, ctx, {
        caseFileId: caseId,
        stages: ['await_patient_docs'],
      });
      expect(n).toBe(1);

      const live = await svc.liveForCase(tx, ctx, caseId);
      expect(live.map((f) => f.stage)).toEqual(['ad_hoc']);
    });
  });
});
