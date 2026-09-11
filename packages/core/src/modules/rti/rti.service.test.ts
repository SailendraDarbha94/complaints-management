import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, initDb, withCouncil, type Db, type Tx } from '@ksdc/db';
import { KSDC_CONFIG, type CouncilConfig } from '@ksdc/config';
import { FollowupService, type EngineContext } from '../followups/followup.service.js';
import { QueueService } from '../followups/queue.service.js';
import { seedCouncilAndOfficer } from '../../test-support/fixtures.js';
import { predictDueOn } from './rti-clock.js';
import { RtiService } from './rti.service.js';

/**
 * The RTI register against a real database.
 *
 * Every test here corresponds to something in the Act rather than to something in the
 * code, because the code is only correct insofar as it matches the Act. The section
 * numbers are in the test names on purpose: in two years somebody will change one of these
 * behaviours, and the test should tell them what they are changing.
 */

let db: Db;
// A council of its own. Every test file in this package owns one, because they share a
// database and a council code collision is a debugging afternoon.
const councilId = 'b7010101-0101-4101-8101-010101010101';
const officer = 'b7020202-0202-4202-8202-020202020202';
const rti = new RtiService();
const followups = new FollowupService();
const queue = new QueueService();

const config: CouncilConfig = KSDC_CONFIG;
const ctx: EngineContext = { councilId, userId: officer, config };

/** Mid-morning IST on the given day, so `todayIn('Asia/Kolkata')` lands on that date. */
const at = (isoDate: string) => new Date(`${isoDate}T04:00:00Z`);

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId }, (tx) =>
    seedCouncilAndOfficer(tx, { councilId, officerId: officer, code: 'RTKS' }),
  );
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  // Nothing is ever deleted - the application role has no DELETE grant - so each test
  // retires the previous test's rows instead.
  await withCouncil({ councilId }, async (tx) => {
    await tx.execute(sql`UPDATE follow_up SET status = 'cancelled', resolution_note = 'test reset'
                         WHERE council_id = ${councilId}::uuid AND status IN ('open','snoozed')`);
    await tx.execute(sql`UPDATE rti_request SET closed_at = now(), state = 'closed',
                           closure_note = 'test reset'
                         WHERE council_id = ${councilId}::uuid AND closed_at IS NULL`);
    await tx.execute(sql`UPDATE council_office_holder SET ends_on = '2000-01-01'
                         WHERE council_id = ${councilId}::uuid
                           AND office LIKE 'rti_%' AND (ends_on IS NULL OR ends_on > '2000-01-01')`);
  });
});

const APPLICATION = {
  receivedOn: '2026-04-01',
  receivedVia: 'post' as const,
  applicantName: 'Mr S. Kumar',
  applicantAddressLines: ['12, 4th Cross', 'Jayanagar', 'Bengaluru 560011'],
  requestText:
    'Please furnish copies of all complaints received against Dr X during 2025-26, and the ' +
    'action taken on each.',
  applicationFeeReceived: true,
};

function receive(tx: Tx, overrides: Partial<typeof APPLICATION> & Record<string, unknown> = {}) {
  return rti.receive(tx, ctx, { ...APPLICATION, ...overrides }, at('2026-04-01'));
}

describe('receiving an application', () => {
  it('allocates an RTI number in its own series and starts the clock from the inward date', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await receive(tx);
      expect(out.rtiNo).toMatch(/^RTKS\/RTI\/2026-27\/\d{4}$/);
      // s.7(1): thirty days from the authority's receipt, not from the day it was typed in.
      expect(out.dueOn).toBe('2026-05-01');
    });
  });

  it('opens two timers: the wall on the statutory date, and the working task before it', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await receive(tx);
      const rows = await tx.execute<{ stage: string; due_on: string; is_statutory: boolean }>(sql`
        SELECT stage, due_on::text AS due_on, is_statutory FROM follow_up
        WHERE rti_request_id = ${out.rtiRequestId}::uuid AND status = 'open'
        ORDER BY due_on
      `);
      expect(rows.rows.map((r) => [r.stage, r.due_on, r.is_statutory])).toEqual([
        ['rti_prepare_reply', '2026-04-21', false],
        ['rti_reply_due', '2026-05-01', true],
      ]);
    });
  });

  it('refuses an application with no text, because the scope is what everything turns on', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      await expect(receive(tx, { requestText: '   ' })).rejects.toThrow(/own words/i);
    });
  });

  it('refuses a forty-eight-hour claim with no reasons for accepting it (proviso to s.7(1))', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      await expect(receive(tx, { lifeOrLiberty: true })).rejects.toThrow(/reasons for accepting/i);
    });
  });

  it('says so when an application is entered long after it arrived', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      // The postal application that sat in a tray. The clock ran the whole time.
      const out = await rti.receive(tx, ctx, APPLICATION, at('2026-04-20'));
      expect(out.warnings.join(' ')).toMatch(/received 19 days ago/i);
      expect(out.warnings.join(' ')).toMatch(/11 days remain/i);
    });
  });
});

describe('the deadline in the database and the deadline in the code', () => {
  // If these two ever disagree, one of them is lying to an officer about a date that costs
  // them Rs 250 a day. The generated column is the authority; this proves the TypeScript
  // mirror used by the tests and the planner still matches it.
  const cases = [
    { label: 'ordinary', patch: {} },
    { label: 'life or liberty', patch: { lifeOrLiberty: true, lifeOrLibertyReason: 'Stated risk' } },
  ];

  for (const c of cases) {
    it(`agree on a ${c.label} application`, async () => {
      await withCouncil({ councilId, userId: officer }, async (tx) => {
        const out = await receive(tx, c.patch);
        expect(out.dueOn).toBe(predictDueOn({ receivedOn: APPLICATION.receivedOn, ...c.patch }));
      });
    });
  }

  it('agree once s.11 is triggered and again once an excluded fee period closes', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);

      const fee = await rti.intimateFurtherFee(
        tx,
        ctx,
        { rtiRequestId, amount: 120, intimatedOn: '2026-04-05' },
        at('2026-04-05'),
      );
      expect(fee.dueOn).toBe('2026-05-01'); // unpaid: nothing excluded yet

      const paid = await rti.recordFeePaid(
        tx,
        ctx,
        { rtiRequestId, paidOn: '2026-04-12' },
        at('2026-04-12'),
      );
      expect(paid.excludedDays).toBe(7);
      expect(paid.dueOn).toBe('2026-05-08');
      expect(paid.dueOn).toBe(
        predictDueOn({
          receivedOn: '2026-04-01',
          furtherFeeIntimatedOn: '2026-04-05',
          furtherFeePaidOn: '2026-04-12',
        }),
      );

      const s11 = await rti.intendToDiscloseThirdParty(
        tx,
        ctx,
        { rtiRequestId, thirdPartyName: 'Dr X', decidedOn: '2026-04-13' },
        at('2026-04-13'),
      );
      expect(s11.dueOn).toBe('2026-05-18'); // 40 + the seven excluded days
      expect(s11.dueOn).toBe(
        predictDueOn({
          receivedOn: '2026-04-01',
          intendsToDiscloseThirdPartyOn: '2026-04-13',
          furtherFeeIntimatedOn: '2026-04-05',
          furtherFeePaidOn: '2026-04-12',
        }),
      );
    });
  });
});

describe('the fee (s.7(3)(a) and s.7(6))', () => {
  it('moves the statutory timer to the new date rather than editing the old row', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      await rti.intimateFurtherFee(
        tx,
        ctx,
        { rtiRequestId, amount: 120, intimatedOn: '2026-04-05' },
        at('2026-04-05'),
      );
      await rti.recordFeePaid(tx, ctx, { rtiRequestId, paidOn: '2026-04-12' }, at('2026-04-12'));

      const live = await tx.execute<{ stage: string; due_on: string }>(sql`
        SELECT stage, due_on::text AS due_on FROM follow_up
        WHERE rti_request_id = ${rtiRequestId}::uuid AND stage = 'rti_reply_due'
          AND status = 'open'
      `);
      expect(live.rows).toHaveLength(1);
      expect(live.rows[0]!.due_on).toBe('2026-05-08');

      // The superseded row is still there, so what the office believed and when is provable.
      const superseded = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM follow_up
        WHERE rti_request_id = ${rtiRequestId}::uuid AND status = 'superseded'
      `);
      expect(superseded.rows[0]!.n).toBeGreaterThan(0);
    });
  });

  it('refuses a fee demanded after the period has expired, because s.7(6) made it free', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      await expect(
        rti.intimateFurtherFee(
          tx,
          ctx,
          { rtiRequestId, amount: 120, intimatedOn: '2026-05-06' },
          at('2026-05-06'),
        ),
      ).rejects.toThrow(/free of any further charge|void/i);
    });
  });

  it('refuses any fee at all from an applicant below the poverty line', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx, { isBpl: true });
      await expect(
        rti.intimateFurtherFee(
          tx,
          ctx,
          { rtiRequestId, amount: 120, intimatedOn: '2026-04-05' },
          at('2026-04-05'),
        ),
      ).rejects.toThrow(/below the poverty line/i);
    });
  });
});

describe('section 11 is procedure, not a ground', () => {
  it('cannot be stored as a ground at all - the enum has no such value', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      await expect(
        tx.execute(sql`
          INSERT INTO rti_exemption_cited (council_id, rti_request_id, section, applies_to, reasoning)
          VALUES (${councilId}::uuid, ${rtiRequestId}::uuid, 's11', 'everything', 'third party')
        `),
      ).rejects.toThrow(/invalid input value for enum/i);
    });
  });

  it('will not let a notice go out before the intention to disclose is recorded', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      await expect(
        rti.recordThirdPartyNotice(tx, ctx, { rtiRequestId, sentOn: '2026-04-04' }),
      ).rejects.toThrow(/intention to disclose/i);
    });
  });

  it('warns that the ten days cannot be computed until the acknowledgement comes back', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      await rti.intendToDiscloseThirdParty(
        tx,
        ctx,
        { rtiRequestId, thirdPartyName: 'Dr X', decidedOn: '2026-04-03' },
        at('2026-04-03'),
      );
      const out = await rti.recordThirdPartyNotice(
        tx,
        ctx,
        { rtiRequestId, sentOn: '2026-04-04' },
        at('2026-04-04'),
      );
      expect(out.representationDueOn).toBeNull();
      expect(out.warnings.join(' ')).toMatch(/acknowledgement comes back/i);
    });
  });

  it('raises the collision alarm when their window closes after the forty days', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      await rti.intendToDiscloseThirdParty(
        tx,
        ctx,
        { rtiRequestId, thirdPartyName: 'Dr X', decidedOn: '2026-04-03' },
        at('2026-04-03'),
      );
      // Deadline is 11 May. The card comes back saying they received it on 5 May, so they
      // may object until 15 May - four days after the reply had to go out.
      const out = await rti.recordThirdPartyNotice(
        tx,
        ctx,
        { rtiRequestId, sentOn: '2026-04-30', receivedOn: '2026-05-05' },
        at('2026-05-06'),
      );
      expect(out.representationDueOn).toBe('2026-05-15');
      expect(out.warnings.join(' ')).toMatch(/AFTER the statutory deadline/);
    });
  });
});

describe('deciding', () => {
  it('refuses a refusal that names no section', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      await expect(
        rti.decide(tx, ctx, { rtiRequestId, decision: 'refused', decidedOn: '2026-04-20' }),
      ).rejects.toThrow(/only under section 8\(1\) or section 9/i);
    });
  });

  it('refuses a section cited with no reasons, because s.7(8)(i) asks for reasons', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      await expect(
        rti.decide(tx, ctx, {
          rtiRequestId,
          decision: 'refused',
          decidedOn: '2026-04-20',
          exemptions: [{ section: 's8_1_j', appliesTo: 'the whole request', reasoning: '  ' }],
        }),
      ).rejects.toThrow(/naming the clause is not a reason/i);
    });
  });

  it('refuses a ground on a decision that withholds nothing', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      await expect(
        rti.decide(tx, ctx, {
          rtiRequestId,
          decision: 'information_not_held',
          decidedOn: '2026-04-20',
          exemptions: [{ section: 's8_1_j', appliesTo: 'all', reasoning: 'personal information' }],
        }),
      ).rejects.toThrow(/withholds nothing/i);
    });
  });

  it('withdraws the earlier grounds rather than deleting them when the officer changes their mind', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      await rti.decide(tx, ctx, {
        rtiRequestId,
        decision: 'refused',
        decidedOn: '2026-04-20',
        exemptions: [{ section: 's8_1_e', appliesTo: 'all', reasoning: 'fiduciary' }],
      });
      await rti.decide(tx, ctx, {
        rtiRequestId,
        decision: 'refused',
        decidedOn: '2026-04-21',
        exemptions: [{ section: 's8_1_j', appliesTo: 'all', reasoning: 'personal information' }],
      });

      const all = await tx.execute<{ section: string; withdrawn: boolean }>(sql`
        SELECT section, (withdrawn_at IS NOT NULL) AS withdrawn FROM rti_exemption_cited
        WHERE rti_request_id = ${rtiRequestId}::uuid ORDER BY created_at
      `);
      expect(all.rows).toEqual([
        { section: 's8_1_e', withdrawn: true },
        { section: 's8_1_j', withdrawn: false },
      ]);
    });
  });
});

describe('the reply', () => {
  async function refused(tx: Tx) {
    const { rtiRequestId } = await receive(tx);
    await rti.decide(tx, ctx, {
      rtiRequestId,
      decision: 'refused',
      decidedOn: '2026-04-20',
      reasons: 'The records sought concern the treatment of an identified patient.',
      exemptions: [
        {
          section: 's8_1_j',
          appliesTo: 'the complaints and the action taken on each',
          reasoning:
            'The material sought is the treatment history of identified patients and the ' +
            'conduct of an identified dentist.',
        },
      ],
    });
    return rtiRequestId;
  }

  it('is defective while nobody has recorded a First Appellate Authority (s.7(8)(iii))', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const id = await refused(tx);
      const draft = await rti.composeReply(tx, ctx, { rtiRequestId: id }, at('2026-04-21'));
      expect(draft.defects.join(' ')).toMatch(/First Appellate Authority is recorded/i);
      expect(draft.defects.join(' ')).toMatch(/senior in rank/i);
      // The letter is still produced. An officer who cannot get one out of the system
      // writes it in Word, and then none of this exists.
      expect(draft.body).toMatch(/Section 8\(1\)\(j\)/);
    });
  });

  it('cannot be recorded as sent while it is defective', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const id = await refused(tx);
      await expect(
        rti.recordReplyDespatched(
          tx,
          ctx,
          { rtiRequestId: id, despatchedOn: '2026-04-22' },
          at('2026-04-22'),
        ),
      ).rejects.toThrow(/defective as it stands/i);
    });
  });

  it('carries all three things s.7(8) requires once the two offices are recorded', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      await rti.recordOfficeHolder(tx, ctx, {
        office: 'pio',
        fullName: 'Dr A. Officer',
        designation: 'Dental Officer and Public Information Officer',
        startsOn: '2026-04-01',
      });
      await rti.recordOfficeHolder(tx, ctx, {
        office: 'firstAppellateAuthority',
        fullName: 'Dr B. Registrar',
        designation: 'Registrar and First Appellate Authority',
        startsOn: '2026-04-01',
      });

      const id = await refused(tx);
      const draft = await rti.composeReply(tx, ctx, { rtiRequestId: id }, at('2026-04-21'));

      expect(draft.defects).toEqual([]);
      // (i) the reasons
      expect(draft.body).toMatch(/treatment history of identified patients/);
      // (ii) the period for an appeal
      expect(draft.body).toMatch(/within 30 days/);
      // (iii) the particulars of the appellate authority
      expect(draft.body).toMatch(/Dr B\. Registrar/);
      expect(draft.body).toMatch(/Registrar and First Appellate Authority/);
      // and the clause, in the words the Act now uses since 13 November 2025
      expect(draft.body).toMatch(/information which relates to personal information/);
      // the request itself, quoted, so the scope answered is on the face of the reply
      expect(draft.body).toMatch(/copies of all complaints received against Dr X/);
    });
  });

  it('tells the applicant the information is free where the reply is late (s.7(6))', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const id = await refused(tx);
      const draft = await rti.composeReply(tx, ctx, { rtiRequestId: id }, at('2026-05-20'));
      expect(draft.body).toMatch(/free of any further charge/);
    });
  });

  it('satisfies both timers on despatch, and states the exposure when it was late', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      await rti.recordOfficeHolder(tx, ctx, {
        office: 'pio',
        fullName: 'Dr A. Officer',
        startsOn: '2026-04-01',
      });
      await rti.recordOfficeHolder(tx, ctx, {
        office: 'firstAppellateAuthority',
        fullName: 'Dr B. Registrar',
        startsOn: '2026-04-01',
      });
      const id = await refused(tx);

      const out = await rti.recordReplyDespatched(
        tx,
        ctx,
        { rtiRequestId: id, despatchedOn: '2026-05-05' },
        at('2026-05-05'),
      );
      // Due 1 May, posted on the 5th: four days, at Rs 250 each.
      expect(out.warnings.join(' ')).toMatch(/Rs 1,000/);
      expect(out.warnings.join(' ')).toMatch(/burden of showing the officer acted reasonably/i);

      const open = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM follow_up
        WHERE rti_request_id = ${id}::uuid AND status IN ('open','snoozed')
      `);
      expect(open.rows[0]!.n).toBe(0);
    });
  });

  it('refuses to record a second despatch on the same application', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const id = await refused(tx);
      await rti.recordReplyDespatched(
        tx,
        ctx,
        { rtiRequestId: id, despatchedOn: '2026-04-22', force: { reason: 'Registrar directed' } },
        at('2026-04-22'),
      );
      await expect(
        rti.recordReplyDespatched(
          tx,
          ctx,
          { rtiRequestId: id, despatchedOn: '2026-04-23' },
          at('2026-04-23'),
        ),
      ).rejects.toThrow(/already recorded as despatched/i);
    });
  });
});

describe('the transfer (s.6(3))', () => {
  it('is recorded whatever the date, and says who now carries the delay', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      const out = await rti.transfer(tx, ctx, {
        rtiRequestId,
        toAuthority: 'Dental Council of India',
        transferredOn: '2026-04-15',
      });
      expect(out.warnings.join(' ')).toMatch(/expired on 2026-04-06/);
      expect(out.warnings.join(' ')).toMatch(/9 days late/);
      expect(out.warnings.join(' ')).toMatch(/remains the responsibility of this office/);
    });
  });

  it('will not record a transfer with no authority named', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      await expect(
        rti.transfer(tx, ctx, { rtiRequestId, toAuthority: ' ', transferredOn: '2026-04-03' }),
      ).rejects.toThrow(/name the authority/i);
    });
  });
});

describe('living in the same queue as everything else', () => {
  it('appears on Today with its RTI number and its statutory date', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await receive(tx);
      const today = await queue.today(tx, ctx, '2026-05-01');
      const item = today.byUrgency
        .flatMap((g) => g.items)
        .find((i) => i.stage === 'rti_reply_due');

      expect(item).toBeDefined();
      expect(item!.rtiNo).toBe(out.rtiNo);
      expect(item!.rtiDueOn).toBe('2026-05-01');
      expect(item!.caseNumber).toBeNull();
      expect(item!.isStatutory).toBe(true);
      expect(item!.urgency).toBe('due_today');
    });
  });

  it('cannot have its statutory deadline snoozed away', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      const row = await tx.execute<{ id: string }>(sql`
        SELECT id FROM follow_up WHERE rti_request_id = ${rtiRequestId}::uuid
          AND stage = 'rti_reply_due' AND status = 'open'
      `);
      await expect(
        followups.snooze(tx, ctx, { followUpId: row.rows[0]!.id, until: '2026-05-10' }),
      ).rejects.toThrow(/statutory deadline/i);
      // Up to the deadline is fine: the officer may push it to the morning of the wall.
      await followups.snooze(tx, ctx, { followUpId: row.rows[0]!.id, until: '2026-04-28' });
    });
  });

  it('drops out of the queue once the file is closed', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      await rti.close(tx, ctx, { rtiRequestId, note: 'Replied and no appeal within thirty days.' });
      const today = await queue.today(tx, ctx, '2026-05-01');
      expect(today.byUrgency.flatMap((g) => g.items).filter((i) => i.rtiNo)).toEqual([]);
    });
  });
});

describe('reading the register', () => {
  it('links to cases both ways, and most applications link to none', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = crypto.randomUUID();
      await tx.execute(sql`
        INSERT INTO case_file (id, council_id, case_number, fiscal_year, register_sl_no, summary)
        VALUES (${caseId}::uuid, ${councilId}::uuid, 'RTKS/COMP/2026-27/0007', '2026-27', 7,
                'A complaint the application asks about')
      `);
      const { rtiRequestId } = await receive(tx, { caseFileIds: [caseId] });

      const file = await rti.get(tx, ctx, rtiRequestId, at('2026-04-02'));
      expect(file!.cases.map((c) => c.case_number)).toEqual(['RTKS/COMP/2026-27/0007']);

      const fromCase = await rti.forCase(tx, ctx, caseId);
      expect(fromCase.map((r) => r.id)).toEqual([rtiRequestId]);
    });
  });

  it('fills the register’s "RTI refs." column, which shipped blank waiting for this table', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const caseId = crypto.randomUUID();
      await tx.execute(sql`
        INSERT INTO case_file (id, council_id, case_number, fiscal_year, register_sl_no, summary)
        VALUES (${caseId}::uuid, ${councilId}::uuid, 'RTKS/COMP/2026-27/0008', '2026-27', 8,
                'A case an application asks about')
      `);
      const out = await receive(tx, { caseFileIds: [caseId] });

      // The export is what an RTI reply is assembled from. A book that cannot say which
      // applications have already asked about a case answers the same one twice.
      const row = await tx.execute<{ refs: string | null }>(sql`
        SELECT "RTI refs." AS refs FROM v_case_register WHERE case_file_id = ${caseId}::uuid
      `);
      expect(row.rows[0]!.refs).toContain(out.rtiNo);
      expect(row.rows[0]!.refs).toContain('2026-04-01');
      expect(row.rows[0]!.refs).toContain('open');
    });
  });

  it('holds the applicant’s words exactly as they wrote them', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const { rtiRequestId } = await receive(tx);
      const file = await rti.get(tx, ctx, rtiRequestId, at('2026-04-02'));
      expect(file!.request.request_text).toBe(APPLICATION.requestText);
    });
  });
});
