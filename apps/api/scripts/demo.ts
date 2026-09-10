/**
 * Example cases, created through the real services so they carry the same follow-ups,
 * milestones, history and audit entries that live data would.
 *
 * Every name here is invented. The council row is synthetic and the API refuses to create
 * production data until the four authorisation artefacts exist, so this cannot be
 * mistaken for the register.
 *
 *   DATABASE_URL=... pnpm --filter @ksdc/api demo
 */
import { closeDb, initDb, withCouncil, type Tx } from '@ksdc/db';
import { sql } from 'drizzle-orm';
import { KSDC_CONFIG } from '@ksdc/config';
import { FollowupService, type EngineContext } from '../src/modules/followups/followup.service.js';
import { CaseIntakeService } from '../src/modules/cases/case-intake.service.js';
import { CaseLifecycleService } from '../src/modules/cases/case-lifecycle.service.js';

const COUNCIL_ID = process.env.DEMO_COUNCIL_ID ?? '0197f9c2-0000-4000-8000-000000000001';
const OFFICER_ID = process.env.DEMO_USER_ID ?? '0197f9c2-0000-4000-8000-000000000002';

const followups = new FollowupService();
const intake = new CaseIntakeService(followups);
const lifecycle = new CaseLifecycleService(followups);
const ctx: EngineContext = { councilId: COUNCIL_ID, userId: OFFICER_ID, config: KSDC_CONFIG };

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

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

    // Run the engine forward day by day, exactly as the scheduler would have, so each
    // ladder sits wherever its own dates put it rather than all landing on a proposal.
    for (let d = 64; d >= 0; d--) {
      await followups.tick(tx, ctx, daysAgo(d));
    }
    await followups.sweepNoNextStep(tx, ctx);
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
