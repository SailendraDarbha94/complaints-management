-- 0010_mobile_read_grants.sql
--
-- What a committee member may read from a phone.
--
-- Until now NO table was granted to `authenticated`, so the mobile app could read nothing
-- whatever its policies said. That was deliberate: the policies decide WHICH ROWS, the
-- grants decide WHETHER TO ASK AT ALL, and handing over the second by default would have
-- made every future table readable the moment it was created. This migration is that
-- decision, taken once, in writing.
--
-- The reader is an honorary dentist in private practice, reading a case file on a phone
-- before a sitting. They are replacing a photocopy, not operating the register. So the
-- test applied to every table below is: would this have been in the photocopy?
--
-- GRANTED - SELECT only, filtered by jwt_council_isolation to their own council:
--
--   case_file          the case, its state, the grievance
--   case_party         who is on it, in what role
--   party              their names, ages - the photocopy had these
--   case_respondent    which dentist, how many notices, whether they replied
--   registered_dentist the dentist's name and registration number
--   case_milestone     the dated events: received, acknowledged, notice sent, heard
--   document           what is on the file
--   document_version   its filename, size and sha256, so a download can be requested
--
-- NOT GRANTED, and each for a reason:
--
--   follow_up          the officer's chase list. A member does not want it, and it would
--                      show them who is being chased and how late - which is the officer's
--                      working state, not the committee's business.
--   correspondence     the full text of every letter, including drafts that were never
--                      sent. The photocopy contained the dentist's REPLY, which lives in
--                      document; it did not contain the office's outbound file copies.
--   contact_event      phone calls and their notes. Working state again.
--   case_note          the officer's own notes on the case.
--   case_state_history every transition with reasons. An audit trail, not a brief.
--   council_membership who else is on the committee, and their terms.
--   app_user, auth_*   never, to anyone but the application.
--
-- Two of these - follow_up and correspondence - already carry a jwt_council_isolation
-- policy from 0006. They stay unreachable because no grant follows. That is the layering
-- working as intended: a policy without a grant is inert.
--
-- SELECT only. Nothing a phone does writes to the register directly: audit.append() takes
-- its actor from session settings a PostgREST client never sets, so a direct write would
-- land unattributed and break the chain the legal case rests on. Writes go through the
-- register's own API with a bearer token. See docs/adr/0002.

-- ---------------------------------------------------------------------------
-- Two tables the mobile policies forgot
-- ---------------------------------------------------------------------------

-- party holds the NAMES. Without a policy here, case_party is a list of identifiers and
-- the app shows a complaint by nobody against nobody. registered_dentist is the same
-- problem for the respondent side.
DO $policies$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['party', 'registered_dentist']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;

    EXECUTE format('DROP POLICY IF EXISTS jwt_council_isolation ON public.%I', t);
    EXECUTE format($p$
      CREATE POLICY jwt_council_isolation ON public.%I
        FOR SELECT
        TO authenticated
        USING (
          council_id = public.jwt_council_id()
          AND public.jwt_member_of(council_id)
        )
    $p$, t);
  END LOOP;
END
$policies$;

-- ---------------------------------------------------------------------------
-- The grants
-- ---------------------------------------------------------------------------

GRANT SELECT ON
  public.case_file,
  public.case_party,
  public.party,
  public.case_respondent,
  public.registered_dentist,
  public.case_milestone,
  public.document,
  public.document_version
TO authenticated;

-- Said out loud rather than left implicit, because a future reader will wonder whether
-- these were forgotten. They were not.
REVOKE ALL ON public.follow_up FROM authenticated;
REVOKE ALL ON public.correspondence FROM authenticated;
REVOKE ALL ON public.contact_event FROM authenticated;
REVOKE ALL ON public.case_note FROM authenticated;
REVOKE ALL ON public.case_state_history FROM authenticated;

-- anon keeps nothing, on anything, ever.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
