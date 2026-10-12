-- 0018_mail_suggestion_attachments.sql
--
-- The mail assistant may now READ an attachment - a scanned complaint letter sent with an
-- empty email, a referral whose details are only in the enclosure - when the email alone
-- does not let it decide. It asks for one file at a time, and only when the attachment
-- reader is switched on (MAIL_ASSISTANT_ATTACHMENTS=on).
--
-- A file it reads is SENT TO ANTHROPIC, outside India. That is the one thing about a
-- suggestion the Council most needs to be able to answer afterwards: which of this
-- complainant's papers left the building, and how much of each. So every suggestion now
-- records exactly that, beside what it cost:
--
--   [{"ref": "a1", "filename": "complaint.pdf", "pagesSent": 10, "pagesTotal": 14}, ...]
--
-- One entry per file whose contents went to the model; pagesSent and pagesTotal are null
-- for an image. An empty array - the default, and the value for every row written before
-- this migration - means nothing but the email itself was sent.
--
-- On FAILED rows too. A reading that read two files and then failed has still sent them,
-- and a record that only described the successes would understate what left.
--
-- NOT NULL with a default rather than nullable: "nothing was sent" and "we do not know
-- what was sent" must not look the same, and every row before this one is the first.
-- Adding a column with a constant default is a catalogue change in Postgres 11+, so this
-- does not rewrite the table.

ALTER TABLE public.mail_suggestion
  ADD COLUMN IF NOT EXISTS attachments_read jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Always a list. The service writes nothing else, and the screens read it as one; a
-- scalar or an object here would be a row the card cannot show and the report cannot add.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mail_suggestion_attachments_read_is_array'
      AND conrelid = 'public.mail_suggestion'::regclass
  ) THEN
    ALTER TABLE public.mail_suggestion
      ADD CONSTRAINT mail_suggestion_attachments_read_is_array
      CHECK (jsonb_typeof(attachments_read) = 'array');
  END IF;
END
$$;

COMMENT ON COLUMN public.mail_suggestion.attachments_read IS
  'The attachments whose contents this reading sent to the model (and so to Anthropic): '
  '[{ref, filename, pagesSent, pagesTotal}]. Empty when only the email was sent.';
