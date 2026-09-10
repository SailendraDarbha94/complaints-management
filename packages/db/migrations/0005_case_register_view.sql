-- 0005_case_register_view.sql
--
-- The register: one row per case, the columns the officer asked us to propose.
--
-- security_invoker = true is the whole reason this is a migration worth reading.
--
-- A Postgres view runs as its OWNER by default. The owner here is the migration role,
-- which owns every table, so an ordinary view would evaluate the underlying tables
-- WITHOUT the querying session's row-level security -- and this view joins case_file,
-- party, case_respondent and correspondence. One council would read another's register
-- in full, through a view whose name suggests it is just a convenience.
--
-- With security_invoker the view is evaluated as the caller, so app.council_id applies
-- exactly as it does to a direct query. `pnpm --filter @ksdc/db test` asserts that.
--
-- Columns marked "Phase N" below are present and empty until that phase fills them. They
-- are in the view now so the register's shape is stable: the officer sees the whole book
-- from the start, and adding a column later is not a change to what they are used to.

CREATE OR REPLACE VIEW v_case_register
WITH (security_invoker = true)
AS
SELECT
  c.id                                               AS case_file_id,
  c.council_id,
  c.register_sl_no                                   AS "Sl. No.",
  c.case_number                                      AS "Case No.",
  to_char(m_received.occurred_at, 'YYYY-MM-DD')      AS "Date received",
  CASE c.case_kind
    WHEN 'patient_complaint' THEN 'Patient Complaint'
    WHEN 'ethics_notice'     THEN 'Ethical Violation'
  END                                                AS "Category",
  c.intake_source::text
    || coalesce(' / ' || c.external_authority_name, '')
    || coalesce(' / ' || c.external_ref_no, '')      AS "Source & external ref.",

  parties.complainant_name                           AS "Complainant",
  parties.complainant_contact                        AS "Complainant contact",
  parties.patient_name                               AS "Patient",
  parties.patient_particulars                        AS "Patient age/sex",
  respondents.names                                  AS "Respondent(s)",

  c.summary                                          AS "Nature of grievance",
  to_char(c.documents_complete_at, 'YYYY-MM-DD')     AS "Documents complete on",

  notices.notice_1                                   AS "Notice 1",
  notices.notice_2                                   AS "Notice 2",
  notices.notice_3                                   AS "Notice 3",
  notices.first_reply                                AS "Reply received on",

  sittings.heard_on                                  AS "Heard on",                  -- Phase 4
  referral.despatched_on                             AS "Expert referral despatched", -- Phase 3
  referral.report_on                                 AS "Expert report received",     -- Phase 3
  referral.shared_on                                 AS "Report shared with patient", -- Phase 3

  c.state::text                                      AS "Status",
  c.waiting_on::text                                 AS "Waiting on",
  CASE WHEN c.state = 'closed' THEN NULL
       ELSE (current_date - c.waiting_since::date) END AS "Days waiting",
  CASE WHEN c.on_hold THEN c.hold_reason END         AS "On hold",

  outcomes.per_respondent                            AS "Decision / outcome",         -- Phase 4
  to_char(m_order.occurred_at, 'YYYY-MM-DD')         AS "Order despatched on",        -- Phase 4
  m_order.despatch_no                                AS "Order despatch no.",         -- Phase 4

  to_char(c.closed_at, 'YYYY-MM-DD')                 AS "Closed on",
  c.closure_reason::text                             AS "Closure reason",

  custody.held                                       AS "Physical originals held",
  NULL::text                                         AS "RTI refs.",                  -- Phase 5
  officer.full_name                                  AS "Officer",
  c.remarks                                          AS "Remarks",

  -- Provenance. Anything other than 'recorded' means the date was reconstructed from the
  -- paper book or estimated, and every export has to say so: a reconstructed date must
  -- never become indistinguishable from a recorded fact in an RTI reply or a writ.
  c.is_backfilled                                    AS "Entered from the book",
  c.legacy_register_ref                              AS "Book reference",
  provenance.reconstructed                           AS "Dates reconstructed"

FROM case_file c

LEFT JOIN LATERAL (
  SELECT m.occurred_at FROM case_milestone m
  WHERE m.case_file_id = c.id AND m.milestone = 'received'
  ORDER BY m.occurred_at LIMIT 1
) m_received ON true

LEFT JOIN LATERAL (
  SELECT m.occurred_at, co.despatch_no
  FROM case_milestone m
  LEFT JOIN correspondence co ON co.id = m.ref_id
  WHERE m.case_file_id = c.id AND m.milestone = 'order_despatched'
  ORDER BY m.occurred_at DESC LIMIT 1
) m_order ON true

LEFT JOIN LATERAL (
  SELECT
    max(p.full_name)      FILTER (WHERE cp.role = 'complainant') AS complainant_name,
    max(coalesce(p.mobile, '') || coalesce(' / ' || p.email, ''))
                          FILTER (WHERE cp.role = 'complainant') AS complainant_contact,
    max(p.full_name)      FILTER (WHERE cp.role = 'patient')     AS patient_name,
    max(coalesce(p.age_years::text, '') || coalesce(' / ' || p.sex, ''))
                          FILTER (WHERE cp.role = 'patient')     AS patient_particulars
  FROM case_party cp JOIN party p ON p.id = cp.party_id
  WHERE cp.case_file_id = c.id
) parties ON true

LEFT JOIN LATERAL (
  SELECT string_agg(
           p.full_name
             || coalesce(' (' || rd.registration_no || ')', '')
             || coalesce(' - ' || rd.clinic_name, '')
             || CASE cr.notice_state
                  WHEN 'ex_parte' THEN ' [ex parte]'
                  WHEN 'dropped'  THEN ' [dropped]'
                  ELSE ''
                END,
           '; ' ORDER BY p.full_name) AS names
  FROM case_respondent cr
  JOIN case_party cp ON cp.id = cr.case_party_id
  JOIN party p ON p.id = cp.party_id
  LEFT JOIN registered_dentist rd ON rd.id = p.registered_dentist_id
  WHERE cr.case_file_id = c.id
) respondents ON true

LEFT JOIN LATERAL (
  SELECT
    max(to_char(rn.sent_at, 'YYYY-MM-DD') || coalesce(' / ' || co.despatch_no, ''))
      FILTER (WHERE rn.seq_no = 1) AS notice_1,
    max(to_char(rn.sent_at, 'YYYY-MM-DD') || coalesce(' / ' || co.despatch_no, ''))
      FILTER (WHERE rn.seq_no = 2) AS notice_2,
    max(to_char(rn.sent_at, 'YYYY-MM-DD') || coalesce(' / ' || co.despatch_no, ''))
      FILTER (WHERE rn.seq_no = 3) AS notice_3,
    to_char(min(rn.reply_received_at), 'YYYY-MM-DD') AS first_reply
  FROM respondent_notice rn
  JOIN case_respondent cr ON cr.id = rn.case_respondent_id
  LEFT JOIN correspondence co ON co.id = rn.correspondence_id
  WHERE cr.case_file_id = c.id
) notices ON true

-- Phase 3 and 4 are not built yet. These read as NULL rather than being absent, so the
-- register's shape does not change under the officer when they arrive.
LEFT JOIN LATERAL (
  SELECT NULL::text AS despatched_on, NULL::text AS report_on, NULL::text AS shared_on
) referral ON true

LEFT JOIN LATERAL (SELECT NULL::text AS heard_on) sittings ON true
LEFT JOIN LATERAL (SELECT NULL::text AS per_respondent) outcomes ON true

LEFT JOIN LATERAL (
  SELECT CASE
           WHEN count(*) FILTER (WHERE d.physical_original_held
                                   AND d.physical_returned_at IS NULL) > 0 THEN 'Yes'
           WHEN count(*) FILTER (WHERE d.physical_original_held) > 0 THEN 'Returned'
           ELSE NULL
         END AS held
  FROM document d
  WHERE d.case_file_id = c.id AND d.status = 'stored'
) custody ON true

LEFT JOIN LATERAL (
  SELECT string_agg(DISTINCT m.milestone::text, ', ' ORDER BY m.milestone::text) AS reconstructed
  FROM case_milestone m
  WHERE m.case_file_id = c.id AND m.date_source <> 'recorded'
) provenance ON true

LEFT JOIN app_user officer ON officer.id = c.owner_user_id

WHERE c.deleted_at IS NULL;

GRANT SELECT ON v_case_register TO app_rw;

COMMENT ON VIEW v_case_register IS
  'The register, one row per case. security_invoker=true: without it this view would run '
  'as its owner and bypass row-level security entirely.';
