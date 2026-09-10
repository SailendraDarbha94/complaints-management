import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, initDb, withCouncil, type Db, type Tx } from '@ksdc/db';
import { KSDC_CONFIG } from '@ksdc/config';
import { BLANK, parseCaseNumber } from '@ksdc/contracts';
import { FollowupService, type EngineContext } from '../followups/followup.service.js';
import { CaseIntakeService } from '../cases/case-intake.service.js';
import { CaseLifecycleService } from '../cases/case-lifecycle.service.js';
import { CorrespondenceService } from './correspondence.service.js';
import { makeRespondent, seedCouncilAndOfficer } from '../../test-support/fixtures.js';

/**
 * The draft composer. Phase 1 sends nothing: it produces a letter the officer copies into
 * council webmail, and records what went out when they confirm it. That confirmation is
 * the click that starts the clock.
 */

let db: Db;
const councilId = '50505050-5050-4505-8505-505050505050';
const officerId = '60606060-6060-4606-8606-606060606060';

const followups = new FollowupService();
const intake = new CaseIntakeService(followups);
const lifecycle = new CaseLifecycleService(followups);
const correspondence = new CorrespondenceService(lifecycle, followups);
const ctx: EngineContext = { councilId, userId: officerId, config: KSDC_CONFIG };

const RECEIVED = new Date('2026-09-01T05:30:00Z');
const SENT = new Date('2026-09-10T06:00:00Z');

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId, userId: officerId }, async (tx) => {
    await seedCouncilAndOfficer(tx, { councilId, officerId, code: 'CORR' });
    await correspondence.seedTemplates(tx, ctx);
  });
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

async function newCase(tx: Tx, summary = 'Crown came off within a week') {
  return intake.create(tx, ctx, {
    summary,
    receivedAt: RECEIVED,
    complainant: {
      fullName: 'Smt. Kavitha Devi',
      mobile: '9845012345',
      email: 'kdevi@example.in',
    },
  });
}

describe('seeding the catalogue', () => {
  it('installs a template per kind, and never overwrites an edited one', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const again = await correspondence.seedTemplates(tx, ctx);
      // Already seeded in beforeAll. Once the officer has edited a letter, the shipped
      // wording is not the council's wording any more.
      expect(again).toBe(0);

      const count = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM template WHERE council_id = ${councilId}::uuid`,
      );
      expect(count.rows[0]!.n).toBeGreaterThan(10);
    });
  });
});

describe('drafting', () => {
  it('renders the document request with the case number and a real deadline', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const draft = await correspondence.draft(tx, ctx, {
        caseFileId: c.caseFileId,
        kind: 'request_docs',
        now: SENT,
      });

      expect(draft.subject).toContain(c.caseNumber);
      expect(draft.body).toContain(`Ref: Complaint No. ${c.caseNumber}`);
      expect(draft.body).toContain('Smt. Kavitha Devi');
      expect(draft.body).toContain('itemised bills'.replace('itemised', 'Itemised'));
      // Seven working days from Thursday 10 September is Friday the 18th.
      expect(draft.body).toContain('18 September 2026');
      expect(draft.to.email).toBe('kdevi@example.in');
    });
  });

  it('puts the reference token in the subject, because a reply carries nothing else back', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const draft = await correspondence.draft(tx, ctx, {
        caseFileId: c.caseFileId,
        kind: 'request_docs',
        now: SENT,
      });
      // Phase 1 sends by hand, so there is no outbound Message-ID. This token is the
      // only thread key that survives a copy-paste send.
      expect(parseCaseNumber(draft.subject)?.raw).toBe(c.caseNumber);
    });
  });

  it('leaves no blanks in a letter whose facts are all present', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const draft = await correspondence.draft(tx, ctx, {
        caseFileId: c.caseFileId,
        kind: 'request_docs',
        now: SENT,
      });
      expect(draft.body).not.toContain(BLANK);
    });
  });

  it('names the respondent and numbers the notice about to go out', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      await lifecycle.apply(tx, ctx, {
        caseFileId: c.caseFileId,
        event: 'MARK_COMPLETE_ON_ARRIVAL',
        occurredAt: RECEIVED,
      });
      const r = await makeRespondent(tx, {
        councilId,
        caseFileId: c.caseFileId,
        name: 'Dr A. Rao',
      });

      const draft = await correspondence.draft(tx, ctx, {
        caseFileId: c.caseFileId,
        kind: 'respondent_final_notice',
        caseRespondentId: r.caseRespondentId,
        now: SENT,
      });
      expect(draft.body).toContain('Dr A. Rao');
      // No notice has gone out yet, so the one being drafted is number 1.
      expect(draft.body).toContain('Notice No. 1');
      expect(draft.to.name).toBe('Dr A. Rao');
    });
  });

  it('snapshots the wording and the data that produced the letter', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const draft = await correspondence.draft(tx, ctx, {
        caseFileId: c.caseFileId,
        kind: 'request_docs',
        now: SENT,
      });

      const row = await tx.execute<{
        template_version_id: string;
        merge_context: { case: { number: string }; complainant: { name: string } };
      }>(sql`
        SELECT template_version_id, merge_context FROM correspondence
        WHERE id = ${draft.correspondenceId}::uuid
      `);
      // In 2031, about a 2026 letter: which wording, and which facts.
      expect(row.rows[0]!.template_version_id).toBe(draft.templateVersionId);
      expect(row.rows[0]!.merge_context.case.number).toBe(c.caseNumber);
      expect(row.rows[0]!.merge_context.complainant.name).toBe('Smt. Kavitha Devi');
    });
  });

  it('prints a pen-fillable blank where the despatch number goes', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const draft = await correspondence.draft(tx, ctx, {
        caseFileId: c.caseFileId,
        kind: 'expert_referral_letter',
        now: SENT,
      });
      const merge = await tx.execute<{ merge_context: { letter: { despatchRef: string } } }>(
        sql`SELECT merge_context FROM correspondence WHERE id = ${draft.correspondenceId}::uuid`,
      );
      // The office-wide book is not ours to number.
      expect(merge.rows[0]!.merge_context.letter.despatchRef).toBe('CORR/____/2026-27');
      expect(draft.requiresRegistrarSignature).toBe(true);
    });
  });

  it('lists the case documents for the officer to attach by hand', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const doc = await tx.execute<{ id: string }>(sql`
        INSERT INTO document (council_id, case_file_id, title, document_class)
        VALUES (${councilId}::uuid, ${c.caseFileId}::uuid, 'Treatment bill',
                'complaint_material'::document_class)
        RETURNING id
      `);
      const version = await tx.execute<{ id: string }>(sql`
        INSERT INTO document_version (council_id, document_id, version_no, storage_key,
                                      original_filename, mime_type, size_bytes, sha256)
        VALUES (${councilId}::uuid, ${doc.rows[0]!.id}::uuid, 1, ${crypto.randomUUID()},
                'bill.pdf', 'application/pdf', 1234, ${'a'.repeat(64)})
        RETURNING id
      `);
      await tx.execute(sql`
        UPDATE document SET current_version_id = ${version.rows[0]!.id}::uuid
        WHERE id = ${doc.rows[0]!.id}::uuid
      `);

      const draft = await correspondence.draft(tx, ctx, {
        caseFileId: c.caseFileId,
        kind: 'respondent_explanation_sought',
        now: SENT,
      });
      expect(draft.attachments.map((a) => a.filename)).toContain('bill.pdf');
    });
  });
});

describe('"I have sent this"', () => {
  it('starts the clock on the document request', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const draft = await correspondence.draft(tx, ctx, {
        caseFileId: c.caseFileId,
        kind: 'request_docs',
        now: SENT,
      });

      const before = await followups.liveForCase(tx, ctx, c.caseFileId);
      expect(before.map((f) => f.stage)).not.toContain('await_patient_docs');

      const result = await correspondence.markSent(tx, ctx, {
        correspondenceId: draft.correspondenceId,
        sentAt: SENT,
      });

      // Sending the letter IS the transition. One click, not two.
      expect(result.transitioned).toBe('REQUEST_DOCUMENTS');
      const after = await followups.liveForCase(tx, ctx, c.caseFileId);
      expect(after.map((f) => f.stage)).toContain('await_patient_docs');

      const state = await tx.execute<{ state: string }>(
        sql`SELECT state FROM case_file WHERE id = ${c.caseFileId}::uuid`,
      );
      expect(state.rows[0]!.state).toBe('awaiting_complainant_documents');
    });
  });

  it('moves the respondent notice counter, and records how it was served', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      await lifecycle.apply(tx, ctx, {
        caseFileId: c.caseFileId,
        event: 'MARK_COMPLETE_ON_ARRIVAL',
        occurredAt: RECEIVED,
      });
      const r = await makeRespondent(tx, { councilId, caseFileId: c.caseFileId });

      const draft = await correspondence.draft(tx, ctx, {
        caseFileId: c.caseFileId,
        kind: 'respondent_explanation_sought',
        caseRespondentId: r.caseRespondentId,
        now: SENT,
      });
      await correspondence.markSent(tx, ctx, {
        correspondenceId: draft.correspondenceId,
        sentAt: SENT,
        serviceMode: 'registered_post_ad',
        caseRespondentId: r.caseRespondentId,
      });

      const row = await tx.execute<{ notice_count: number }>(
        sql`SELECT notice_count FROM case_respondent WHERE id = ${r.caseRespondentId}::uuid`,
      );
      expect(row.rows[0]!.notice_count).toBe(1);

      const notice = await tx.execute<{ service_mode: string; correspondence_id: string }>(sql`
        SELECT service_mode, correspondence_id FROM respondent_notice
        WHERE case_respondent_id = ${r.caseRespondentId}::uuid
      `);
      // Proof of service, not the count, is what an ex parte finding rests on.
      expect(notice.rows[0]!.service_mode).toBe('registered_post_ad');
      expect(notice.rows[0]!.correspondence_id).toBe(draft.correspondenceId);
    });
  });

  it('refuses to record the same letter as sent twice', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const draft = await correspondence.draft(tx, ctx, {
        caseFileId: c.caseFileId,
        kind: 'request_docs',
        now: SENT,
      });
      await correspondence.markSent(tx, ctx, {
        correspondenceId: draft.correspondenceId,
        sentAt: SENT,
      });

      // Confirming twice would advance the notice ladder twice, and that count is the
      // basis of an ex parte finding against a named dentist.
      await expect(
        correspondence.markSent(tx, ctx, {
          correspondenceId: draft.correspondenceId,
          sentAt: SENT,
        }),
      ).rejects.toThrow(/already recorded as sent/i);
    });
  });

  it('does not transition anything for a mere acknowledgement', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const draft = await correspondence.draft(tx, ctx, {
        caseFileId: c.caseFileId,
        kind: 'ack_complaint',
        now: SENT,
      });
      const result = await correspondence.markSent(tx, ctx, {
        correspondenceId: draft.correspondenceId,
        sentAt: SENT,
      });
      expect(result.transitioned).toBeNull();
    });
  });
});

describe('the despatch number', () => {
  it('chases only the letters the office actually stamps', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);

      // A plain email is not stamped, so chasing a number for it would teach the officer
      // to dismiss the queue.
      const email = await correspondence.draft(tx, ctx, {
        caseFileId: c.caseFileId,
        kind: 'ack_complaint',
        now: SENT,
      });
      await correspondence.markSent(tx, ctx, {
        correspondenceId: email.correspondenceId,
        sentAt: SENT,
      });
      const afterEmail = await followups.liveForCase(tx, ctx, c.caseFileId);
      expect(afterEmail.map((f) => f.stage)).not.toContain('await_despatch_entry');
    });
  });

  it('records what the office stamped and closes the chase', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const draft = await correspondence.draft(tx, ctx, {
        caseFileId: c.caseFileId,
        kind: 'expert_referral_letter',
        now: SENT,
      });
      await tx.execute(sql`
        UPDATE case_file SET state = 'ready_for_committee' WHERE id = ${c.caseFileId}::uuid
      `);
      // Phase 3 wires REFER_TO_EXPERT; in Phase 1 the letter is recorded without it.
      await tx.execute(sql`
        UPDATE correspondence SET sent_at = ${SENT} WHERE id = ${draft.correspondenceId}::uuid
      `);
      await followups.open(
        tx,
        ctx,
        {
          stage: 'await_despatch_entry',
          caseFileId: c.caseFileId,
          waitingOnKind: 'council_officer',
          dedupeSuffix: draft.correspondenceId,
        },
        SENT,
      );

      await correspondence.recordDespatch(tx, ctx, {
        correspondenceId: draft.correspondenceId,
        despatchNo: 'CORR/297/2026-27',
        despatchDate: '2026-09-10',
        registerPage: 'p. 44',
      });

      const row = await tx.execute<{ despatch_no: string; despatch_date: string }>(sql`
        SELECT despatch_no, despatch_date FROM correspondence
        WHERE id = ${draft.correspondenceId}::uuid
      `);
      expect(row.rows[0]!.despatch_no).toBe('CORR/297/2026-27');

      const live = await followups.liveForCase(tx, ctx, c.caseFileId);
      expect(live.map((f) => f.stage)).not.toContain('await_despatch_entry');
    });
  });
});

describe('publishing a template', () => {
  it('rejects a field the letter cannot have, and says which fields it can', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      await expect(
        correspondence.publishTemplate(tx, ctx, {
          kind: 'request_docs',
          subject: 'x {{case.number}}',
          body: 'Quote the decision: {{decision.operativeText}}',
        }),
      ).rejects.toThrow(/cannot use decision.operativeText/);
    });
  });

  it('keeps the old version rather than editing it', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const { versionNo } = await correspondence.publishTemplate(tx, ctx, {
        kind: 'ack_complaint',
        subject: 'Received - {{case.number}}',
        body: 'Ref: Complaint No. {{case.number}}\n\nWe have your complaint.',
      });
      expect(versionNo).toBe(2);

      const versions = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM template_version tv
        JOIN template t ON t.id = tv.template_id
        WHERE t.council_id = ${councilId}::uuid AND t.kind = 'ack_complaint'
      `);
      // 2031, about a 2026 letter: the wording must still exist.
      expect(versions.rows[0]!.n).toBe(2);
    });
  });

  it('warns when the wording being changed is the terms of reference', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const { warnings } = await correspondence.publishTemplate(tx, ctx, {
        kind: 'expert_referral_letter',
        subject: 'Appointment of an Expert - {{patient.name}}',
        body: 'Ref: Complaint No. {{case.number}}\n\n{{expert.questions}}',
      });
      expect(warnings.join(' ')).toMatch(/terms of reference/i);
    });
  });
});
