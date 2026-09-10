-- 0003_auth_lookup.sql
--
-- Sign-in has a chicken-and-egg problem with row-level security.
--
-- To sign someone in we must discover which councils they belong to. That means reading
-- council_membership and council -- both of which are protected by a policy keyed on
-- app.council_id, which we do not yet know, because knowing it is the point of the query.
-- Outside a council scope the setting is NULL, the policy matches nothing, and sign-in
-- silently fails with "not a member of any council".
--
-- The wrong fixes, and why:
--   * Dropping RLS on those tables would let any council read another's roster.
--   * A SECURITY DEFINER function does not help: FORCE ROW LEVEL SECURITY subjects the
--     table owner to the policies too, which is exactly why FORCE is set.
--   * A role with BYPASSRLS needs superuser to create, which Cloud SQL does not give us.
--
-- So: a second, additive policy keyed on a different session variable. `app.auth_subject`
-- holds the email address being signed in, and the policy exposes only THAT person's own
-- memberships. Policies are OR'd, so this widens the read path by exactly one row set,
-- and even a leaked setting reveals nothing but one user's own council list.
--
-- It grants SELECT and nothing else, on these two tables and nothing else. No case data
-- is reachable through it, which the tenancy tests assert.

CREATE OR REPLACE FUNCTION public.current_auth_subject() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.auth_subject', true), '')
$$;

-- The user whose sign-in is in progress, or NULL when none is.
CREATE OR REPLACE FUNCTION public.current_auth_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT u.id
  FROM app_user u
  WHERE public.current_auth_subject() IS NOT NULL
    AND lower(u.email) = lower(public.current_auth_subject())
$$;

DROP POLICY IF EXISTS auth_lookup_own_membership ON public.council_membership;
CREATE POLICY auth_lookup_own_membership ON public.council_membership
  FOR SELECT
  USING (app_user_id = public.current_auth_user_id());

DROP POLICY IF EXISTS auth_lookup_own_councils ON public.council;
CREATE POLICY auth_lookup_own_councils ON public.council
  FOR SELECT
  USING (
    id IN (
      SELECT m.council_id
      FROM council_membership m
      WHERE m.app_user_id = public.current_auth_user_id()
    )
  );

GRANT EXECUTE ON FUNCTION public.current_auth_subject() TO app_rw;
GRANT EXECUTE ON FUNCTION public.current_auth_user_id() TO app_rw;
