-- 0016_case_cancel_opened_in_error.sql
--
-- Cancelling a case that was opened in error.
--
-- The officer asked for a delete button on the cases list. There is no such thing here and
-- there will not be: app_rw has no DELETE grant on anything (0001), and a case number is a
-- serial in a legal register. A number that was issued and then vanished is a gap in the
-- book that somebody will one day be asked to explain, in writing, without the row that
-- would have explained it.
--
-- What there is instead is CANCELLED - OPENED IN ERROR: a duplicate, a message that was
-- not a complaint, a test. The case keeps its number and every row hanging off it. It drops
-- out of every working list (the cases list, Today, the tray's matching, a dentist's
-- history, the nightly sweep, the phone), but the REGISTER still lists it, marked
-- cancelled and saying why, so the numbering has no unexplained gap. It can be restored.
-- Every change still goes through the audit trigger like any other update of case_file.
--
-- ---------------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------------
--
-- Nothing to add. case_file has carried all three since 0000, declared by the drizzle
-- schema from the start and unused until now:
--
--   deleted_at       timestamptz                     when it was cancelled
--   deleted_by       uuid REFERENCES app_user(id)    who cancelled it (ON DELETE SET NULL)
--   deletion_reason  text                            why, in the officer's words
--
-- Re-declaring them with ADD COLUMN IF NOT EXISTS was considered and left out. Every
-- database this file can run on has them from 0000, so the statements would do nothing -
-- and a line that looks as if it adds a column, in a file people read to learn what
-- changed, is a small lie about the schema's history.
--
-- ---------------------------------------------------------------------------
-- 2. A cancellation always says why
-- ---------------------------------------------------------------------------
--
-- The same shape as case_file_closed_needs_reason and case_file_hold_needs_reason. The
-- application refuses a blank or token reason with a sentence the officer can act on; this
-- is the floor underneath it, so no path - a script, a future endpoint, a hand-typed UPDATE
-- - can cancel a numbered case and leave the register unable to say why.
--
-- Safe to add without NOT VALID: nothing has ever set deleted_at, so no existing row can
-- fail it.

ALTER TABLE case_file
  ADD CONSTRAINT case_file_deleted_needs_reason
  CHECK (deleted_at IS NULL OR deletion_reason IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. The register lists cancelled cases
-- ---------------------------------------------------------------------------
--
-- 0005 and 0012 ended the view with WHERE c.deleted_at IS NULL, written when "deleted"
-- was imagined as something a case could be made to stop being. That is exactly wrong for
-- the book: a cancelled case is a number the register issued, and the one place it must go
-- on appearing is the register, saying what happened to it.
--
-- The body below is 0012's, copied mechanically, with these edits and no others:
--
--   - the WHERE clause is gone, so cancelled cases are included;
--   - "Status" reads 'cancelled' for them. The state column itself is untouched by a
--     cancellation - restoring puts the case back exactly where it stood - so this is the
--     view saying what the case IS, not what state it was frozen in;
--   - "Waiting on" reads 'nobody' and "Days waiting" is empty for them, as for a closed
--     case: a case opened in error is not waiting on anyone, and a number that grew every
--     day on a cancelled row would read as neglect;
--   - two columns are APPENDED at the end: "Cancellation reason" and "Cancelled on".
--
-- CREATE OR REPLACE VIEW may only add columns at the end; it cannot rename, reorder or
-- retype one. So every existing column keeps its position, its type, and its name as 0015
-- left it - the three "Dispatch" headings are spelled the new way below, or this statement
-- would fail by trying to rename them back.
--
-- security_invoker is restated: a view runs as its OWNER without it, and this one joins
-- case_file, party and correspondence, so dropping it would make the register readable
-- across councils.
--
-- The phone role (0010) is not granted this view and still is not. The phone reads
-- case_file directly, and 0010's grant on case_file is table-wide, which in PostgreSQL
-- covers every column including these three; its list filters out cancelled cases itself.

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
  referral.despatched_on                             AS "Expert referral dispatched", -- Phase 3
  referral.report_on                                 AS "Expert report received",     -- Phase 3
  referral.shared_on                                 AS "Report shared with patient", -- Phase 3

  CASE WHEN c.deleted_at IS NOT NULL THEN 'cancelled'
       ELSE c.state::text END                        AS "Status",
  CASE WHEN c.deleted_at IS NOT NULL THEN 'nobody'
       ELSE c.waiting_on::text END                   AS "Waiting on",
  CASE WHEN c.state = 'closed' OR c.deleted_at IS NOT NULL THEN NULL
       ELSE (current_date - c.waiting_since::date) END AS "Days waiting",
  CASE WHEN c.on_hold THEN c.hold_reason END         AS "On hold",

  outcomes.per_respondent                            AS "Decision / outcome",         -- Phase 4
  to_char(m_order.occurred_at, 'YYYY-MM-DD')         AS "Order dispatched on",        -- Phase 4
  m_order.despatch_no                                AS "Order dispatch no.",         -- Phase 4

  to_char(c.closed_at, 'YYYY-MM-DD')                 AS "Closed on",
  c.closure_reason::text                             AS "Closure reason",

  custody.held                                       AS "Physical originals held",
  rti.refs                                           AS "RTI refs.",
  officer.full_name                                  AS "Officer",
  c.remarks                                          AS "Remarks",

  -- Provenance. Anything other than 'recorded' means the date was reconstructed from the
  -- paper book or estimated, and every export has to say so: a reconstructed date must
  -- never become indistinguishable from a recorded fact in an RTI reply or a writ.
  c.is_backfilled                                    AS "Entered from the book",
  c.legacy_register_ref                              AS "Book reference",
  provenance.reconstructed                           AS "Dates reconstructed",

  -- Appended by 0016. Empty on every live case. On a cancelled one, the entry the book
  -- needs beside a number that leads nowhere: why, and when. The reason comes first
  -- because it is the one a reader of the register is looking for, and the first column
  -- whose heading mentions cancelling is the one the register screen shows as the reason.
  c.deletion_reason                                  AS "Cancellation reason",
  to_char(c.deleted_at, 'YYYY-MM-DD')                AS "Cancelled on"

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

LEFT JOIN LATERAL (
  SELECT string_agg(
           r.rti_no
             || ' (' || to_char(r.received_on, 'YYYY-MM-DD')
             || coalesce(', replied ' || to_char(r.reply_despatched_on, 'YYYY-MM-DD'), ', open')
             || ')',
           '; ' ORDER BY r.received_on) AS refs
  FROM rti_case_link l
  JOIN rti_request r ON r.id = l.rti_request_id
  WHERE l.case_file_id = c.id
) rti ON true

LEFT JOIN app_user officer ON officer.id = c.owner_user_id;

GRANT SELECT ON v_case_register TO app_rw;
