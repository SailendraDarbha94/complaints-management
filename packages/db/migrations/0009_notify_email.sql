-- 0009_notify_email.sql
--
-- Where a person is actually reachable, as distinct from who they are.
--
-- app_user.email has been doing three jobs at once: the address of record for an officer,
-- the destination of the daily digest, and the key linkUser matches a Supabase login on.
-- At KSDC those three want different values, and the collision is not theoretical - it is
-- live right now.
--
--   The address of record is officer@ksdc.in. That is what belongs in a statutory body's
--   register: it names a POST, it is right in correspondence and in an RTI reply, and it
--   stays true when the person holding the post changes.
--
--   No mail arrives there. The officer's real inbox is registrar@ksdc.in - which is the
--   one address this system refuses to write to, because it is where complaints land and
--   it is the pile the digest exists to help them escape.
--
--   So the digest has been sending to an address nobody reads, every morning, reporting
--   success. The single reminder this product exists to deliver was going nowhere.
--
-- notify_email is the fix, and it is deliberately NOT the same field: the address of
-- record should not drift to whatever inbox somebody happened to use, and the address a
-- person reads should not have to be a council one.
--
-- What may be SENT there is a separate question, answered in digest.service.ts. In short:
-- an address on the council's own domain gets the full digest; anywhere else gets counts
-- and a link, with no case number, no summary and no name. A reminder to go and look can
-- travel anywhere. Complaint content stays on council infrastructure.

ALTER TABLE public.app_user ADD COLUMN IF NOT EXISTS notify_email text;

COMMENT ON COLUMN public.app_user.email IS
  'The address of record for this person. Names the post, appears in correspondence and '
  'RTI replies, and survives a change of post-holder. Not necessarily an inbox anyone reads.';

COMMENT ON COLUMN public.app_user.notify_email IS
  'Where reminders actually reach this person. NULL means use email. An address outside '
  'the council domain receives counts and a link only - never case content.';
