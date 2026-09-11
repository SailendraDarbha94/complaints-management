-- 0011_rti.sql
--
-- The RTI register: a second book, not a row in the first one.
--
-- An RTI application has its own statute, its own thirty-day clock, its own appeal route
-- and a penalty that lands on a named officer's salary rather than on the council. Filing
-- it as a case kind would put a statutory deadline through machinery built for a grievance
-- that has no deadline at all, and would make every complaints report wrong.
--
-- THE ONE CONSTRAINT WORTH READING THIS FILE FOR:
--
--   rti_exemption_section contains section 8(1)(a) to (j) and section 9. It does NOT
--   contain section 11, and it never may. You can never refuse information UNDER s.11 --
--   s.11 is the procedure you follow before disclosing third-party information, and two
--   CIC decisions are explicit that a refusal must rest on s.8(1) or s.9. Because the
--   grounds are an enum rather than free text, "refused under s.11" is not merely
--   discouraged in the interface: it cannot be stored at all.
--
-- Everything else here follows the patterns already in this database. RLS and the audit
-- trigger are applied by re-running the two loops from 0001 over the new tables; grants to
-- app_rw arrive through the ALTER DEFAULT PRIVILEGES set there; and 0006's default-privilege
-- revocation keeps anon, authenticated and service_role off these tables unless a later
-- migration grants them deliberately, one table at a time.
--
-- Research and section numbers: docs/rti-mechanics-2026-09-11.md.

-- ---------------------------------------------------------------------------
-- 1. Vocabulary
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rti_state') THEN
    CREATE TYPE rti_state AS ENUM (
      'received',
      'fee_awaited',
      'third_party_consultation',
      'transferred',
      'replied',
      'closed'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rti_channel') THEN
    CREATE TYPE rti_channel AS ENUM ('post', 'email', 'by_hand', 'transferred_in', 'other');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rti_decision') THEN
    CREATE TYPE rti_decision AS ENUM (
      'information_supplied',
      'partly_supplied',
      'refused',
      'information_not_held',
      'transferred',
      -- Not a refusal. An applicant who asks a question rather than seeking a record is
      -- outside s.2(f), and answering that with a s.8 ground would be wrong and appealable.
      'query_not_information'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rti_exemption_section') THEN
    -- s.8(1)(a) to (j) and s.9. There is no s.11 here. See the note at the top.
    CREATE TYPE rti_exemption_section AS ENUM (
      's8_1_a', 's8_1_b', 's8_1_c', 's8_1_d', 's8_1_e',
      's8_1_f', 's8_1_g', 's8_1_h', 's8_1_i', 's8_1_j',
      's9'
    );
  END IF;
END
$$;

COMMENT ON TYPE rti_exemption_section IS
  'Grounds for withholding: s.8(1)(a)-(j) and s.9 of the RTI Act 2005. Section 11 is '
  'procedure, never a ground, and must never be added to this type -- a refusal citing it '
  'is defective on its face and appealable.';

-- The RTI clocks join the follow-up engine, so the engine needs their names. ADD VALUE is
-- additive and safe inside a transaction in PostgreSQL 12 and later, provided the new
-- values are not used in the same transaction. Nothing below inserts a follow-up.
ALTER TYPE followup_stage ADD VALUE IF NOT EXISTS 'rti_reply_due';
ALTER TYPE followup_stage ADD VALUE IF NOT EXISTS 'rti_prepare_reply';
ALTER TYPE followup_stage ADD VALUE IF NOT EXISTS 'rti_await_fee';
ALTER TYPE followup_stage ADD VALUE IF NOT EXISTS 'rti_await_third_party';

-- ---------------------------------------------------------------------------
-- 2. The application
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.rti_request (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  council_id                uuid NOT NULL REFERENCES public.council(id) ON DELETE RESTRICT,

  rti_no                    text NOT NULL,
  fiscal_year               text NOT NULL,
  register_sl_no            integer NOT NULL,

  -- THE clock origin. The authority's own inward date, not the date on the letter and not
  -- the day it was typed in. Every period in the Act runs from this one column.
  received_on               date NOT NULL,
  received_via              rti_channel NOT NULL,
  date_source               date_source NOT NULL DEFAULT 'recorded',

  -- s.6(2) forbids asking an applicant why they want the information, so there is nowhere
  -- here to record a reason. The absence of that column is the rule being enforced.
  applicant_name            text NOT NULL,
  applicant_address_lines   jsonb NOT NULL DEFAULT '[]'::jsonb,
  applicant_email           text,
  applicant_phone           text,
  is_bpl                    boolean NOT NULL DEFAULT false,

  -- In their words, without paraphrase. The scope of the request is what every later
  -- argument turns on; a summary written by the officer would be the officer's account of
  -- the question they then answered.
  request_text              text NOT NULL,
  external_ref_no           text,

  application_fee_received  boolean NOT NULL DEFAULT false,
  -- s.7(3)(a): the only true stop-the-clock in the Act. Both dates or no exclusion.
  further_fee_intimated_on  date,
  further_fee_amount        numeric(10, 2),
  further_fee_paid_on       date,

  -- s.6(3). Later than five days and this officer keeps the personal exposure for the
  -- overshoot; the register records the date whatever it is.
  transferred_to            text,
  transferred_on            date,

  -- s.7(1) proviso. Forty-eight hours, but only on demonstrably proven danger, so the
  -- officer's reasoned view on that claim is recorded beside the flag.
  life_or_liberty           boolean NOT NULL DEFAULT false,
  life_or_liberty_reason    text,

  -- s.11(1). The trigger is the officer's INTENTION TO DISCLOSE third-party information,
  -- not the presence of a third party in the file -- and on these files there is a third
  -- party in every single one. Recording the intention as a dated decision is what makes
  -- the forty-day period lawful rather than assumed.
  intends_to_disclose_third_party_on date,
  third_party_name          text,
  third_party_notice_sent_on     date,
  -- THEIR receipt. The ten days of s.11(2) runs from here, not from despatch, and the
  -- council cannot know this date until the acknowledgement card comes back.
  third_party_notice_received_on date,
  third_party_representation_on  date,
  third_party_objected      boolean,
  third_party_representation_note text,

  state                     rti_state NOT NULL DEFAULT 'received',
  decision                  rti_decision,
  decided_on                date,
  decision_reasons          text,

  reply_correspondence_id   uuid REFERENCES public.correspondence(id) ON DELETE SET NULL,
  reply_despatched_on       date,

  -- The statutory date, derived here and never written by the application, for the same
  -- reason case_file.waiting_on is derived: a deadline the application computes is a
  -- deadline that can drift from the dates it was computed from, and this one carries a
  -- penalty of Rs 250 a day out of a named officer's salary.
  --
  -- Two deliberate imprecisions, both in the safe direction:
  --   * forty-eight hours is rendered as two days, which is never later than the true
  --     deadline;
  --   * while a further fee is intimated and unpaid the exclusion counts as zero, so the
  --     date shown is EARLIER than the true one. The alternative is a deadline that
  --     recedes indefinitely while an unpaid fee sits there.
  due_on date GENERATED ALWAYS AS (
    received_on
    + (CASE WHEN life_or_liberty THEN 2
            WHEN intends_to_disclose_third_party_on IS NOT NULL THEN 40
            ELSE 30 END)
    + COALESCE(further_fee_paid_on - further_fee_intimated_on, 0)
  ) STORED,

  closed_at                 timestamptz,
  closure_note              text,

  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid REFERENCES public.app_user(id) ON DELETE SET NULL,

  -- A fee intimation is meaningless without the date it went out, and an exclusion cannot
  -- be computed from a payment with no intimation before it.
  CONSTRAINT rti_fee_paid_needs_intimation
    CHECK (further_fee_paid_on IS NULL OR further_fee_intimated_on IS NOT NULL),
  CONSTRAINT rti_fee_paid_not_before_intimation
    CHECK (further_fee_paid_on IS NULL OR further_fee_paid_on >= further_fee_intimated_on),
  -- The statutory order of operations, as a constraint rather than a convention: the s.11
  -- notice cannot precede the decision that triggers it.
  CONSTRAINT rti_third_party_notice_needs_intent
    CHECK (third_party_notice_sent_on IS NULL OR intends_to_disclose_third_party_on IS NOT NULL),
  CONSTRAINT rti_life_or_liberty_needs_reason
    CHECK (life_or_liberty = false OR life_or_liberty_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS rti_request_no_uq
  ON public.rti_request (council_id, rti_no);
CREATE UNIQUE INDEX IF NOT EXISTS rti_request_sl_uq
  ON public.rti_request (council_id, fiscal_year, register_sl_no);
CREATE INDEX IF NOT EXISTS rti_request_due_ix
  ON public.rti_request (council_id, due_on) WHERE closed_at IS NULL;

COMMENT ON COLUMN public.rti_request.received_on IS
  'The authority inward date. Every statutory period in the Act runs from this column.';
COMMENT ON COLUMN public.rti_request.due_on IS
  'Derived. receipt + 30, or + 40 where s.11 applies, or + 2 for life or liberty, plus any '
  'period excluded under s.7(3)(a) while a further fee was outstanding.';

-- ---------------------------------------------------------------------------
-- 3. What it concerns, and on what grounds anything was withheld
-- ---------------------------------------------------------------------------

-- Optional and many-to-many, because both directions really happen: one application
-- asking about four complaints, and one complaint attracting applications from the
-- complainant and from the dentist in turn. Most applications link to nothing at all.
CREATE TABLE IF NOT EXISTS public.rti_case_link (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  council_id      uuid NOT NULL REFERENCES public.council(id) ON DELETE RESTRICT,
  rti_request_id  uuid NOT NULL REFERENCES public.rti_request(id) ON DELETE RESTRICT,
  case_file_id    uuid NOT NULL REFERENCES public.case_file(id) ON DELETE RESTRICT,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES public.app_user(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS rti_case_link_uq
  ON public.rti_case_link (rti_request_id, case_file_id);
CREATE INDEX IF NOT EXISTS rti_case_link_case_ix
  ON public.rti_case_link (council_id, case_file_id);

-- One row per ground per part of the request. A partial refusal genuinely cites more than
-- one, and s.7(8)(i) requires reasons -- a bare citation is not a reason, so `reasoning`
-- is NOT NULL.
CREATE TABLE IF NOT EXISTS public.rti_exemption_cited (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  council_id      uuid NOT NULL REFERENCES public.council(id) ON DELETE RESTRICT,
  rti_request_id  uuid NOT NULL REFERENCES public.rti_request(id) ON DELETE RESTRICT,
  section         rti_exemption_section NOT NULL,
  applies_to      text NOT NULL,
  reasoning       text NOT NULL,
  -- Re-deciding before the reply goes out is the officer changing their mind, and the
  -- grounds change with it. The old rows are withdrawn, never removed: the application
  -- role has no DELETE grant anywhere in this database, and on a quasi-judicial record
  -- "what did this office rely on, and when did it stop relying on it" is a question that
  -- has to have an answer.
  withdrawn_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES public.app_user(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS rti_exemption_request_ix
  ON public.rti_exemption_cited (council_id, rti_request_id);

-- ---------------------------------------------------------------------------
-- 4. Three anchors on existing tables
-- ---------------------------------------------------------------------------
--
-- follow_up, correspondence and document all hang off a case today. An RTI application is
-- not a case, so each gains a second, nullable anchor. Additive: every existing row keeps
-- a NULL here and behaves exactly as before.

ALTER TABLE public.follow_up
  ADD COLUMN IF NOT EXISTS rti_request_id uuid;
ALTER TABLE public.correspondence
  ADD COLUMN IF NOT EXISTS rti_request_id uuid;
ALTER TABLE public.document
  ADD COLUMN IF NOT EXISTS rti_request_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_rti_request_fk') THEN
    ALTER TABLE public.follow_up
      ADD CONSTRAINT follow_up_rti_request_fk
      FOREIGN KEY (rti_request_id) REFERENCES public.rti_request(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'correspondence_rti_request_fk') THEN
    ALTER TABLE public.correspondence
      ADD CONSTRAINT correspondence_rti_request_fk
      FOREIGN KEY (rti_request_id) REFERENCES public.rti_request(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_rti_request_fk') THEN
    ALTER TABLE public.document
      ADD CONSTRAINT document_rti_request_fk
      FOREIGN KEY (rti_request_id) REFERENCES public.rti_request(id) ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS follow_up_rti_ix
  ON public.follow_up (council_id, rti_request_id, status);
CREATE INDEX IF NOT EXISTS correspondence_rti_ix
  ON public.correspondence (council_id, rti_request_id, created_at);
CREATE INDEX IF NOT EXISTS document_rti_ix
  ON public.document (council_id, rti_request_id, created_at);

-- ---------------------------------------------------------------------------
-- 5. Row-level security and the audit trigger
-- ---------------------------------------------------------------------------
--
-- These are the two loops from 0001, re-run. They are written as loops rather than as
-- three explicit statements for one reason: the tenancy test walks pg_class and fails if
-- ANY public table carrying council_id lacks enabled-and-forced RLS with a policy, so a
-- fourth RTI table added in six months must be covered by whatever this file does. A loop
-- covers it; three hand-written statements would not, and the test would be the thing that
-- found out.
--
-- Idempotent, and identical in effect to 0001 for tables that already have them.

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

-- The application role. 0001 set ALTER DEFAULT PRIVILEGES so this is usually already true;
-- said out loud because a migration applied by a different grantor would not have picked
-- it up, and the failure mode is a permission error on the first RTI ever logged.
GRANT SELECT, INSERT, UPDATE ON public.rti_request, public.rti_case_link,
  public.rti_exemption_cited TO app_rw;
REVOKE DELETE ON public.rti_request, public.rti_case_link, public.rti_exemption_cited FROM app_rw;

-- Not granted to authenticated, and so unreachable from the mobile app whatever its
-- policies say. A committee member reads a case file before a sitting; the council's RTI
-- correspondence is not part of that, and the applicant's name and address are not theirs
-- to browse. Migration 0010 explains the layering.
REVOKE ALL ON public.rti_request, public.rti_case_link, public.rti_exemption_cited
  FROM anon, authenticated;
