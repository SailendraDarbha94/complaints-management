-- 0006_supabase_auth.sql
--
-- Supabase Auth, and the hardening that has to come with it.
--
-- Three things happen here, and the first is not optional.
--
-- 1. CLOSE THE DEFAULT GRANTS.
--
--    A Supabase project ships with ALTER DEFAULT PRIVILEGES rules, owned by both postgres
--    and supabase_admin, that grant ALL privileges on every newly created table in public
--    to anon, authenticated and service_role. Verified on this project, 2026-09-11: a
--    bare CREATE TABLE came back with
--
--      anon=arwdDxtm/postgres  authenticated=arwdDxtm/postgres  service_role=arwdDxtm/postgres
--
--    where the 'd' is DELETE and anon is an unauthenticated caller holding only the
--    publishable key. Two consequences for this schema in particular:
--
--      * app_user, auth_otp, auth_session and job_run carry no row-level security, by
--        design, because nothing outside the application was ever supposed to reach them.
--        Under those defaults they are readable AND deletable over HTTPS by anyone.
--      * Migration 0001 states that the application role holds no DELETE grant anywhere,
--        and the audit chain's integrity argument rests on it. Those defaults make that
--        statement false for three other roles.
--
--    So the rules are dropped and the grants revoked. Nothing is granted back. The React
--    Native app will need SELECT on specific tables later; that is a deliberate, reviewed
--    grant per table, not a default.
--
-- 2. A LOCAL auth SCHEMA, so the policies below can be tested without Docker.
--
--    Supabase ships auth.uid() and auth.jwt(); plain PostgreSQL does not. Rather than
--    keep the JWT policies out of the test suite - which is how a policy nobody ever ran
--    reaches production - this creates the same two functions when they are absent. The
--    bodies are copied from the live project (select pg_get_functiondef('auth.jwt()')),
--    so a test that sets request.jwt.claims exercises the real expression. On Supabase
--    the guard sees the functions already exist and does nothing.
--
-- 3. THE ACCESS TOKEN HOOK, and policies for a direct client.
--
--    An identity here is (user, council, role). Supabase's token carries the user; the
--    council and role are added by a hook GoTrue calls while minting the token.
--
--    The claims go in app_metadata, NEVER user_metadata: a signed-in user can write their
--    own user_metadata, so a council_id there would be a tenant id the tenant chooses.
--    The top-level 'role' claim is left alone - PostgREST issues SET ROLE with it, so
--    putting 'officer' there would break every request.

-- ---------------------------------------------------------------------------
-- 0. Supabase's roles, on a cluster that does not have them
-- ---------------------------------------------------------------------------
--
-- A local cluster has no anon, authenticated or service_role, so a policy written
-- TO authenticated fails to apply and the whole JWT path becomes untestable. Creating
-- them here - with the same attributes Supabase's own bootstrap uses, including
-- service_role's BYPASSRLS - means the test suite applies the SAME policies and can
-- assert the SAME grant shape the production database has, with no Docker anywhere.
--
-- They are NOLOGIN. Nothing can connect as them; they exist to be the subject of grants
-- and policies, which is all they are on Supabase either.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$roles$;

-- ---------------------------------------------------------------------------
-- 1. Default grants
-- ---------------------------------------------------------------------------

DO $harden$
DECLARE
  r record;
BEGIN
  -- Stop the bleeding for tables created from here on, for every grantor that has a rule.
  FOR r IN
    SELECT DISTINCT pg_get_userbyid(defaclrole) AS grantor
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE n.nspname = 'public'
  LOOP
    -- ALTER DEFAULT PRIVILEGES FOR ROLE x requires membership of x. On Supabase the
    -- postgres role can change its own rule but not supabase_admin's, and that is fine:
    -- the rule that governs OUR tables is the one belonging to whoever creates them, and
    -- migrations run as postgres. supabase_admin's rule governs the platform's own
    -- objects. Skipping it is correct; skipping it SILENTLY would not be, hence the
    -- notice - if this ever turns out to matter, it will be in the migration log.
    BEGIN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'REVOKE ALL ON TABLES FROM anon, authenticated, service_role', r.grantor);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role', r.grantor);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role', r.grantor);
      RAISE NOTICE 'default privileges for role % closed', r.grantor;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE
        'cannot change default privileges owned by % - skipped. Tables created by THIS '
        'role are unaffected; verify with the grant assertions in tenancy.test.ts.',
        r.grantor;
    END;
  END LOOP;

  -- And take back what the tables created by 0000 were already given.
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, service_role;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, service_role;

  -- USAGE on the schema stays: without it a later, deliberate per-table grant could not
  -- be exercised at all. It confers no access to any object on its own.
  RAISE NOTICE 'default grants to anon/authenticated/service_role revoked on public';
END
$harden$;

-- ---------------------------------------------------------------------------
-- 2. auth.uid() and auth.jwt() for a plain PostgreSQL cluster
-- ---------------------------------------------------------------------------

DO $shim$
BEGIN
  IF to_regprocedure('auth.jwt()') IS NOT NULL THEN
    RAISE NOTICE 'auth.jwt() already exists - leaving Supabase''s own alone';
    RETURN;
  END IF;

  CREATE SCHEMA IF NOT EXISTS auth;

  EXECUTE $fn$
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $body$
      SELECT coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
      )::jsonb
    $body$
  $fn$;

  EXECUTE $fn$
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $body$
      SELECT nullif(
        coalesce(
          current_setting('request.jwt.claim.sub', true),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        ),
        ''
      )::uuid
    $body$
  $fn$;

  RAISE NOTICE 'created a local auth.uid()/auth.jwt() shim';
END
$shim$;

-- A policy that calls auth.uid() is evaluated as the CALLING role, so the calling role
-- needs to reach the auth schema. Supabase grants this already; a local cluster does not,
-- and without it the policies below fail with "permission denied for schema auth" instead
-- of filtering - an error rather than an empty result, which is at least loud.
-- On a local cluster these grants take effect and app_rw can call auth.jwt() directly.
-- On Supabase the auth schema belongs to supabase_admin and postgres cannot pass USAGE
-- on, so the app_rw part quietly grants nothing - which is why the wrappers below are
-- SECURITY DEFINER rather than relying on this.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, app_rw;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role, app_rw;
GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated, service_role, app_rw;

-- ---------------------------------------------------------------------------
-- 3. Linking a Supabase user to an application user
-- ---------------------------------------------------------------------------

-- No foreign key to auth.users on purpose: the column has to exist on a plain cluster
-- too, so that the tests apply the same schema the production database runs.
ALTER TABLE public.app_user ADD COLUMN IF NOT EXISTS supabase_user_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS app_user_supabase_uq
  ON public.app_user (supabase_user_id) WHERE supabase_user_id IS NOT NULL;

-- Which council this person is currently acting for.
--
-- A token can carry one council, and row-level security filters on exactly one. Someone
-- who belongs to two councils switches, which re-mints their token - the same thing
-- POST /v1/auth/council does today. Storing it here rather than in the token means the
-- hook has somewhere to read it from.
ALTER TABLE public.app_user ADD COLUMN IF NOT EXISTS active_council_id uuid;

DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_user_active_council_fk'
  ) THEN
    ALTER TABLE public.app_user
      ADD CONSTRAINT app_user_active_council_fk
      FOREIGN KEY (active_council_id) REFERENCES public.council(id) ON DELETE RESTRICT;
  END IF;
END
$fk$;

-- ---------------------------------------------------------------------------
-- 4. The custom access token hook
-- ---------------------------------------------------------------------------

-- Resolve the council and role for a Supabase user, in one place.
--
-- Precedence when someone holds several memberships: their chosen active council if it is
-- still a live membership, otherwise their only one. Somebody with two councils and no
-- choice recorded gets NO council claim, and therefore reads nothing until they pick -
-- which is the correct failure. Guessing a council for a person who belongs to two is how
-- one council's complaints end up on another's screen.
CREATE OR REPLACE FUNCTION public.council_claim_for(p_supabase_user_id uuid)
RETURNS TABLE (council_id uuid, council_role text, app_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (
    SELECT u.id, u.active_council_id
    FROM app_user u
    WHERE u.supabase_user_id = p_supabase_user_id AND u.is_active
  ),
  live AS (
    SELECT m.council_id, m.role::text AS role, m.app_user_id
    FROM council_membership m
    JOIN me ON me.id = m.app_user_id
    WHERE m.starts_on <= current_date
      AND (m.ends_on IS NULL OR m.ends_on >= current_date)
  ),
  chosen AS (
    SELECT l.* FROM live l JOIN me ON me.active_council_id = l.council_id
    UNION ALL
    SELECT l.* FROM live l
    WHERE (SELECT active_council_id FROM me) IS NULL
      AND (SELECT count(DISTINCT council_id) FROM live) = 1
  )
  -- Highest privilege first: a person may hold more than one role in a council.
  SELECT council_id, role, app_user_id
  FROM chosen
  ORDER BY CASE role WHEN 'officer' THEN 0 WHEN 'committee_member' THEN 1 ELSE 2 END
  LIMIT 1
$$;

-- Called by GoTrue while minting an access token.
--
-- Returns the event with claims replaced. It must NOT touch the top-level 'role' claim:
-- PostgREST issues SET ROLE with that value, so anything but 'authenticated' fails the
-- request outright. The council and the council role go into app_metadata, which the user
-- cannot write - unlike user_metadata, which they can.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  claims jsonb;
  meta jsonb;
  found record;
BEGIN
  claims := coalesce(event -> 'claims', '{}'::jsonb);
  meta := coalesce(claims -> 'app_metadata', '{}'::jsonb);

  SELECT * INTO found
  FROM public.council_claim_for((event ->> 'user_id')::uuid);

  IF found.council_id IS NOT NULL THEN
    meta := meta
      || jsonb_build_object('council_id', found.council_id)
      || jsonb_build_object('council_role', found.council_role)
      || jsonb_build_object('app_user_id', found.app_user_id);
  ELSE
    -- Signed in, but not a member of anything this system recognises. Strip any stale
    -- claim rather than leaving one behind: a token must never outlive the membership.
    meta := meta - 'council_id' - 'council_role' - 'app_user_id';
  END IF;

  RETURN jsonb_set(event, '{claims,app_metadata}', meta);
END
$$;

-- GoTrue runs as supabase_auth_admin and is the only caller. Nobody else may execute it:
-- it is SECURITY DEFINER and reads across the membership table.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION public.council_claim_for(uuid) TO supabase_auth_admin;
    GRANT SELECT ON public.app_user, public.council_membership TO supabase_auth_admin;
  END IF;
END
$grants$;

REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM public;
REVOKE EXECUTE ON FUNCTION public.council_claim_for(uuid) FROM public;

-- ---------------------------------------------------------------------------
-- 5. Reading the claim, and the policies that use it
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER, and not for the usual reason.
--
-- On Supabase the auth schema is owned by supabase_admin, and postgres holds USAGE
-- WITHOUT grant option - so `GRANT USAGE ON SCHEMA auth TO app_rw` runs without error and
-- grants nothing. app_rw therefore cannot call auth.jwt() directly, and the policy on
-- council_membership below is reached by app_rw on ordinary inserts into council. Running
-- as the owner sidesteps it. These read two session GUCs and nothing else - SECURITY
-- DEFINER buys access to the auth SCHEMA, not to auth.users.
CREATE OR REPLACE FUNCTION public.jwt_council_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT nullif(auth.jwt() -> 'app_metadata' ->> 'council_id', '')::uuid
$$;

CREATE OR REPLACE FUNCTION public.jwt_app_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT nullif(auth.jwt() -> 'app_metadata' ->> 'app_user_id', '')::uuid
$$;

-- Is the caller still a member of that council, right now?
--
-- SECURITY DEFINER because the calling role holds no grant on app_user or
-- council_membership and must not be given one - exposing a boolean is the whole point.
-- It runs as the migration owner, which reaches app_user (no row-level security) directly;
-- council_membership has FORCE RLS, so the additive policy below is what lets the owner
-- see the caller's own rows. That is the same shape migration 0003 used to solve exactly
-- this problem for the sign-in path, and for the same reason: FORCE subjects the owner to
-- the policies too.
CREATE OR REPLACE FUNCTION public.jwt_member_of(p_council_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT EXISTS (
    SELECT 1
    FROM council_membership m
    JOIN app_user u ON u.id = m.app_user_id
    WHERE u.supabase_user_id = auth.uid()
      AND u.is_active
      AND m.council_id = p_council_id
      AND m.starts_on <= current_date
      AND (m.ends_on IS NULL OR m.ends_on >= current_date)
  )
$$;

-- The caller's own membership rows, for the check above. Mirrors auth_lookup_own_membership
-- in 0003, keyed on the signed token instead of on a sign-in in progress. It reveals one
-- person's own council list and nothing else, and no case data is reachable through it.
DROP POLICY IF EXISTS jwt_own_membership ON public.council_membership;
CREATE POLICY jwt_own_membership ON public.council_membership
  FOR SELECT
  USING (app_user_id = public.jwt_app_user_id());

GRANT EXECUTE ON FUNCTION public.jwt_app_user_id() TO app_rw, authenticated;
GRANT EXECUTE ON FUNCTION public.jwt_member_of(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.jwt_member_of(uuid) FROM public;

-- Policies for the direct-client path.
--
-- Scoped TO authenticated, and kept SEPARATE from the app.council_id policies in 0001.
-- Policies are OR'd, so a single policy coalescing the GUC and the claim would let
-- whichever source is set decide - and the two paths have different threat models. Two
-- policies, each naming the role it trusts, can be read and audited one at a time.
--
-- The membership is re-checked on every row rather than trusted from the token. An
-- access token lives an hour; a committee member whose term ended this morning must stop
-- reading complaints this morning, not at the top of the hour.
DO $policies$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'case_file', 'case_party', 'case_respondent', 'case_milestone', 'case_event',
    'correspondence', 'document', 'document_version', 'follow_up', 'case_decision'
  ]
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

GRANT EXECUTE ON FUNCTION public.jwt_council_id() TO app_rw;
-- The policy body calls this as the connected role, so the direct client needs it too.
GRANT EXECUTE ON FUNCTION public.jwt_council_id() TO authenticated;

-- Deliberately NOT granted: no table is reachable by anon or authenticated yet. The
-- policies above decide WHICH ROWS a direct client may see; the grants decide whether it
-- may ask at all, and until the React Native app exists the answer is no. Adding a
-- council's tables to the mobile app is one GRANT SELECT per table, reviewed on its own.
