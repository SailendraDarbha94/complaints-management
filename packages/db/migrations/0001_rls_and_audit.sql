-- 0001_rls_and_audit.sql
--
-- Hand-written. drizzle-kit does not generate row-level security, grants, or triggers,
-- and `drizzle-kit push` treats them as drift -- which is the main reason this project
-- uses checked-in SQL migrations rather than push. See migrations/README.md.
--
-- Three things happen here:
--   1. An application role that cannot bypass RLS and cannot DELETE anything.
--   2. Row-level security on every table carrying council_id, keyed on app.council_id.
--   3. One append-only, hash-chained audit log with the canonical payload stored.

-- --- 1. The application role ------------------------------------------------
--
-- The app connects as app_rw. It owns nothing, so it cannot ALTER or DROP; it cannot
-- bypass RLS; and it has no DELETE grant anywhere. "No hard deletes" is a grant, not a
-- convention. On Cloud SQL this role is created with IAM database authentication and has
-- no password at all.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE app_rw NOBYPASSRLS;

GRANT USAGE ON SCHEMA public, audit TO app_rw;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_rw;
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- audit.events is append-and-read only, enforced again by trigger below.
GRANT SELECT, INSERT ON audit.events, audit.seal TO app_rw;
REVOKE UPDATE, DELETE ON audit.events, audit.seal FROM app_rw;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO app_rw;

-- --- 2. Row-level security --------------------------------------------------
--
-- Every table carrying council_id gets ENABLE + FORCE RLS and one policy comparing
-- council_id to current_setting('app.council_id'). withCouncil() is the only thing that
-- sets it; unset yields NULL, which matches no row. The failure mode is zero rows, never
-- another council's data.
--
-- FORCE matters: without it the table owner silently bypasses the policy, and migrations
-- and seeds run as the owner.

CREATE OR REPLACE FUNCTION public.current_council_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.council_id', true), '')::uuid
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'council_id'
      AND NOT a.attisdropped
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS council_isolation ON public.%I', r.table_name);
    EXECUTE format($p$
      CREATE POLICY council_isolation ON public.%I
        USING (council_id = public.current_council_id())
        WITH CHECK (council_id = public.current_council_id())
    $p$, r.table_name);
  END LOOP;
END
$$;

-- The tenant root keys on its own id, not on a council_id column.
ALTER TABLE public.council ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.council FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS council_isolation ON public.council;
CREATE POLICY council_isolation ON public.council
  USING (id = public.current_council_id())
  WITH CHECK (id = public.current_council_id());

-- audit.events carries council_id but lives in its own schema, so the loop above missed it.
ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS council_isolation ON audit.events;
CREATE POLICY council_isolation ON audit.events
  USING (council_id = public.current_council_id())
  WITH CHECK (council_id = public.current_council_id());

ALTER TABLE audit.seal ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.seal FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS council_isolation ON audit.seal;
CREATE POLICY council_isolation ON audit.seal
  USING (council_id = public.current_council_id())
  WITH CHECK (council_id = public.current_council_id());

-- Deliberately global, with no council policy, and each for a stated reason:
--
--   app_user      one person may sit on two councils' committees -- that is why the
--                 council picker exists from day one (requirement 38)
--   auth_otp      a login attempt happens before any council is known
--   auth_session  a session spans a council switch (the JWT is re-minted, not the session)
--   job_run       the scheduler runs across all councils in one tick
--
-- Access to these is guarded in the application layer, not by RLS. Changing that list
-- requires a note here saying why.
COMMENT ON TABLE public.app_user IS
  'Global by design -- see 0001_rls_and_audit.sql. Not council-scoped.';

-- --- 3. The audit chain -----------------------------------------------------

CREATE OR REPLACE FUNCTION audit.append(
  p_council_id   uuid,
  p_action       text,
  p_entity_table text     DEFAULT NULL,
  p_entity_id    uuid     DEFAULT NULL,
  p_case_file_id uuid     DEFAULT NULL,
  p_before       jsonb    DEFAULT NULL,
  p_after        jsonb    DEFAULT NULL,
  p_metadata     jsonb    DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, public, pg_temp
AS $$
DECLARE
  v_seq     bigint;
  v_prev    text;
  v_payload text;
  v_hash    text;
  v_actor   uuid;
  v_role    text;
  v_req     uuid;
  v_now     timestamptz := clock_timestamp();
BEGIN
  IF p_council_id IS NULL THEN
    RAISE EXCEPTION 'audit.append: council_id is required';
  END IF;

  -- Gapless per council. The lock is transaction-scoped, so two concurrent writers for
  -- the same council serialise here and nowhere else.
  PERFORM pg_advisory_xact_lock(hashtext('audit:' || p_council_id::text));

  SELECT e.seq, e.hash INTO v_seq, v_prev
  FROM audit.events e
  WHERE e.council_id = p_council_id
  ORDER BY e.seq DESC
  LIMIT 1;

  v_seq := coalesce(v_seq, 0) + 1;

  v_actor := nullif(current_setting('app.user_id',    true), '')::uuid;
  v_role  := nullif(current_setting('app.role',       true), '');
  v_req   := nullif(current_setting('app.request_id', true), '')::uuid;

  -- The canonical payload is built ONCE and stored verbatim. Re-deriving it at
  -- verification time would make a Postgres major-version change to jsonb::text silently
  -- invalidate every historical verification.
  v_payload :=
       coalesce(v_prev, '')                                                   || E'\n'
    || p_council_id::text                                                     || E'\n'
    || v_seq::text                                                            || E'\n'
    || p_action                                                               || E'\n'
    || coalesce(p_entity_table, '')                                           || E'\n'
    || coalesce(p_entity_id::text, '')                                        || E'\n'
    || to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')     || E'\n'
    || coalesce(p_before::text, '')                                           || E'\n'
    || coalesce(p_after::text, '');

  v_hash := encode(sha256(convert_to(v_payload, 'UTF8')), 'hex');

  INSERT INTO audit.events (
    council_id, seq, prev_hash, hash, canonical_payload, action,
    entity_table, entity_id, case_file_id,
    actor_user_id, actor_role, before, after, request_id, metadata, occurred_at
  ) VALUES (
    p_council_id, v_seq, v_prev, v_hash, v_payload, p_action,
    p_entity_table, p_entity_id, p_case_file_id,
    v_actor, v_role, p_before, p_after, v_req,
    -- `unattributed` is the canary for a write that reached the database without going
    -- through withCouncil(). It should never be true; an alert fires if it is.
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('unattributed', v_actor IS NULL),
    v_now
  );

  RETURN v_seq;
END;
$$;

REVOKE ALL ON FUNCTION audit.append(uuid, text, text, uuid, uuid, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.append(uuid, text, text, uuid, uuid, jsonb, jsonb, jsonb) TO app_rw;

-- Immutability. The grants already withhold UPDATE and DELETE; this raises even for a
-- superuser or the table owner, so an accidental psql session cannot quietly rewrite history.
CREATE OR REPLACE FUNCTION audit.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit.events is append-only (attempted %). Corrections are recorded as new events.',
    TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS audit_events_immutable ON audit.events;
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

-- --- Row-level audit trigger ------------------------------------------------
--
-- Attached to every business table carrying council_id. Writes column diffs with the
-- actor read from the session variables. Explicit semantic events (RESPONDENT_NOTICE_SENT,
-- EX_PARTE_DECLARED, CASE_CLOSED ...) are appended by the application on top of these; the
-- timeline UI renders the semantic ones.

CREATE OR REPLACE FUNCTION audit.row_trigger() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, public, pg_temp
AS $$
DECLARE
  v_before  jsonb;
  v_after   jsonb;
  v_council uuid;
  v_case    uuid;
  v_row     jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_before := NULL;
    v_after  := to_jsonb(NEW);
    v_row    := v_after;
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    v_row    := v_after;
    IF v_before = v_after THEN
      RETURN NEW;  -- a no-op UPDATE is not an event
    END IF;
  ELSE
    v_before := to_jsonb(OLD);
    v_after  := NULL;
    v_row    := v_before;
  END IF;

  v_council := (v_row ->> 'council_id')::uuid;
  IF TG_TABLE_NAME = 'council' THEN
    v_council := (v_row ->> 'id')::uuid;
  END IF;

  IF v_council IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_case := CASE
    WHEN v_row ? 'case_file_id' THEN (v_row ->> 'case_file_id')::uuid
    WHEN TG_TABLE_NAME = 'case_file' THEN (v_row ->> 'id')::uuid
    ELSE NULL
  END;

  PERFORM audit.append(
    v_council,
    TG_TABLE_NAME || '.' || lower(TG_OP),
    TG_TABLE_NAME,
    (v_row ->> 'id')::uuid,
    v_case,
    v_before,
    v_after,
    jsonb_build_object('source', 'row_trigger')
  );

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'council_id'
      AND NOT a.attisdropped
      -- The scheduler writes job_run on every tick; auditing it is noise, not evidence.
      AND c.relname NOT IN ('job_run', 'notification_log')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_row ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION audit.row_trigger()',
      r.table_name
    );
  END LOOP;
END
$$;

DROP TRIGGER IF EXISTS audit_row ON public.council;
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON public.council
  FOR EACH ROW EXECUTE FUNCTION audit.row_trigger();

-- --- Verification -----------------------------------------------------------
--
-- Walks a council's chain and returns the first break, or nothing. Run by the monthly
-- restore drill and by `pnpm --filter @ksdc/db verify-audit`.

CREATE OR REPLACE FUNCTION audit.verify_chain(p_council_id uuid)
RETURNS TABLE (broken_seq bigint, reason text)
LANGUAGE plpgsql STABLE
SET search_path = audit, public, pg_temp
AS $$
DECLARE
  r          record;
  v_expected text := NULL;
BEGIN
  FOR r IN
    SELECT e.seq, e.prev_hash, e.hash, e.canonical_payload
    FROM audit.events e
    WHERE e.council_id = p_council_id
    ORDER BY e.seq
  LOOP
    IF r.prev_hash IS DISTINCT FROM v_expected THEN
      broken_seq := r.seq;
      reason := 'prev_hash does not match the previous event''s hash';
      RETURN NEXT;
      RETURN;
    END IF;

    IF r.hash <> encode(sha256(convert_to(r.canonical_payload, 'UTF8')), 'hex') THEN
      broken_seq := r.seq;
      reason := 'hash does not match the stored canonical payload';
      RETURN NEXT;
      RETURN;
    END IF;

    v_expected := r.hash;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION audit.verify_chain(uuid) TO app_rw;
