-- 0017_mail_suggestion.sql
--
-- The mail assistant, stage 1: it suggests, the officer decides.
--
-- Every message that lands in the tray unfiled can be read by a language model, which
-- SUGGESTS one of four things: open a case (with a one-line summary, the complainant and
-- the dentists to name), add it to a case already open, set it aside as not a complaint,
-- or "unsure". The officer sees the suggestion on the card and accepts it, changes it and
-- accepts it, rejects it - or ignores it and uses the ordinary buttons.
--
-- NOTHING THE MODEL DOES CHANGES THE REGISTER. Its tools only read. A suggestion becomes a
-- change only when the officer clicks, and then it is carried out by the same services the
-- ordinary buttons use, so an accepted suggestion and a hand-made decision leave exactly
-- the same rows behind. This table is therefore not part of the register: it is the
-- record of what was suggested, what it cost, and what the officer did about it.
--
-- WHY EVERY OUTCOME IS KEPT, INCLUDING THE ONES NOBODY CLICKED. The question this feature
-- has to answer before it is ever trusted with more is "how often was it right?". If only
-- accepted suggestions were recorded, the answer would be 100 per cent by construction.
-- So when the officer acts through the ordinary buttons on a message that had a
-- suggestion, that is recorded too ('handled'), with whether what they did matched.
--
-- WHY A ROW PER ATTEMPT, NOT ONE PER MESSAGE. Asking again replaces the suggestion on the
-- card ('superseded'), but the old row stays: it cost money, and the cost has to add up.

-- ---------------------------------------------------------------------------
-- 1. Vocabulary
-- ---------------------------------------------------------------------------
--
-- From packages/contracts (MAIL_SUGGESTION_DECISIONS / _CONFIDENCES / _STATUSES), value
-- for value. The drizzle enums are generated from the same tuples.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mail_suggestion_decision') THEN
    -- 'unsure' is a real answer, not a failure: a suggestion the model cannot stand
    -- behind is worse than none.
    CREATE TYPE mail_suggestion_decision AS ENUM (
      'new_complaint',
      'follow_up',
      'not_a_complaint',
      'unsure'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mail_suggestion_confidence') THEN
    CREATE TYPE mail_suggestion_confidence AS ENUM ('high', 'medium', 'low');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mail_suggestion_status') THEN
    CREATE TYPE mail_suggestion_status AS ENUM (
      'pending',     -- on the card; nobody has acted
      'accepted',    -- the officer accepted it as it was
      'edited',      -- the officer accepted it after changing something
      'rejected',    -- the officer said no, explicitly
      'handled',     -- the officer used the ordinary buttons instead; see outcome_agreed
      'superseded',  -- a newer suggestion for the same message replaced it
      'failed'       -- no suggestion could be made; error says why
    );
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. The suggestion
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mail_suggestion (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  council_id            uuid NOT NULL REFERENCES public.council(id) ON DELETE RESTRICT,
  mail_message_id       uuid NOT NULL REFERENCES public.mail_message(id) ON DELETE RESTRICT,

  status                mail_suggestion_status NOT NULL DEFAULT 'pending',

  -- --- What was suggested --------------------------------------------------
  --
  -- decision, confidence and reasoning are columns because the report counts and groups
  -- by them. The whole proposal - summary, complainant, dentists, case number - is kept
  -- as the model returned it, so "what exactly did it suggest" can be answered later
  -- without depending on how the card happened to display it at the time.
  decision              mail_suggestion_decision,
  confidence            mail_suggestion_confidence,
  reasoning             text,
  proposal              jsonb,

  -- --- How, and at what cost ----------------------------------------------
  --
  -- The model and the playbook's sha256 are recorded on every row, so a change in how
  -- often it is right can be traced to a change in either. The playbook text itself is
  -- in packages/config, under version control; the hash is what ties a row to a commit.
  model                 text NOT NULL,
  effort                text NOT NULL,
  playbook_version      text NOT NULL,
  input_tokens          integer NOT NULL DEFAULT 0,
  output_tokens         integer NOT NULL DEFAULT 0,
  cache_read_tokens     integer NOT NULL DEFAULT 0,
  cache_write_tokens    integer NOT NULL DEFAULT 0,
  tool_calls            integer NOT NULL DEFAULT 0,
  -- Dollars, to the millionth: a single suggestion costs cents, and a month's total is
  -- the sum of hundreds of them, so rounding each to the cent would lose real money.
  cost_usd              numeric(10, 6) NOT NULL DEFAULT 0,
  -- Plain English, safe to show the officer. Never the email's text.
  error                 text,

  -- --- What the officer did -----------------------------------------------
  --
  -- outcome_agreed is the column the whole table exists for: did what happened match the
  -- suggestion? Null for 'unsure' (there was nothing to agree with) and for a rejection
  -- (the officer has not yet done anything else; the report counts a rejection as a
  -- disagreement on its own).
  outcome_action        text,
  outcome_case_file_id  uuid REFERENCES public.case_file(id) ON DELETE RESTRICT,
  outcome_agreed        boolean,
  outcome_note          text,
  acted_at              timestamptz,
  acted_by              uuid REFERENCES public.app_user(id) ON DELETE SET NULL,

  created_at            timestamptz NOT NULL DEFAULT now(),
  -- The mail robot when the reader asked, the officer when they pressed "ask again".
  created_by            uuid REFERENCES public.app_user(id) ON DELETE SET NULL,

  CONSTRAINT mail_suggestion_outcome_action_ck
    CHECK (outcome_action IS NULL
        OR outcome_action IN ('opened_case', 'filed_on_case', 'set_aside', 'rejected')),
  -- A suggestion that was acted on says what was done and when. Otherwise the agreement
  -- figure would be counting decisions nobody can point to.
  CONSTRAINT mail_suggestion_acted_has_outcome
    CHECK (status NOT IN ('accepted', 'edited', 'rejected', 'handled')
        OR (outcome_action IS NOT NULL AND acted_at IS NOT NULL)),
  -- A failure says why; anything else says what it suggested.
  CONSTRAINT mail_suggestion_failed_says_why
    CHECK (status <> 'failed' OR error IS NOT NULL),
  CONSTRAINT mail_suggestion_has_decision
    CHECK (status = 'failed' OR decision IS NOT NULL),
  CONSTRAINT mail_suggestion_counts_not_negative
    CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cache_read_tokens >= 0
       AND cache_write_tokens >= 0 AND tool_calls >= 0 AND cost_usd >= 0)
);

-- One suggestion on the card at a time. Asking again supersedes the pending one in the
-- same transaction as it inserts the new one, under a lock on the message. This index is
-- the floor beneath that: whatever path writes here, one email can never carry two
-- live sets of Accept buttons that disagree with each other.
CREATE UNIQUE INDEX IF NOT EXISTS mail_suggestion_one_pending_uq
  ON public.mail_suggestion (council_id, mail_message_id) WHERE status = 'pending';

-- The tray and the message page: the latest suggestion for each message.
CREATE INDEX IF NOT EXISTS mail_suggestion_message_ix
  ON public.mail_suggestion (council_id, mail_message_id, created_at DESC);

-- The daily limit and the monthly report, both of which count by when a row was made.
CREATE INDEX IF NOT EXISTS mail_suggestion_created_ix
  ON public.mail_suggestion (council_id, created_at);

COMMENT ON TABLE public.mail_suggestion IS
  'What the mail assistant suggested for a message in the tray, what it cost, and what '
  'the officer did. Not part of the register: nothing here is changed by the model, and '
  'every change to the register is made by the officer through the ordinary services.';
COMMENT ON COLUMN public.mail_suggestion.outcome_agreed IS
  'Did what the officer did match the suggestion? Null for unsure and for rejections.';

-- ---------------------------------------------------------------------------
-- 3. Row-level security and the audit trigger
-- ---------------------------------------------------------------------------
--
-- The two loops from 0001, re-run, exactly as 0011 and 0013 do. They are per-migration
-- snapshots rather than standing rules, so a new table carrying council_id has NO tenant
-- isolation and NO audit trail until a migration re-runs them. A table that records what
-- the officer did with each piece of the Council's mail is not one to leave without
-- either.

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

-- The application role. Said out loud, as 0011 and 0013 do, because a migration applied
-- by a different grantor would not pick up 0001's default privileges. Never DELETE: a
-- suggestion that could be removed would let the agreement figure be tidied.
GRANT SELECT, INSERT, UPDATE ON public.mail_suggestion TO app_rw;
REVOKE DELETE ON public.mail_suggestion FROM app_rw;

-- Not granted to the mobile app. What an assistant made of the Council's inbound mail -
-- including mail that turned out not to be a complaint - is not part of a case file a
-- committee member reads before a sitting.
REVOKE ALL ON public.mail_suggestion FROM anon, authenticated;
