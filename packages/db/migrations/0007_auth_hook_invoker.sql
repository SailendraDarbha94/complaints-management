-- 0007_auth_hook_invoker.sql
--
-- Make the access token hook run the way Supabase says it should, and make that
-- verifiable without a Supabase project.
--
-- 0006 shipped the hook as SECURITY DEFINER. It works - the owner has BYPASSRLS on a
-- Supabase project - but it was never actually proved, because the only way to call it
-- from a migration is as the owner, and the owner is not who calls it in production.
-- GoTrue calls it as supabase_auth_admin, and three facts about that role decide whether
-- the hook returns a council or silently returns nothing:
--
--   rolsuper = false, rolbypassrls = false. Verified on the live project. So it IS
--   subject to FORCE ROW LEVEL SECURITY on council_membership, and a hook that reads that
--   table without a policy naming the role finds zero rows - and signs a token with no
--   council in it. Nothing errors. Every request afterwards is simply empty.
--
--   rolconfig = search_path=auth. Verified likewise. An unqualified `app_user` inside the
--   hook resolves in the auth schema and raises 42P01. Both functions pin search_path.
--
--   Supabase's own documentation recommends AGAINST security definer here, and for
--   explicit grants instead. A definer function in public that reads the membership table
--   is a thing you have to keep revoked; an invoker function plus one narrow policy is a
--   thing you can read and check.
--
-- So: both functions become SECURITY INVOKER, supabase_auth_admin gets a policy that
-- exposes council_membership to it and to nothing else, and the role is created locally
-- when absent so the test suite can SET ROLE to it and call the hook exactly as GoTrue
-- does. That last part is the point - 0006's hook was tested as the wrong user.

-- ---------------------------------------------------------------------------
-- The role, on a cluster that has no Supabase
-- ---------------------------------------------------------------------------

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    -- Same attributes as Supabase's own bootstrap, minus LOGIN: nothing connects as it
    -- here, the tests SET ROLE to it. NOINHERIT matters - it must not pick up privileges
    -- from a role it is a member of, which is what makes this a faithful rehearsal.
    CREATE ROLE supabase_auth_admin NOINHERIT NOLOGIN;
    ALTER ROLE supabase_auth_admin SET search_path = 'auth';
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT SELECT ON public.app_user, public.council_membership TO supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- The policy the hook needs
-- ---------------------------------------------------------------------------

-- council_membership is FORCE RLS, so a grant alone gives supabase_auth_admin nothing.
-- This is the whole of its reach: membership rows, read-only. No case file, no
-- correspondence, no document, no audit row is reachable through it. It is the same
-- shape as auth_lookup_own_membership in 0003 and jwt_own_membership in 0006 - a narrow,
-- additive read path for one caller that cannot use the ordinary one.
DROP POLICY IF EXISTS auth_admin_reads_membership ON public.council_membership;
CREATE POLICY auth_admin_reads_membership ON public.council_membership
  FOR SELECT
  TO supabase_auth_admin
  USING (true);

-- ---------------------------------------------------------------------------
-- The functions, as invoker
-- ---------------------------------------------------------------------------

-- search_path is pinned because supabase_auth_admin's own is `auth`, where none of these
-- tables exist. Without it the hook raises 42P01 on its first unqualified reference.
CREATE OR REPLACE FUNCTION public.council_claim_for(p_supabase_user_id uuid)
RETURNS TABLE (council_id uuid, council_role text, app_user_id uuid)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
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
  SELECT council_id, role, app_user_id
  FROM chosen
  ORDER BY CASE role WHEN 'officer' THEN 0 WHEN 'committee_member' THEN 1 ELSE 2 END
  LIMIT 1
$$;

-- The claims this returns ARE the signed token, in full. GoTrue does not merge anything
-- back in: whatever is dropped here is absent from the JWT. Hence jsonb_set on the event
-- rather than building a fresh object - aud, exp, iat, sub, email, phone, role, aal,
-- session_id and is_anonymous are all required, and a missing one is a 500 at sign-in
-- rather than a quiet omission.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  meta jsonb;
  found record;
BEGIN
  meta := coalesce(event -> 'claims' -> 'app_metadata', '{}'::jsonb);

  SELECT * INTO found
  FROM public.council_claim_for((event ->> 'user_id')::uuid);

  IF found.council_id IS NOT NULL THEN
    meta := meta
      || jsonb_build_object('council_id', found.council_id)
      || jsonb_build_object('council_role', found.council_role)
      || jsonb_build_object('app_user_id', found.app_user_id);
  ELSE
    -- Signed in, but not an active member of any council this register knows - or a
    -- member of two with none chosen. Strip any stale claim rather than leave one: a
    -- token must never outlive the membership that justified it.
    meta := meta - 'council_id' - 'council_role' - 'app_user_id';
  END IF;

  RETURN jsonb_set(event, '{claims,app_metadata}', meta);
END
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.council_claim_for(uuid) TO supabase_auth_admin;

-- Nobody else. These read across the membership table, and the hook is not an API.
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.council_claim_for(uuid) FROM public, anon, authenticated;
