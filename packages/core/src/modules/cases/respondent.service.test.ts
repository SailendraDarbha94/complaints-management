import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, initDb, withCouncil, type Db, type Tx } from '@ksdc/db';
import { KSDC_CONFIG, type CouncilConfig } from '@ksdc/config';
import { CaseIntakeService } from './case-intake.service.js';
import { CaseLifecycleService } from './case-lifecycle.service.js';
import { RespondentService } from './respondent.service.js';
import { FollowupService, type EngineContext } from '../followups/followup.service.js';
import { seedCouncilAndOfficer } from '../../test-support/fixtures.js';

/**
 * Naming the dentist a complaint is about.
 *
 * The behaviour every test here defends: this service never silently merges two people.
 * A respondent's history is what makes "the third complaint against this dentist" visible
 * to a committee — and two dentists genuinely share a name, so joining them on one is a
 * decision the officer takes and can see themselves taking.
 */

let db: Db;
const councilId = 'd0e11111-1111-4111-8111-111111111111';
const officer = 'd0e22222-2222-4222-8222-222222222222';

const followups = new FollowupService();
const lifecycle = new CaseLifecycleService(followups);
const intake = new CaseIntakeService(followups);
const respondents = new RespondentService();

const config: CouncilConfig = KSDC_CONFIG;
const ctx: EngineContext = { councilId, userId: officer, config };

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId }, (tx) =>
    seedCouncilAndOfficer(tx, { councilId, officerId: officer, code: 'RSKS' }),
  );
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await withCouncil({ councilId }, async (tx) => {
    await tx.execute(sql`UPDATE follow_up SET status = 'cancelled', resolution_note = 'reset'
                         WHERE council_id = ${councilId}::uuid AND status IN ('open','snoozed')`);
    await tx.execute(sql`UPDATE case_file SET state = 'closed', closed_at = now(),
                           closure_reason = 'withdrawn'
                         WHERE council_id = ${councilId}::uuid AND state <> 'closed'`);
  });
});

let n = 0;
const newCase = (tx: Tx) =>
  intake.create(tx, ctx, {
    summary: `Complaint ${++n}`,
    receivedAt: new Date('2026-09-01T04:00:00Z'),
    complainant: { fullName: `Complainant ${n}` },
  });

describe('naming a dentist', () => {
  it('creates the person, their role on the case, and their own notice ladder', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      const added = await respondents.add(tx, ctx, {
        caseFileId: c.caseFileId,
        fullName: 'Dr N. Bhat',
        registrationNo: 'KA-11234',
        email: 'Dr.Bhat@Example.IN',
        mobile: '+91 98450 12345',
      });

      expect(added.fullName).toBe('Dr N. Bhat');

      const row = await tx.execute<{
        role: string;
        notice_state: string;
        notice_count: number;
        email: string;
        mobile_normalised: string;
      }>(sql`
        SELECT cp.role::text AS role, cr.notice_state::text AS notice_state, cr.notice_count,
               p.email, p.mobile_normalised
        FROM case_respondent cr
        JOIN case_party cp ON cp.id = cr.case_party_id
        JOIN party p ON p.id = cp.party_id
        WHERE cr.id = ${added.caseRespondentId}::uuid
      `);
      const r = row.rows[0]!;
      expect(r.role).toBe('respondent_dentist');
      expect(r.notice_state).toBe('not_issued');
      expect(r.notice_count).toBe(0);
      // Lower-cased, so the inward-mail matcher can find them by sender.
      expect(r.email).toBe('dr.bhat@example.in');
      // Digits only, the same normalisation intake uses.
      expect(r.mobile_normalised).toBe('919845012345');
    });
  });

  it('does NOT move the case or start a clock — naming is not serving', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      const before = await followups.liveForCase(tx, ctx, c.caseFileId);

      await respondents.add(tx, ctx, { caseFileId: c.caseFileId, fullName: 'Dr A' });

      const state = await tx.execute<{ state: string }>(
        sql`SELECT state::text FROM case_file WHERE id = ${c.caseFileId}::uuid`,
      );
      // The case moves when a notice is DESPATCHED and confirmed, not when a name is typed.
      expect(state.rows[0]!.state).toBe('intake_received');
      const after = await followups.liveForCase(tx, ctx, c.caseFileId);
      expect(after).toHaveLength(before.length);
    });
  });

  it('refuses a dentist with no name — it goes on the notice', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      await expect(
        respondents.add(tx, ctx, { caseFileId: c.caseFileId, fullName: '   ' }),
      ).rejects.toThrow(/name is needed/i);
    });
  });

  it('refuses to name the same dentist twice on one case', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      const first = await respondents.add(tx, ctx, {
        caseFileId: c.caseFileId,
        fullName: 'Dr Twice',
      });
      await expect(
        respondents.add(tx, ctx, { caseFileId: c.caseFileId, partyId: first.partyId }),
      ).rejects.toThrow(/already named on this case/i);
    });
  });

  it('refuses to name anyone on a CLOSED case', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      await tx.execute(sql`
        UPDATE case_file SET state = 'closed', closed_at = now(), closure_reason = 'withdrawn'
        WHERE id = ${c.caseFileId}::uuid
      `);
      await expect(
        respondents.add(tx, ctx, { caseFileId: c.caseFileId, fullName: 'Dr Late' }),
      ).rejects.toThrow(/closed/i);
    });
  });

  it('takes an establishment as well as a person', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      const added = await respondents.add(tx, ctx, {
        caseFileId: c.caseFileId,
        fullName: 'Smile Dental Chain Pvt Ltd',
        isEstablishment: true,
      });
      const row = await tx.execute<{ role: string; kind: string }>(sql`
        SELECT cp.role::text AS role, p.kind::text AS kind
        FROM case_respondent cr JOIN case_party cp ON cp.id = cr.case_party_id
        JOIN party p ON p.id = cp.party_id WHERE cr.id = ${added.caseRespondentId}::uuid
      `);
      expect(row.rows[0]!.role).toBe('respondent_establishment');
      expect(row.rows[0]!.kind).toBe('organisation');
    });
  });
});

describe('the same dentist on a second complaint', () => {
  it('is offered as a suggestion, with the history that makes it worth picking', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const first = await newCase(tx);
      await respondents.add(tx, ctx, { caseFileId: first.caseFileId, fullName: 'Dr Searchable' });

      const found = await respondents.search(tx, ctx, 'Searchable');
      expect(found).toHaveLength(1);
      expect(found[0]!.fullName).toBe('Dr Searchable');
      expect(found[0]!.priorCases).toBe(1);
      // Named, not counted. Two dentists sharing a name both read "named on one other
      // case" and the officer cannot tell which is which - which turns the safeguard
      // against merging them into a coin toss.
      expect(found[0]!.priorCaseNumbers).toEqual([first.caseNumber]);
      expect(found[0]!.because).toContain(first.caseNumber);
    });
  });

  it('joins the history up when the officer picks them', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const a = await newCase(tx);
      const b = await newCase(tx);
      const first = await respondents.add(tx, ctx, {
        caseFileId: a.caseFileId,
        fullName: 'Dr Repeat',
      });
      const second = await respondents.add(tx, ctx, {
        caseFileId: b.caseFileId,
        partyId: first.partyId,
      });

      // One person, two cases - which is what makes "the second complaint against this
      // dentist" a thing the register can say.
      expect(second.partyId).toBe(first.partyId);
      const found = await respondents.search(tx, ctx, 'Repeat');
      expect(found[0]!.priorCases).toBe(2);
      expect(found[0]!.priorCaseNumbers).toEqual([b.caseNumber, a.caseNumber]);
    });
  });

  it('does not merge two people who happen to share a name', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const a = await newCase(tx);
      const b = await newCase(tx);
      const one = await respondents.add(tx, ctx, { caseFileId: a.caseFileId, fullName: 'Dr Common' });
      // The officer did NOT pick the suggestion, so this is a different person with the
      // same name. Merging them would put one dentist's notice history in front of a
      // committee deciding about the other.
      const two = await respondents.add(tx, ctx, { caseFileId: b.caseFileId, fullName: 'Dr Common' });
      expect(two.partyId).not.toBe(one.partyId);
    });
  });
});

describe('the registration number', () => {
  it('refuses a second record for a number the register already holds', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      // A registration number is unique in the Council's own register by definition, so
      // the same number IS the same dentist - the one case where joining is a fact.
      await tx.execute(sql`
        INSERT INTO registered_dentist (council_id, registration_no, full_name)
        VALUES (${councilId}::uuid, 'KA-99001', 'Dr Registered')
      `);
      const a = await newCase(tx);
      const b = await newCase(tx);
      await respondents.add(tx, ctx, {
        caseFileId: a.caseFileId,
        fullName: 'Dr Registered',
        registrationNo: 'KA-99001',
      });
      await expect(
        respondents.add(tx, ctx, {
          caseFileId: b.caseFileId,
          fullName: 'Dr Registered Typed Differently',
          registrationNo: 'KA-99001',
        }),
      ).rejects.toThrow(/already held by Dr Registered/i);
    });
  });

  it('links the party to the register when the number is known there', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      await tx.execute(sql`
        INSERT INTO registered_dentist (council_id, registration_no, full_name, clinic_name)
        VALUES (${councilId}::uuid, 'KA-99002', 'Dr Linked', 'Linked Dental Care')
      `);
      const c = await newCase(tx);
      const added = await respondents.add(tx, ctx, {
        caseFileId: c.caseFileId,
        fullName: 'Dr Linked',
        registrationNo: 'KA-99002',
      });

      const row = await tx.execute<{ registration_no: string; clinic_name: string }>(sql`
        SELECT rd.registration_no, rd.clinic_name
        FROM party p JOIN registered_dentist rd ON rd.id = p.registered_dentist_id
        WHERE p.id = ${added.partyId}::uuid
      `);
      expect(row.rows[0]!.registration_no).toBe('KA-99002');
      // And the clinic comes from the register rather than being re-typed.
      expect(row.rows[0]!.clinic_name).toBe('Linked Dental Care');
    });
  });

  it('offers a dentist from the register who has never been a respondent', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      await tx.execute(sql`
        INSERT INTO registered_dentist (council_id, registration_no, full_name)
        VALUES (${councilId}::uuid, 'KA-99003', 'Dr Neverseen')
      `);
      const found = await respondents.search(tx, ctx, 'Neverseen');
      expect(found).toHaveLength(1);
      expect(found[0]!.because).toMatch(/register of dentists/);
      expect(found[0]!.partyId).toBe('');
    });
  });
});

describe('what naming a dentist unlocks', () => {
  it('lets the notice ladder run, which was unreachable before', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      await lifecycle.apply(tx, ctx, { caseFileId: c.caseFileId, event: 'REQUEST_DOCUMENTS' });
      await lifecycle.apply(tx, ctx, { caseFileId: c.caseFileId, event: 'DOCUMENTS_RECEIVED' });

      const added = await respondents.add(tx, ctx, {
        caseFileId: c.caseFileId,
        fullName: 'Dr Noticed',
      });

      const out = await lifecycle.apply(tx, ctx, {
        caseFileId: c.caseFileId,
        event: 'ISSUE_RESPONDENT_NOTICE',
        caseRespondentId: added.caseRespondentId,
        notice: { serviceMode: 'registered_post_ad', sentAt: new Date('2026-09-10T04:00:00Z') },
      });

      expect(out.to).toBe('awaiting_respondent_reply');
      const r = await tx.execute<{ notice_count: number; notice_state: string }>(sql`
        SELECT notice_count, notice_state::text AS notice_state FROM case_respondent
        WHERE id = ${added.caseRespondentId}::uuid
      `);
      expect(r.rows[0]!.notice_count).toBe(1);
      expect(r.rows[0]!.notice_state).toBe('awaiting_reply');
    });
  });
});
