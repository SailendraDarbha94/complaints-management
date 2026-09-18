-- 0015_register_dispatch_spelling.sql
--
-- The officer reads "Despatch" as a typo and asked for "Dispatch" throughout. Three of the
-- register's column headings carried the old spelling, and those headings are not labels
-- kept in the application: they ARE the view's column names, which the /register page and
-- the CSV export print as they are. So the spelling changes here or nowhere.
--
-- Headings only. The columns underneath (despatch_no, despatched_on, the milestone and
-- stage values) keep their names; nothing that reads the view by position or by any other
-- column is affected, and no code refers to these three names.
--
-- RENAME COLUMN on a view is PostgreSQL 13+ and changes nothing but the name. It is
-- restated as a RENAME rather than a fresh CREATE OR REPLACE VIEW because the latter
-- cannot rename a column of an existing view.

ALTER VIEW v_case_register RENAME COLUMN "Expert referral despatched" TO "Expert referral dispatched";
ALTER VIEW v_case_register RENAME COLUMN "Order despatched on" TO "Order dispatched on";
ALTER VIEW v_case_register RENAME COLUMN "Order despatch no." TO "Order dispatch no.";
