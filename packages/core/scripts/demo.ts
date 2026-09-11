/**
 * Example cases, created through the real services so they carry the same follow-ups,
 * milestones, history and audit entries that live data would.
 *
 * Every name here is invented. The council row is synthetic and the API refuses to create
 * production data until the four authorisation artefacts exist, so this cannot be
 * mistaken for the register.
 *
 *   DATABASE_URL=... pnpm --filter @ksdc/core demo
 */
import { closeDb, initDb, withCouncil, type Tx } from '@ksdc/db';
import { sql } from 'drizzle-orm';
import { KSDC_CONFIG } from '@ksdc/config';
import { FollowupService, type EngineContext } from '../src/modules/followups/followup.service.js';
import { CaseIntakeService } from '../src/modules/cases/case-intake.service.js';
import { CaseLifecycleService } from '../src/modules/cases/case-lifecycle.service.js';
import { RtiService } from '../src/modules/rti/rti.service.js';

const COUNCIL_ID = process.env.DEMO_COUNCIL_ID ?? '0197f9c2-0000-4000-8000-000000000001';
const OFFICER_ID = process.env.DEMO_USER_ID ?? '0197f9c2-0000-4000-8000-000000000002';

const followups = new FollowupService();
const intake = new CaseIntakeService(followups);
const lifecycle = new CaseLifecycleService(followups);
const rti = new RtiService();
const ctx: EngineContext = { councilId: COUNCIL_ID, userId: OFFICER_ID, config: KSDC_CONFIG };

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const isoDaysAgo = (n: number) => daysAgo(n).toISOString().slice(0, 10);

async function addRespondent(tx: Tx, caseFileId: string, name: string): Promise<string> {
  const partyId = crypto.randomUUID();
  const casePartyId = crypto.randomUUID();
  const caseRespondentId = crypto.randomUUID();
  await tx.execute(sql`
    INSERT INTO party (id, council_id, kind, full_name)
    VALUES (${partyId}::uuid, ${COUNCIL_ID}::uuid, 'person'::party_kind, ${name})`);
  await tx.execute(sql`
    INSERT INTO case_party (id, council_id, case_file_id, party_id, role)
    VALUES (${casePartyId}::uuid, ${COUNCIL_ID}::uuid, ${caseFileId}::uuid, ${partyId}::uuid,
            'respondent_dentist'::party_role)`);
  await tx.execute(sql`
    INSERT INTO case_respondent (id, council_id, case_file_id, case_party_id)
    VALUES (${caseRespondentId}::uuid, ${COUNCIL_ID}::uuid, ${caseFileId}::uuid, ${casePartyId}::uuid)`);
  return caseRespondentId;
}

async function main(): Promise<void> {
  initDb();

  await withCouncil({ councilId: COUNCIL_ID, userId: OFFICER_ID }, async (tx) => {
    // 1. Waiting on a complainant, a few days past the seven working days given.
    const a = await intake.create(tx, ctx, {
      summary: 'Crown fitted in June came off within a week; refitting refused',
      receivedAt: daysAgo(14),
      complainant: { fullName: 'Smt. Kavitha Devi', mobile: '9845012345', email: 'kdevi@example.in' },
    });
    await lifecycle.apply(tx, ctx, {
      caseFileId: a.caseFileId,
      event: 'REQUEST_DOCUMENTS',
      occurredAt: daysAgo(12),
    });

    // 2. Waiting on a dentist, badly overdue — the ladder will have run.
    const b = await intake.create(tx, ctx, {
      summary: 'Extraction of the wrong tooth; patient seeks reimbursement',
      receivedAt: daysAgo(64),
      complainant: { fullName: 'Sri Mahesh Iyer', mobile: '9880054321' },
    });
    await lifecycle.apply(tx, ctx, {
      caseFileId: b.caseFileId,
      event: 'MARK_COMPLETE_ON_ARRIVAL',
      occurredAt: daysAgo(62),
    });
    const bResp = await addRespondent(tx, b.caseFileId, 'Dr A. Rao');
    await lifecycle.apply(tx, ctx, {
      caseFileId: b.caseFileId,
      event: 'ISSUE_RESPONDENT_NOTICE',
      caseRespondentId: bResp,
      occurredAt: daysAgo(60),
      notice: { serviceMode: 'email', sentAt: daysAgo(60) },
    });

    // 3. Two respondents at a chain clinic; one replied, one is one reminder in.
    const c = await intake.create(tx, ctx, {
      summary: 'Implant failure at a chain clinic; two dentists treated the patient',
      receivedAt: daysAgo(26),
      complainant: { fullName: 'Sri Prakash Shetty', mobile: '9741100220' },
      patient: { fullName: 'Smt. Sharada Shetty', ageYears: 61, sex: 'F' },
    });
    await lifecycle.apply(tx, ctx, {
      caseFileId: c.caseFileId,
      event: 'MARK_COMPLETE_ON_ARRIVAL',
      occurredAt: daysAgo(24),
    });
    const c1 = await addRespondent(tx, c.caseFileId, 'Dr S. Kamath');
    const c2 = await addRespondent(tx, c.caseFileId, 'Dr N. Bhat');
    for (const r of [c1, c2]) {
      await lifecycle.apply(tx, ctx, {
        caseFileId: c.caseFileId,
        event: 'ISSUE_RESPONDENT_NOTICE',
        caseRespondentId: r,
        occurredAt: daysAgo(22),
        notice: { serviceMode: 'speed_post', sentAt: daysAgo(22) },
      });
    }
    await lifecycle.apply(tx, ctx, {
      caseFileId: c.caseFileId,
      event: 'RECORD_RESPONDENT_REPLY',
      caseRespondentId: c1,
      occurredAt: daysAgo(9),
    });

    // 4. On the officer's own desk, due this week.
    const d = await intake.create(tx, ctx, {
      summary: 'Complaint forwarded by the National Dental Council for our opinion',
      receivedAt: daysAgo(4),
      intakeSource: 'dci_ndc_forward',
      externalRefNo: 'NDC/EC/2026/1187',
      externalAuthorityName: 'National Dental Council',
      complainant: { fullName: 'Sri Rakesh Nair', mobile: '9611778899' },
    });
    void d;

    // 5. A case sitting quietly with nothing scheduled — the invariant sweep will flag it.
    const e = await intake.create(tx, ctx, {
      summary: 'Fees dispute after root canal treatment',
      receivedAt: daysAgo(34),
      complainant: { fullName: 'Smt. Latha Bai' },
    });
    const live = await followups.liveForCase(tx, ctx, e.caseFileId);
    for (const f of live) {
      await followups.dismiss(tx, ctx, {
        followUpId: f.id,
        reason: 'Demo: left with no next step so the invariant sweep has something to find',
      });
    }

    // 6. Snoozed, but it was already late: snoozing never moved the due date, so the
    // summary still counts it. The number cannot be made to disappear.
    const f = await intake.create(tx, ctx, {
      summary: 'Orthodontic treatment abandoned midway after clinic closed',
      receivedAt: daysAgo(30),
      complainant: { fullName: 'Kum. Anjali Rao', mobile: '9900112233' },
    });
    await lifecycle.apply(tx, ctx, {
      caseFileId: f.caseFileId,
      event: 'REQUEST_DOCUMENTS',
      occurredAt: daysAgo(28),
    });
    const fLive = await followups.liveForCase(tx, ctx, f.caseFileId);
    if (fLive[0]) {
      const until = new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10);
      await followups.snooze(tx, ctx, { followUpId: fLive[0].id, until });
    }

    // 7. Sub judice — suppressed, and must not appear on Today.
    const g = await intake.create(tx, ctx, {
      summary: 'Denture fit dispute; matter also before the consumer forum',
      receivedAt: daysAgo(20),
      complainant: { fullName: 'Sri Venkatesh Hegde' },
    });
    await lifecycle.apply(tx, ctx, {
      caseFileId: g.caseFileId,
      event: 'PUT_ON_HOLD',
      reason: 'Sub judice before the District Consumer Disputes Redressal Commission',
    });

    // ---- RTI ---------------------------------------------------------------
    //
    // Three applications, because there are three shapes and each one exercises a
    // different part of the module. Deliberately, NOBODY is recorded as Public
    // Information Officer or First Appellate Authority: that is a decision for the
    // Registrar, and until it is taken every refusal this council issues is defective
    // under s.7(8)(iii). The screens say so, which is the point of leaving it undone.

    // 8. The ordinary one. Halfway through the thirty days, asking about a real case.
    const rtiA = await rti.receive(
      tx,
      ctx,
      {
        receivedOn: isoDaysAgo(16),
        receivedVia: 'email',
        applicantName: 'Sri M. Basavaraj',
        applicantAddressLines: ['No. 44, 2nd Main', 'Vijayanagar', 'Bengaluru 560040'],
        applicantEmail: 'mbasavaraj@example.in',
        requestText:
          'Under the RTI Act 2005, kindly furnish:\n' +
          '1. The total number of complaints received by the Council against registered ' +
          'dentists during the financial year 2025-26.\n' +
          '2. The number of such complaints in which any action was taken, and the nature ' +
          'of the action.\n' +
          '3. A copy of the procedure followed by the Council on receiving a complaint.',
        applicationFeeReceived: true,
        caseFileIds: [a.caseFileId],
      },
      new Date(),
    );

    // 9. Late, decided, not yet despatched. Shows the deemed refusal, the s.20 exposure,
    //    and a refusal composer that will not let it out of the door while the appellate
    //    authority is unrecorded.
    const rtiB = await rti.receive(
      tx,
      ctx,
      {
        receivedOn: isoDaysAgo(41),
        receivedVia: 'post',
        applicantName: 'Smt. R. Lakshmi',
        applicantAddressLines: ['Door No. 9, Shivaji Nagar', 'Mysuru 570001'],
        requestText:
          'Please provide certified copies of the complaint filed against my dentist, the ' +
          'explanation submitted by him, and the expert opinion obtained by the Council, ' +
          'together with the case papers in full.',
        applicationFeeReceived: true,
        externalRefNo: 'RPAD 4471',
      },
      new Date(),
    );
    await rti.decide(
      tx,
      ctx,
      {
        rtiRequestId: rtiB.rtiRequestId,
        decision: 'partly_supplied',
        decidedOn: isoDaysAgo(2),
        reasons:
          'The procedure followed by the Council on receiving a complaint is furnished. ' +
          'The case papers themselves are withheld for the reasons given below.',
        exemptions: [
          {
            section: 's8_1_j',
            appliesTo: 'the complaint, the explanation and the expert opinion',
            reasoning:
              'The papers sought are the treatment history of an identified patient and ' +
              'the conduct of an identified dentist. Clause (j) of section 8(1), as ' +
              'substituted with effect from 13 November 2025, exempts information which ' +
              'relates to personal information.',
          },
        ],
      },
      new Date(),
    );

    // 10. The collision. Section 11 was triggered, the notice went out late, and the
    //     acknowledgement card puts the third party's ten days past the forty-day
    //     deadline - which no amount of diligence can now fix, and which the officer has
    //     to see rather than discover.
    const rtiC = await rti.receive(
      tx,
      ctx,
      {
        receivedOn: isoDaysAgo(33),
        receivedVia: 'email',
        applicantName: 'Sri Anil Kumar',
        applicantEmail: 'anilk@example.in',
        requestText:
          'Furnish a copy of the written explanation submitted to the Council by Dr S. ' +
          'Ramesh in the complaint filed against him in 2025, along with the Council\u2019s ' +
          'correspondence with him.',
        applicationFeeReceived: true,
      },
      new Date(),
    );
    await rti.intendToDiscloseThirdParty(
      tx,
      ctx,
      {
        rtiRequestId: rtiC.rtiRequestId,
        thirdPartyName: 'Dr S. Ramesh',
        decidedOn: isoDaysAgo(24),
      },
      new Date(),
    );
    await rti.recordThirdPartyNotice(
      tx,
      ctx,
      {
        rtiRequestId: rtiC.rtiRequestId,
        sentOn: isoDaysAgo(4),
        receivedOn: isoDaysAgo(1),
      },
      new Date(),
    );

    // Run the engine forward day by day, exactly as the scheduler would have, so each
    // ladder sits wherever its own dates put it rather than all landing on a proposal.
    for (let d = 64; d >= 0; d--) {
      await followups.tick(tx, ctx, daysAgo(d));
    }
    await followups.sweepNoNextStep(tx, ctx);

    console.log(`  RTI ${rtiA.rtiNo} - ordinary, mid-clock, linked to a case`);
    console.log(`  RTI ${rtiB.rtiNo} - past the thirty days, decided, not yet despatched`);
    console.log(`  RTI ${rtiC.rtiNo} - s.11 consultation, windows colliding`);
  });

  // Record a successful tick so the Today banner reflects a system that is actually
  // running, rather than the never-run state a fresh database starts in.
  await withCouncil({ councilId: COUNCIL_ID }, (tx) =>
    tx.execute(sql`
      INSERT INTO job_run (job_name, logical_date, status, finished_at)
      VALUES ('daily', current_date, 'ok', now())
      ON CONFLICT (job_name, logical_date)
      DO UPDATE SET status = 'ok', finished_at = now()
    `),
  );

  console.log('✓ demo cases created');
  await closeDb();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb().catch(() => {});
  process.exit(1);
});
