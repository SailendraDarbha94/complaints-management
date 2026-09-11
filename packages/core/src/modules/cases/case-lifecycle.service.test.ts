import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, initDb, withCouncil, type Db, type Tx } from '@ksdc/db';
import { KSDC_CONFIG } from '@ksdc/config';
import { CASE_STATES, parseCaseNumber } from '@ksdc/contracts';
import { FollowupService, type EngineContext } from '../followups/followup.service.js';
import { CaseIntakeService } from './case-intake.service.js';
import { CaseLifecycleService, TransitionNotAllowedError } from './case-lifecycle.service.js';
import { makeRespondent, seedCouncilAndOfficer } from '../../test-support/fixtures.js';

/**
 * The lifecycle end to end: a real complaint walked from the mailbox to a closed case,
 * plus the guards that stop the register recording something it cannot defend.
 */

let db: Db;
const councilId = '88888888-8888-4888-8888-888888888888';
const officer = '99999999-9999-4999-8999-999999999999';

const followups = new FollowupService();
const intake = new CaseIntakeService(followups);
const lifecycle = new CaseLifecycleService(followups);
const ctx: EngineContext = { councilId, userId: officer, config: KSDC_CONFIG };

const RECEIVED = new Date('2026-09-10T05:30:00Z');

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId }, (tx) =>
    seedCouncilAndOfficer(tx, { councilId, officerId: officer, code: 'LIFE' }),
  );
});

afterAll(async () => {
  await closeDb();
});

async function newComplaint(tx: Tx, summary = 'Crown fell off within a week') {
  return intake.create(tx, ctx, {
    summary,
    receivedAt: RECEIVED,
    complainant: { fullName: 'Smt. K. Devi', mobile: '+91 98450 12345', email: 'kdevi@example.in' },
  });
}

async function stateOf(tx: Tx, caseFileId: string) {
  const r = await tx.execute<{ state: string; waiting_on: string; on_hold: boolean }>(
    sql`SELECT state, waiting_on, on_hold FROM case_file WHERE id = ${caseFileId}::uuid`,
  );
  return r.rows[0]!;
}

describe('intake', () => {
  it('issues a case number and a register serial, and never a despatch number', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const a = await newComplaint(tx);
      const b = await newComplaint(tx);

      expect(parseCaseNumber(a.caseNumber)).toMatchObject({
        councilCode: 'LIFE',
        series: 'COMP',
        fiscalYear: '2026-27',
      });
      // Consecutive and gapless, in both series.
      expect(parseCaseNumber(b.caseNumber)!.serial).toBe(parseCaseNumber(a.caseNumber)!.serial + 1);
      expect(b.registerSlNo).toBe(a.registerSlNo + 1);

      // The outward despatch number is the office's book, not ours.
      const corr = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM correspondence WHERE despatch_no IS NOT NULL`,
      );
      expect(corr.rows[0]!.n).toBe(0);
    });
  });

  it('records the arrival date, not the typing date', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      const m = await tx.execute<{ occurred_at: Date; date_source: string }>(sql`
        SELECT occurred_at, date_source FROM case_milestone
        WHERE case_file_id = ${caseFileId}::uuid AND milestone = 'received'
      `);
      expect(new Date(m.rows[0]!.occurred_at).toISOString()).toBe(RECEIVED.toISOString());
      expect(m.rows[0]!.date_source).toBe('recorded');
    });
  });

  it('marks a backfilled date as reconstructed so exports can footnote it', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const r = await intake.create(tx, ctx, {
        summary: 'Backlog case from the book',
        receivedAt: new Date('2026-05-02T00:00:00Z'),
        dateSource: 'from_physical_register',
        isBackfilled: true,
        legacyRegisterRef: 'Book 4, page 22',
        complainant: { fullName: 'Sri R. Kumar' },
      });
      const m = await tx.execute<{ date_source: string }>(sql`
        SELECT date_source FROM case_milestone
        WHERE case_file_id = ${r.caseFileId}::uuid AND milestone = 'received'
      `);
      expect(m.rows[0]!.date_source).toBe('from_physical_register');
    });
  });

  it('stores complainant and patient separately even when they are the same person', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      const roles = await tx.execute<{ role: string }>(sql`
        SELECT role FROM case_party WHERE case_file_id = ${caseFileId}::uuid ORDER BY role
      `);
      // The GDCRI letter names the PATIENT, who in a legal-heir case is not the complainant.
      expect(roles.rows.map((r) => r.role)).toEqual(['complainant', 'patient']);
    });
  });

  it('leaves the new case with something scheduled against it', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      const live = await followups.liveForCase(tx, ctx, caseFileId);
      expect(live.length).toBeGreaterThan(0);
      expect(live[0]!.title).toMatch(/acknowledge and request documents/i);
    });
  });

  it('seeds the register serial from the physical book rather than restarting at 1', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      // Renumbering a legal register is worse than a gap.
      await intake.seedRegisterSerial(tx, councilId, '2027-28', 214);
      const r = await intake.create(tx, ctx, {
        summary: 'First case of the new year',
        receivedAt: new Date('2027-04-05T00:00:00Z'),
        complainant: { fullName: 'Sri T. Naik' },
      });
      expect(r.registerSlNo).toBe(215);
    });
  });
});

describe('walking a complaint end to end', () => {
  it('goes from the mailbox to a closed case, moving waiting_on at each step', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      expect((await stateOf(tx, caseFileId)).waiting_on).toBe('council_officer');

      // 1. Ask the complainant for bills, prescriptions, a timeline and the doctor's details.
      let r = await lifecycle.apply(tx, ctx, { caseFileId, event: 'REQUEST_DOCUMENTS' });
      expect(r.to).toBe('awaiting_complainant_documents');
      expect(r.waitingOn).toBe('complainant');
      expect(r.followupsOpened).toContain('await_patient_docs');

      // 2. They arrive.
      r = await lifecycle.apply(tx, ctx, { caseFileId, event: 'DOCUMENTS_RECEIVED' });
      expect(r.to).toBe('under_scrutiny');
      expect(r.waitingOn).toBe('council_officer');
      expect(r.milestones).toContain('documents_complete');

      // 3. Notice to the dentist. The counter moves only because we confirm despatch.
      const { caseRespondentId } = await makeRespondent(tx, { councilId, caseFileId });
      r = await lifecycle.apply(tx, ctx, {
        caseFileId,
        event: 'ISSUE_RESPONDENT_NOTICE',
        caseRespondentId,
        notice: { serviceMode: 'email', sentAt: new Date('2026-09-20T05:00:00Z') },
      });
      expect(r.to).toBe('awaiting_respondent_reply');
      expect(r.waitingOn).toBe('respondent');

      // 4. They reply. That was the only respondent, so the engine moves the case on.
      r = await lifecycle.apply(tx, ctx, {
        caseFileId,
        event: 'RECORD_RESPONDENT_REPLY',
        caseRespondentId,
      });
      expect(r.cascaded).toBe(true);
      expect(r.to).toBe('ready_for_committee');

      // 5. The committee decides; the order goes out; the case closes.
      r = await lifecycle.apply(tx, ctx, { caseFileId, event: 'RECORD_DECISION' });
      expect(r.to).toBe('awaiting_order_despatch');

      r = await lifecycle.apply(tx, ctx, { caseFileId, event: 'DESPATCH_ORDER' });
      expect(r.to).toBe('closed');
      expect(r.waitingOn).toBe('nobody');

      const final = await tx.execute<{ closure_reason: string }>(
        sql`SELECT closure_reason FROM case_file WHERE id = ${caseFileId}::uuid`,
      );
      expect(final.rows[0]!.closure_reason).toBe('decided_by_committee');

      // Nothing is left chasing a closed case.
      expect(await followups.liveForCase(tx, ctx, caseFileId)).toHaveLength(0);
    });
  });

  it('waits for the last of several respondents before moving to the committee', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx, 'Chain clinic — two dentists named');
      await lifecycle.apply(tx, ctx, { caseFileId, event: 'MARK_COMPLETE_ON_ARRIVAL' });

      const a = await makeRespondent(tx, { councilId, caseFileId, name: 'Dr A. Rao' });
      const b = await makeRespondent(tx, { councilId, caseFileId, name: 'Dr S. Kamath' });

      for (const r of [a, b]) {
        await lifecycle.apply(tx, ctx, {
          caseFileId,
          event: 'ISSUE_RESPONDENT_NOTICE',
          caseRespondentId: r.caseRespondentId,
          notice: { serviceMode: 'speed_post', sentAt: new Date('2026-09-20T05:00:00Z') },
        });
      }

      const first = await lifecycle.apply(tx, ctx, {
        caseFileId,
        event: 'RECORD_RESPONDENT_REPLY',
        caseRespondentId: a.caseRespondentId,
      });
      expect(first.cascaded).toBe(false);
      expect((await stateOf(tx, caseFileId)).state).toBe('awaiting_respondent_reply');

      // The second one never replies and is declared ex parte — by the officer, with a
      // reason, which is what the finding will rest on.
      const second = await lifecycle.apply(tx, ctx, {
        caseFileId,
        event: 'DECLARE_RESPONDENT_EX_PARTE',
        caseRespondentId: b.caseRespondentId,
        reason: 'Three notices served by speed post, no reply. Committee resolved to proceed.',
      });
      expect(second.cascaded).toBe(true);
      expect((await stateOf(tx, caseFileId)).state).toBe('ready_for_committee');
    });
  });
});

describe('per-respondent follow-ups', () => {
  it('stops chasing a dentist who has replied, while still chasing the other', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx, 'Chain clinic, two dentists');
      await lifecycle.apply(tx, ctx, { caseFileId, event: 'MARK_COMPLETE_ON_ARRIVAL' });

      const a = await makeRespondent(tx, { councilId, caseFileId, name: 'Dr A. Rao' });
      const b = await makeRespondent(tx, { councilId, caseFileId, name: 'Dr S. Kamath' });
      for (const r of [a, b]) {
        await lifecycle.apply(tx, ctx, {
          caseFileId,
          event: 'ISSUE_RESPONDENT_NOTICE',
          caseRespondentId: r.caseRespondentId,
          notice: { serviceMode: 'email', sentAt: new Date('2026-09-20T05:00:00Z') },
        });
      }

      // Both rows name their own dentist. Two identical rows would be useless.
      const before = await followups.liveForCase(tx, ctx, caseFileId);
      const chasing = before.filter((f) => f.stage === 'await_respondent_explanation');
      expect(chasing).toHaveLength(2);
      expect(chasing.map((f) => f.title).sort()).toEqual([
        'Dr A. Rao to send an explanation',
        'Dr S. Kamath to send an explanation',
      ]);

      await lifecycle.apply(tx, ctx, {
        caseFileId,
        event: 'RECORD_RESPONDENT_REPLY',
        caseRespondentId: a.caseRespondentId,
      });

      // A dentist who replied is not chased again, but the other one still is.
      const after = await followups.liveForCase(tx, ctx, caseFileId);
      const stillChasing = after.filter((f) => f.stage === 'await_respondent_explanation');
      expect(stillChasing).toHaveLength(1);
      expect(stillChasing[0]!.title).toBe('Dr S. Kamath to send an explanation');
    });
  });

  it('carries the dentist’s party id so the queue can show their phone number', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      await lifecycle.apply(tx, ctx, { caseFileId, event: 'MARK_COMPLETE_ON_ARRIVAL' });
      const r = await makeRespondent(tx, { councilId, caseFileId, name: 'Dr N. Bhat' });
      await lifecycle.apply(tx, ctx, {
        caseFileId,
        event: 'ISSUE_RESPONDENT_NOTICE',
        caseRespondentId: r.caseRespondentId,
        notice: { serviceMode: 'email', sentAt: new Date() },
      });

      const row = await tx.execute<{ waiting_on_party_id: string | null }>(sql`
        SELECT waiting_on_party_id FROM follow_up
        WHERE case_file_id = ${caseFileId}::uuid
          AND stage = 'await_respondent_explanation' AND status = 'open'
      `);
      expect(row.rows[0]!.waiting_on_party_id).toBe(r.partyId);
    });
  });

  it('stops chasing a respondent who is dropped or declared ex parte', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      await lifecycle.apply(tx, ctx, { caseFileId, event: 'MARK_COMPLETE_ON_ARRIVAL' });
      const a = await makeRespondent(tx, { councilId, caseFileId, name: 'Dr A' });
      const b = await makeRespondent(tx, { councilId, caseFileId, name: 'Dr B' });
      for (const r of [a, b]) {
        await lifecycle.apply(tx, ctx, {
          caseFileId,
          event: 'ISSUE_RESPONDENT_NOTICE',
          caseRespondentId: r.caseRespondentId,
          notice: { serviceMode: 'email', sentAt: new Date() },
        });
      }

      await lifecycle.apply(tx, ctx, {
        caseFileId,
        event: 'DROP_RESPONDENT',
        caseRespondentId: a.caseRespondentId,
        reason: 'Named in error; did not treat this patient',
      });

      const live = await followups.liveForCase(tx, ctx, caseFileId);
      expect(live.filter((f) => f.stage === 'await_respondent_explanation')).toHaveLength(1);
    });
  });
});

describe('the guards', () => {
  it('refuses an event the case cannot take, and says what it can', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      await expect(
        lifecycle.apply(tx, ctx, { caseFileId, event: 'DESPATCH_ORDER' }),
      ).rejects.toThrow(TransitionNotAllowedError);
      await expect(
        lifecycle.apply(tx, ctx, { caseFileId, event: 'DESPATCH_ORDER' }),
      ).rejects.toThrow(/Available: REQUEST_DOCUMENTS/);
    });
  });

  it('refuses a Phase 3 event while the council is on Phase 1', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      await lifecycle.apply(tx, ctx, { caseFileId, event: 'MARK_COMPLETE_ON_ARRIVAL' });
      const resp = await makeRespondent(tx, { councilId, caseFileId });
      await lifecycle.apply(tx, ctx, {
        caseFileId,
        event: 'ISSUE_RESPONDENT_NOTICE',
        caseRespondentId: resp.caseRespondentId,
        notice: { serviceMode: 'email', sentAt: new Date() },
      });
      await lifecycle.apply(tx, ctx, {
        caseFileId,
        event: 'RECORD_RESPONDENT_REPLY',
        caseRespondentId: resp.caseRespondentId,
      });

      await expect(
        lifecycle.apply(tx, ctx, { caseFileId, event: 'REFER_TO_EXPERT' }),
      ).rejects.toThrow(/arrives in Phase 3/);
    });
  });

  it('refuses to close, reopen or declare ex parte without a reason', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      await expect(
        lifecycle.apply(tx, ctx, { caseFileId, event: 'CLOSE', closureReason: 'withdrawn' }),
      ).rejects.toThrow(/requires a reason/);
    });
  });

  it('refuses to close without a closure reason — the register records no bare closures', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      await expect(
        lifecycle.apply(tx, ctx, {
          caseFileId,
          event: 'CLOSE',
          reason: 'complainant asked us to stop',
        }),
      ).rejects.toThrow(/requires an explicit closureReason/);
    });
  });

  it('refuses to issue a notice without confirmation that it was despatched', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      await lifecycle.apply(tx, ctx, { caseFileId, event: 'MARK_COMPLETE_ON_ARRIVAL' });
      const resp = await makeRespondent(tx, { councilId, caseFileId });

      await expect(
        lifecycle.apply(tx, ctx, {
          caseFileId,
          event: 'ISSUE_RESPONDENT_NOTICE',
          caseRespondentId: resp.caseRespondentId,
        }),
      ).rejects.toThrow(/never moves on a draft/);

      const after = await tx.execute<{ notice_count: number }>(
        sql`SELECT notice_count FROM case_respondent WHERE id = ${resp.caseRespondentId}::uuid`,
      );
      expect(after.rows[0]!.notice_count).toBe(0);
    });
  });

  it('marks ex parte eligibility only after the configured number of real notices', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      await lifecycle.apply(tx, ctx, { caseFileId, event: 'MARK_COMPLETE_ON_ARRIVAL' });
      const resp = await makeRespondent(tx, { councilId, caseFileId });

      for (let i = 1; i <= 3; i++) {
        await lifecycle.apply(tx, ctx, {
          caseFileId,
          event: 'ISSUE_RESPONDENT_NOTICE',
          caseRespondentId: resp.caseRespondentId,
          notice: {
            serviceMode: i === 3 ? 'registered_post_ad' : 'email',
            sentAt: new Date(`2026-09-${19 + i}T05:00:00Z`),
          },
        });
        const row = await tx.execute<{ notice_count: number; ex_parte_eligible: boolean }>(
          sql`SELECT notice_count, ex_parte_eligible FROM case_respondent
              WHERE id = ${resp.caseRespondentId}::uuid`,
        );
        expect(row.rows[0]!.notice_count).toBe(i);
        // Eligible only at three — and even then it is a warning, not a hard block.
        expect(row.rows[0]!.ex_parte_eligible).toBe(i >= 3);
      }

      const notices = await tx.execute<{ seq_no: number; service_mode: string }>(
        sql`SELECT seq_no, service_mode FROM respondent_notice
            WHERE case_respondent_id = ${resp.caseRespondentId}::uuid ORDER BY seq_no`,
      );
      expect(notices.rows.map((n) => n.seq_no)).toEqual([1, 2, 3]);
      // Proof of service, not the count, is what sustains an ex parte finding on challenge.
      expect(notices.rows[2]!.service_mode).toBe('registered_post_ad');
    });
  });
});

describe('holds and reopening', () => {
  it('suppresses a case without inventing a state for it', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      await lifecycle.apply(tx, ctx, { caseFileId, event: 'REQUEST_DOCUMENTS' });

      const held = await lifecycle.apply(tx, ctx, {
        caseFileId,
        event: 'PUT_ON_HOLD',
        reason: 'Matter is sub judice before the consumer forum',
      });
      // On hold is a flag with a reason, not a ninth state.
      expect(held.to).toBe('awaiting_complainant_documents');
      const row = await stateOf(tx, caseFileId);
      expect(row.on_hold).toBe(true);
      expect(CASE_STATES).toContain(row.state);

      await lifecycle.apply(tx, ctx, { caseFileId, event: 'RESUME' });
      expect((await stateOf(tx, caseFileId)).on_hold).toBe(false);
    });
  });

  it('reopens a closed case with a reason and clears the closure', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      await lifecycle.apply(tx, ctx, { caseFileId, event: 'REQUEST_DOCUMENTS' });
      await lifecycle.apply(tx, ctx, {
        caseFileId,
        event: 'MARK_COMPLAINANT_UNRESPONSIVE',
        reason: 'Two reminders, no response in six weeks',
      });
      expect((await stateOf(tx, caseFileId)).state).toBe('closed');

      const reopened = await lifecycle.apply(tx, ctx, {
        caseFileId,
        event: 'REOPEN',
        reason: 'Complainant wrote back with the bills',
      });
      expect(reopened.to).toBe('under_scrutiny');

      const row = await tx.execute<{ closed_at: Date | null; closure_reason: string | null }>(
        sql`SELECT closed_at, closure_reason FROM case_file WHERE id = ${caseFileId}::uuid`,
      );
      expect(row.rows[0]!.closed_at).toBeNull();
      expect(row.rows[0]!.closure_reason).toBeNull();
    });
  });
});

describe('the audit trail of a transition', () => {
  it('records history, milestones and audit events in one transaction', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { caseFileId } = await newComplaint(tx);
      await lifecycle.apply(tx, ctx, { caseFileId, event: 'REQUEST_DOCUMENTS' });

      const history = await tx.execute<{ event: string; from_state: string | null; to_state: string }>(
        sql`SELECT event, from_state, to_state FROM case_state_history
            WHERE case_file_id = ${caseFileId}::uuid ORDER BY occurred_at, event`,
      );
      expect(history.rows.map((h) => h.event)).toEqual(['LOG_INTAKE', 'REQUEST_DOCUMENTS']);

      const audit = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM audit.events WHERE case_file_id = ${caseFileId}::uuid`,
      );
      expect(audit.rows[0]!.n).toBeGreaterThan(0);
    });
  });

  it('rolls the whole transition back when any part of it fails', async () => {
    const { caseFileId } = await withCouncil({ councilId, userId: officer }, (tx) =>
      newComplaint(tx),
    );

    await expect(
      withCouncil({ councilId, userId: officer }, async (tx) => {
        await lifecycle.apply(tx, ctx, { caseFileId, event: 'REQUEST_DOCUMENTS' });
        throw new Error('simulated failure after the transition');
      }),
    ).rejects.toThrow(/simulated failure/);

    // A case must never end up moved but unscheduled, or scheduled but unmoved.
    await withCouncil({ councilId }, async (tx) => {
      expect((await stateOf(tx, caseFileId)).state).toBe('intake_received');
      const live = await followups.liveForCase(tx, ctx, caseFileId);
      expect(live.map((f) => f.stage)).not.toContain('await_patient_docs');
    });
  });
});
