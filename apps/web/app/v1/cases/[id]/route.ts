import { sql } from 'drizzle-orm';
import type { CaseState } from '@ksdc/contracts';
import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth<{ id: string }>(async ({ params, tx, ctx, services }) => {
  const { id } = params;

  // A case cancelled as opened in error is returned like any other - it is on no list, but
  // a direct link must still open it and explain itself. deleted_at, deletion_reason and
  // deleted_by come with the *; the name is resolved here so the banner can say who,
  // rather than printing a uuid. Name first, email when an account has no name yet.
  const caseRows = await tx.execute<{ state: CaseState; deleted_at: Date | null }>(sql`
    SELECT c.*, coalesce(nullif(btrim(u.full_name), ''), u.email) AS deleted_by_name
    FROM case_file c
    LEFT JOIN app_user u ON u.id = c.deleted_by
    WHERE c.id = ${id}::uuid`);
  const row = caseRows.rows[0];
  if (!row) return { case: null };

  // One call feeds the whole page. A case detail screen that fires six requests is
  // six chances to render half a case, and the officer reads this screen before
  // deciding what to do next.
  const [parties, respondents, milestones, history, letters, mail, documents, followups] =
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
      // copy_emailed_at: when a copy of an outgoing letter reached the intake mailbox and was
      // filed against it - the proof of what was sent, shown beside the letter.
      tx.execute(sql`
        SELECT co.id, co.kind, co.direction, co.subject, co.body, co.to_name, co.from_email,
               co.sent_at, co.received_at, co.despatch_no, co.despatch_date, co.created_at,
               cm.id AS copy_mail_id, cm.emailed_at AS copy_emailed_at
        FROM correspondence co
        LEFT JOIN LATERAL (
          SELECT m.id, coalesce(m.original_date, m.envelope_date) AS emailed_at
          FROM mail_message m
          WHERE m.council_id = ${ctx.councilId}::uuid AND m.correspondence_id = co.id
            AND co.direction = 'out'::contact_direction
          ORDER BY m.ingested_at LIMIT 1
        ) cm ON true
        WHERE co.case_file_id = ${id}::uuid
        ORDER BY coalesce(co.sent_at, co.received_at, co.created_at)`),
      // The mail filed on this case: complaints and replies oldest first - so the first is
      // the complaint itself, in the complainant's own words - then any copies of the
      // Council's own letters, marked council_copy so the page never prints one as the
      // complaint. Without this the case file said who complained and about what in one
      // line, and the complaint was only readable in the tray.
      services.mail.mailForCase(tx, ctx, id),
      services.documents.listForCase(tx, ctx, id),
      services.followups.liveForCase(tx, ctx, id),
    ]);

  // Which RTI applications have asked about this case. Usually none. When there is one it
  // matters a great deal: it is the reason somebody outside the Council is entitled to see
  // part of this file, and it belongs where the officer is already looking.
  const rtiRequests = await services.rti.forCase(tx, ctx, id);

  // Files that came with this case's mail but have not reached the file store yet - kept,
  // and retried by the mail reader. Said on the case, because the officer is here and the
  // message page is not where anyone looks once a case is open.
  const held = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM mail_attachment a
    JOIN mail_message m ON m.id = a.mail_message_id
    WHERE m.case_file_id = ${id}::uuid AND a.staging_key IS NOT NULL AND a.document_id IS NULL`);

  return {
    case: row,
    parties: parties.rows,
    respondents: respondents.rows,
    milestones: milestones.rows,
    history: history.rows,
    letters: letters.rows,
    mail,
    heldAttachments: held.rows[0]?.n ?? 0,
    documents,
    followups,
    rtiRequests,
    // Drives every button on every client, so no UI re-implements a guard. None on a
    // cancelled case: the engine refuses every event on one (see case-guard), and a button
    // whose only outcome is a refusal is worse than no button.
    availableEvents: row.deleted_at ? [] : services.lifecycle.availableFor(row.state, ctx),
  };
});
