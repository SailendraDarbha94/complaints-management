-- 0014: a forward whose quoted header block has no separator line above it.
--
-- Roundcube - the webmail on the Council's own ksdc.in account - forwards a message as a
-- bare table of From / Subject / Date / To rows, with no "Forwarded message" line above
-- it. The unwrapper recognised none of the shapes it knew, filed the forward as sent to
-- us directly, and the case it opened named the Council's own registrar address as the
-- complainant. The fix finds that header block without a separator (only when the subject
-- says Fwd:), and records that it did so under its own name, so a mistake in that looser
-- route can be told apart from the stricter ones.
--
-- ADD VALUE is additive and safe inside a transaction in PostgreSQL 12 and later, provided
-- the new value is not used in the same transaction. Nothing below uses it.

ALTER TYPE mail_forward_kind ADD VALUE IF NOT EXISTS 'header_block';
