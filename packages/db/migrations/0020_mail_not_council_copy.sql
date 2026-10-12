-- 0020_mail_not_council_copy.sql
--
-- The officer's answer, kept: "this is not a copy of the Council's letter".
--
-- The register decides from a message's addresses whether it is a copy of a letter the
-- Council itself sent (packages/core/src/modules/mail/council-copy.ts). That decision is
-- worked out again every time the message is read, and it can be wrong: a patient's reply
-- that quotes our letter, forwarded in a layout the register misread, looks like the
-- Council writing to the patient. The officer can say so - "it is a reply, add it as
-- received", or "it is a complaint, open a case" - and the message is filed as what it is.
--
-- Until now nothing remembered that answer. The message page went on calling the message
-- "a copy of the Council's letter" while the case page listed it as mail received, and if
-- the case was later cancelled as opened in error the message went back to the tray as a
-- copy again, for the officer to correct a second time.
--
-- not_council_copy_at is when the officer said it is not a copy. Set, the register treats
-- the message as ordinary mail wherever it asks whether it is a copy. NULL - every row
-- before this migration, and every message nobody has corrected - leaves the register's
-- own reading in charge.
--
-- Nullable with no default: adding it is a catalogue change and does not rewrite the
-- table. IF NOT EXISTS makes it safe to run twice. Table-level grants from 0013 cover it.

ALTER TABLE public.mail_message
  ADD COLUMN IF NOT EXISTS not_council_copy_at timestamptz;
