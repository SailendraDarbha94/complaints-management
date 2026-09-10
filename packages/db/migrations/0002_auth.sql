-- 0002_auth.sql
--
-- Passwordless email sign-in.
--
-- destructive-migration-approved: auth_otp.attempts was declared text by mistake and has
-- never held a real row (no council has signed in yet - the API was still accepting
-- development identity headers). Correcting it now costs nothing; leaving it means every
-- increment reads `(attempts::int + 1)::text` forever.

-- ---------------------------------------------------------------------------
-- auth_otp
-- ---------------------------------------------------------------------------

-- The existing default is the text '0', and Postgres will not cast a default
-- automatically. Drop it, change the type, then set the correct default.
ALTER TABLE auth_otp
  ALTER COLUMN attempts DROP DEFAULT;

ALTER TABLE auth_otp
  ALTER COLUMN attempts TYPE integer USING attempts::integer;

ALTER TABLE auth_otp
  ALTER COLUMN attempts SET DEFAULT 0;

-- A code is issued either to sign in, or to confirm a consequential action already taken
-- while signed in (a register export, closing a case). The two must never be
-- interchangeable: a step-up code phished from an inbox must not create a session.
ALTER TABLE auth_otp
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'sign_in';

ALTER TABLE auth_otp
  ADD CONSTRAINT auth_otp_purpose_known
  CHECK (purpose IN ('sign_in', 'step_up'));

-- Rate limiting counts recent requests per address. Without this index that count is a
-- sequential scan on every sign-in attempt - which is exactly the query an attacker
-- would be making thousands of.
CREATE INDEX IF NOT EXISTS auth_otp_rate_ix
  ON auth_otp (lower(email), created_at DESC);

-- At most one live code per address and purpose. Requesting a second code invalidates the
-- first (the service consumes it), so this is a belt-and-braces guard against two codes
-- being valid at once, which would double an attacker's guessing budget.
CREATE UNIQUE INDEX IF NOT EXISTS auth_otp_live_uq
  ON auth_otp (lower(email), purpose)
  WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- auth_session
-- ---------------------------------------------------------------------------

-- Refresh tokens rotate on every use. Presenting a token that has already been rotated
-- means it was captured, so the whole family is revoked rather than just that token.
CREATE INDEX IF NOT EXISTS auth_session_family_ix
  ON auth_session (family_id)
  WHERE revoked_at IS NULL;

-- Sweeping expired sessions, and showing the officer their own active devices.
CREATE INDEX IF NOT EXISTS auth_session_expiry_ix
  ON auth_session (expires_at)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- notification_log
-- ---------------------------------------------------------------------------

-- The digest records which follow-ups it reported, so "why did it not tell me about
-- KSDC/COMP/2026-27/0004?" has an answer that does not require re-deriving the queue as
-- it stood at 09:00 last Tuesday.
ALTER TABLE notification_log
  ADD COLUMN IF NOT EXISTS payload jsonb;

GRANT SELECT, INSERT, UPDATE ON auth_otp, auth_session, notification_log TO app_rw;
