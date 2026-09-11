import { sql } from 'drizzle-orm';
import type { CaseState } from '@ksdc/contracts';
import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth<{ id: string }>(async ({ params, tx, ctx, services }) => {
  const { id } = params;

  const caseRows = await tx.execute<{ state: CaseState }>(
    sql`SELECT * FROM case_file WHERE id = ${id}::uuid`,
  );
  const row = caseRows.rows[0];
  if (!row) return { case: null };

  // One call feeds the whole page. A case detail screen that fires six requests is
  // six chances to render half a case, and the officer reads this screen before
  // deciding what to do next.
  const [parties, respondents, milestones, history, letters, documents, followups] =
    await Promise.all([
      tx.execute(sql`
        SELECT cp.role, p.full_name, p.mobile, p.email, p.age_years, p.sex
        FROM case_party cp JOIN party p ON p.id = cp.party_id
        WHERE cp.case_file_id = ${id}::uuid ORDER BY cp.role`),
      tx.execute(sql`
        SELECT cr.id, p.full_name, cr.notice_state, cr.notice_count,
               cr.ex_parte_eligible, cr.ex_parte_at, cr.dropped_at,
               rd.registration_no, rd.clinic_name,
               (SELECT max(rn.sent_at) FROM respondent_notice rn
                 WHERE rn.case_respondent_id = cr.id) AS last_notice_at,
               (SELECT max(rn.reply_received_at) FROM respondent_notice rn
                 WHERE rn.case_respondent_id = cr.id) AS replied_at
        FROM case_respondent cr
        JOIN case_party cp ON cp.id = cr.case_party_id
        JOIN party p ON p.id = cp.party_id
        LEFT JOIN registered_dentist rd ON rd.id = p.registered_dentist_id
        WHERE cr.case_file_id = ${id}::uuid ORDER BY p.full_name`),
      tx.execute(sql`
        SELECT milestone, occurred_at, date_source, note
        FROM case_milestone WHERE case_file_id = ${id}::uuid ORDER BY occurred_at`),
      tx.execute(sql`
        SELECT event, from_state, to_state, reason, occurred_at, is_system
        FROM case_state_history WHERE case_file_id = ${id}::uuid ORDER BY occurred_at`),
      tx.execute(sql`
        SELECT id, kind, direction, subject, to_name, from_email, sent_at, received_at,
               despatch_no, despatch_date, created_at
        FROM correspondence WHERE case_file_id = ${id}::uuid
        ORDER BY coalesce(sent_at, received_at, created_at)`),
      services.documents.listForCase(tx, ctx, id),
      services.followups.liveForCase(tx, ctx, id),
    ]);

  return {
    case: row,
    parties: parties.rows,
    respondents: respondents.rows,
    milestones: milestones.rows,
    history: history.rows,
    letters: letters.rows,
    documents,
    followups,
    // Drives every button on every client, so no UI re-implements a guard.
    availableEvents: services.lifecycle.availableFor(row.state, ctx),
  };
});
