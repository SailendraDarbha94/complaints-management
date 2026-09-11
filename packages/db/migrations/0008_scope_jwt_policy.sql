-- 0008_scope_jwt_policy.sql
--
-- Narrow a policy that was written wider than it needed to be.
--
-- 0006 added jwt_own_membership to council_membership with no TO clause, which in
-- PostgreSQL means it applies to EVERY role. It was meant for the direct-client path
-- only, where the caller is `authenticated` and the claims come from a JWT that PostgREST
-- verified before the query ran.
--
-- Applied to every role, it also applies to app_rw - and app_rw can set
-- request.jwt.claims itself, because it is an ordinary session setting and nothing stops
-- a connection from writing one. So the policy handed app_rw a second way to read
-- membership rows: set a claim naming any app_user_id, and read that person's councils.
--
-- That is not a dramatic hole. app_rw already reaches council_membership through the
-- council_isolation policy when it is scoped to a council, and a party holding the app_rw
-- credential has larger options than this (see the honest note in ADR-0002 about what a
-- session-GUC model can and cannot defend against). But a policy that grants more than it
-- was written to grant is worth closing on sight, and the fix costs nothing.
--
-- The sign-in policies from 0003 have the same unscoped shape and are deliberately left
-- alone: they are keyed on app.auth_subject, they are the mechanism by which app_rw
-- discovers a council during sign-in, and scoping them TO app_rw would change nothing
-- because app_rw is exactly who uses them.

DROP POLICY IF EXISTS jwt_own_membership ON public.council_membership;

CREATE POLICY jwt_own_membership ON public.council_membership
  FOR SELECT
  TO authenticated
  USING (app_user_id = public.jwt_app_user_id());
