-- 0013_mail_intake.sql
--
-- The inward mail tray.
--
-- The officer forwards a complaint to a mailbox the software watches. This is where that
-- message lands: as itself, first, before anybody decides what it is. A message is not a
-- case. Most forwards are complaints, some are replies on a case already open, and some
-- are circulars, duplicates or misdirected mail. Turning every one of them into a case
-- would spend a serial from a legal register on a piece of spam, and a voided entry in
-- that book is a harder thing to explain than an empty tray.
--
-- So: every message is stored, exactly one of three things happens to it, and which one is
-- recorded on the row.
--
--   unfiled    it is waiting for the officer. This is the tray.
--   filed      it belongs to a case - either the officer said so, or it quoted a case
--              number and filed itself.
--   dismissed  it is not a complaint. With a reason, because a message cannot vanish.
--
-- WHAT IS DELIBERATELY NOT HERE: the raw bytes of the message.
--
-- We store the readable content, the parsed original, and a sha256 of the complete raw
-- source. We do not keep the source itself. The reason is that we already have a verbatim
-- archival copy and it is better than anything this database would hold: the mailbox. The
-- reader connects with EXAMINE and BODY.PEEK, so it never marks a message read, never
-- moves one and never deletes one - the original sits in Gmail exactly as it arrived, and
-- the sha256 here is what ties this row to it. If that ever stops being true, this is the
-- decision to revisit first.

-- ---------------------------------------------------------------------------
-- 1. Vocabulary
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mail_status') THEN
    CREATE TYPE mail_status AS ENUM ('unfiled', 'filed', 'dismissed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mail_match_rung') THEN
    -- How a message came to be attached to a case. Recorded on the row because "why is
    -- this letter on this file" is a question somebody will ask in two years, and
    -- "a human clicked it" and "it quoted the number" are very different answers.
    CREATE TYPE mail_match_rung AS ENUM (
      'reference_subject',  -- the case number was in the subject line. The strongest signal.
      'reference_body',     -- the case number was in the body, usually a quoted reply.
      'sender',             -- an address we know. SUGGESTS ONLY - never files by itself.
      'officer'             -- a person decided.
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mail_forward_kind') THEN
    -- Which shape of forward we unwrapped, so a parser regression can be traced to the
    -- client that produced it rather than guessed at.
    CREATE TYPE mail_forward_kind AS ENUM (
      'rfc822_attachment',  -- forwarded as an attachment. The only timezone-safe form.
      'gmail',
      'outlook_web',
      'outlook_desktop',
      'apple_mail',
      'generic',
      'none'                -- not a forward: somebody wrote to us directly.
    );
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. The message
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mail_message (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  council_id          uuid NOT NULL REFERENCES public.council(id) ON DELETE RESTRICT,

  -- --- Identity, and the three-part answer to "have we seen this before" -----
  --
  -- gm_msg_id is Gmail's own X-GM-MSGID: stable, server-assigned, and the one identifier
  -- the sender cannot influence. Preferred when present.
  --
  -- message_id is the RFC 5322 header. It is sender-controlled, optional under the
  -- standard, and can legitimately repeat. Deduping on it alone would silently DROP a
  -- genuine second complaint, which in a statutory register is data loss, not a tidy-up.
  --
  -- raw_sha256 is the hash of the complete raw source and is the guard that never lies:
  -- the same message_id with a different hash is a different email and must be ingested.
  gm_msg_id           text,
  message_id          text,
  raw_sha256          text NOT NULL,

  -- The IMAP cursor this came from. uid_validity is text because it is a 32-bit unsigned
  -- value that the client hands back as a BigInt, and because comparing it is all we ever
  -- do with it. When the server changes it, every stored uid is meaningless and the reader
  -- rescans from the beginning - the unique indexes below are what make that safe.
  mailbox             text NOT NULL,
  uid                 bigint,
  uid_validity        text,

  -- --- The envelope, as it actually arrived -------------------------------
  --
  -- On a forward this is the OFFICER, not the complainant. That is not a defect to be
  -- corrected: it is the true record of how the message reached the Council, and the
  -- original sender is kept separately below.
  envelope_from       text NOT NULL,
  envelope_from_name  text,
  envelope_to         text,
  envelope_date       timestamptz NOT NULL,
  subject             text NOT NULL,

  in_reply_to         text,
  reference_ids       text[],

  body_text           text,
  body_html           text,
  -- What the card shows. Stored rather than derived so the tray renders in one query.
  snippet             text NOT NULL DEFAULT '',

  -- --- The original, dug out of a forward ---------------------------------
  --
  -- original_date is timestamptz and is set ONLY when the original came from a
  -- message/rfc822 attachment, where a real Date header with a real offset survives.
  -- In-body forward headers carry no timezone at all ("Date: Tue, 16 Sep 2026 at 19:12"),
  -- so parsing one into a timestamp would invent an offset - silently the server's, which
  -- is five and a half hours wrong the day this stops running in India. Those are kept as
  -- text, exactly as written, and shown to the officer as text.
  forward_kind        mail_forward_kind NOT NULL DEFAULT 'none',
  original_from       text,
  original_from_name  text,
  original_to         text,
  original_subject    text,
  original_date       timestamptz,
  original_date_text  text,
  original_body       text,

  -- --- What became of it ---------------------------------------------------
  status              mail_status NOT NULL DEFAULT 'unfiled',
  matched_rung        mail_match_rung,
  case_file_id        uuid REFERENCES public.case_file(id) ON DELETE RESTRICT,
  correspondence_id   uuid REFERENCES public.correspondence(id) ON DELETE SET NULL,
  -- A case the ladder found but would not file to on its own: the number resolved to a
  -- closed case, or two different numbers appeared, or the only signal was the sender.
  suggested_case_file_id uuid REFERENCES public.case_file(id) ON DELETE SET NULL,
  suggestion_note     text,

  filed_at            timestamptz,
  filed_by            uuid REFERENCES public.app_user(id) ON DELETE SET NULL,
  dismissed_at        timestamptz,
  dismissed_reason    text,
  dismissed_by        uuid REFERENCES public.app_user(id) ON DELETE SET NULL,

  -- When the software ingested it, which is not when it was sent.
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES public.app_user(id) ON DELETE SET NULL,

  -- A dismissal without a reason is a message that vanished.
  CONSTRAINT mail_dismissed_needs_reason
    CHECK (status <> 'dismissed' OR (dismissed_reason IS NOT NULL AND dismissed_at IS NOT NULL)),
  -- A filed message is on something.
  CONSTRAINT mail_filed_needs_case
    CHECK (status <> 'filed' OR (case_file_id IS NOT NULL AND filed_at IS NOT NULL))
);

-- The dedupe guards, as real constraints rather than an application-level check, because
-- the reader reconnects, rescans and races itself and the database is the only place that
-- can arbitrate. Both are partial: gm_msg_id is absent on a non-Gmail server, and the
-- raw hash is the fallback that is always present.
CREATE UNIQUE INDEX IF NOT EXISTS mail_message_gm_uq
  ON public.mail_message (council_id, gm_msg_id) WHERE gm_msg_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mail_message_raw_uq
  ON public.mail_message (council_id, raw_sha256);

-- The tray, newest first. Partial, because the tray is the only hot read.
CREATE INDEX IF NOT EXISTS mail_message_tray_ix
  ON public.mail_message (council_id, ingested_at DESC) WHERE status = 'unfiled';
CREATE INDEX IF NOT EXISTS mail_message_case_ix
  ON public.mail_message (council_id, case_file_id) WHERE case_file_id IS NOT NULL;

COMMENT ON COLUMN public.mail_message.envelope_from IS
  'Who sent it to us. On a forward this is the officer, which is the truth about how the '
  'message reached the Council. The complainant is in original_from.';
COMMENT ON COLUMN public.mail_message.original_date IS
  'Set only from a message/rfc822 attachment, where a real UTC offset survives. In-body '
  'forward headers carry no timezone, so those are kept verbatim in original_date_text.';

-- ---------------------------------------------------------------------------
-- 3. Attachments
-- ---------------------------------------------------------------------------
--
-- An attachment is staged into object storage at ingest and becomes a case document only
-- when the message is filed. Until then it sits in staging under its own key, which is why
-- the key is recorded here: without it the bytes would be unreachable and the officer
-- would be looking at a complaint whose bills had been thrown away.
--
-- skipped_reason is the important column. The register accepts PDFs and images; real mail
-- also carries .docx, .zip, calendar invitations and signature logos. Those are refused,
-- and refusing them silently would leave the officer believing they had everything.

CREATE TABLE IF NOT EXISTS public.mail_attachment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  council_id        uuid NOT NULL REFERENCES public.council(id) ON DELETE RESTRICT,
  mail_message_id   uuid NOT NULL REFERENCES public.mail_message(id) ON DELETE RESTRICT,

  filename          text NOT NULL,
  declared_type     text,
  size_bytes        bigint NOT NULL,
  sha256            text NOT NULL,

  -- Where the bytes are while the message waits in the tray. Null when it was refused.
  staging_key       text,
  -- Set when the message was filed and this became part of a case file.
  document_id       uuid REFERENCES public.document(id) ON DELETE SET NULL,
  -- Why it is not on the case: an unsupported type, or too large.
  skipped_reason    text,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_attachment_message_ix
  ON public.mail_attachment (council_id, mail_message_id);

-- ---------------------------------------------------------------------------
-- 4. Two additions to existing tables
-- ---------------------------------------------------------------------------

-- The Message-ID of a letter, so an inbound reply can one day be threaded onto the
-- outbound letter it answers rather than only onto the case. Nothing writes this yet -
-- Phase 1 letters are sent by hand from webmail and have no Message-ID we control - but
-- the inbound half does write it, and a reply that threads perfectly should not fall to
-- the tray for want of a column.
ALTER TABLE public.correspondence
  ADD COLUMN IF NOT EXISTS message_id text;

CREATE UNIQUE INDEX IF NOT EXISTS correspondence_message_id_uq
  ON public.correspondence (council_id, message_id) WHERE message_id IS NOT NULL;

-- The sender rung compares lower(email), because party.email is stored exactly as it was
-- typed at intake and 'Kdevi@Example.in' must match 'kdevi@example.in'. app_user already
-- sets the precedent with app_user_email_uq on lower(email).
CREATE INDEX IF NOT EXISTS party_email_ix
  ON public.party (council_id, lower(email)) WHERE email IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. The mail robot
-- ---------------------------------------------------------------------------
--
-- A background job writing with app.user_id unset makes every audit row carry
-- metadata {"unattributed": true}, which 0001 describes as the canary for a write that
-- reached the database without going through withCouncil(). It should never be true, and
-- an alert fires when it is - so the ingest job must write as SOMEBODY.
--
-- This is that somebody: a named non-human actor with no council membership, so it can
-- never sign in and can never be given a role. It exists to put a name in the audit trail,
-- and "the mail robot filed this" is a truthful and useful thing for that trail to say.
-- A fixed, well-known id, so the ingest job can reference it without a lookup and so it
-- is recognisable on sight in an audit row. The all-zero prefix is not used by any seed.
INSERT INTO public.app_user (id, email, full_name, is_active)
VALUES ('00000000-0000-4000-8000-000000000001'::uuid, 'mail-robot@ksdc.invalid',
        'Mail intake (automatic)', true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. Row-level security and the audit trigger
-- ---------------------------------------------------------------------------
--
-- The two loops from 0001, re-run. They are per-migration snapshots rather than standing
-- rules, so a new table carrying council_id has NO tenant isolation and NO audit trail
-- until a migration re-runs them - and of every table in this database, the one holding
-- raw inbound mail is the worst to leave unprotected.

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

GRANT SELECT, INSERT, UPDATE ON public.mail_message, public.mail_attachment TO app_rw;
REVOKE DELETE ON public.mail_message, public.mail_attachment FROM app_rw;

-- Not granted to the mobile app. A committee member reads a case file before a sitting;
-- an unsorted tray of the Council's inbound mail, including messages about cases they are
-- not hearing and messages that turned out not to be complaints at all, is not that.
REVOKE ALL ON public.mail_message, public.mail_attachment FROM anon, authenticated;
