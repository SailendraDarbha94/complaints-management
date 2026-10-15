-- 0021_mail_sender_check.sql
--
-- Who sent a message to the intake mailbox, and whether the mail provider could confirm it.
--
-- KSDC's complaints reach the intake mailbox only as forwards from the Registrar's address.
-- Measured on the real mailbox on 15 October 2026: of 21 messages, 3 were from the
-- Registrar and the other 18 were software marketing and the mail provider's own notices.
-- Each of those was a card the officer had to set aside by hand and, with the assistant
-- reading automatically, a model call paid for to be told it was not a complaint.
--
-- So a council can now name the addresses its complaints come from (intakeSenders in its
-- configuration), and every message is checked against that list on arrival, by the
-- address that sent it to the intake mailbox - not the complainant inside a forward:
--
--   verified     a listed address, and the mail provider confirmed it - the sending
--                domain signed it, or its mail server was allowed to send for it. As before.
--   unverified   a listed address the provider could NOT confirm. A From line can be
--                written by anybody, so this one waits in the tray, marked, and never files
--                itself by a case number; nor does the assistant read it on its own. It is
--                not set aside: a genuine complaint must not disappear because a signature
--                broke on the way.
--   not_allowed  any other address. Set aside on arrival with a reason, and nothing else is
--                done with it. It can be brought back from "Set aside".
--
-- NULL is every message that arrived before this migration, or while the council had no
-- list: the register then made no check, and says nothing about the sender.
--
-- Text with a CHECK rather than a new enum type, so that a fourth answer later is a
-- constraint swapped in a migration rather than an ALTER TYPE that cannot run inside a
-- transaction. Nullable with no default: adding it is a catalogue change and does not
-- rewrite the table. IF NOT EXISTS and the guarded constraint make it safe to run twice.
-- Table-level grants from 0013 cover the new column.

ALTER TABLE public.mail_message
  ADD COLUMN IF NOT EXISTS sender_check text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mail_message_sender_check_known'
      AND conrelid = 'public.mail_message'::regclass
  ) THEN
    ALTER TABLE public.mail_message
      ADD CONSTRAINT mail_message_sender_check_known
      CHECK (sender_check IN ('verified', 'unverified', 'not_allowed'));
  END IF;
END
$$;

COMMENT ON COLUMN public.mail_message.sender_check IS
  'The envelope sender against the council''s intakeSenders list, on arrival: verified, '
  'unverified (listed, but the mail provider could not confirm it - never files itself) or '
  'not_allowed (not listed - set aside on arrival). NULL: no list was configured.';
