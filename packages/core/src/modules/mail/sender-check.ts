import type { MailSenderCheck } from '@ksdc/contracts';

/**
 * Is this message really from the address on its From line?
 *
 * KSDC's complaints reach the intake mailbox only as forwards from the Registrar's address,
 * and the council's configuration can now say so (intakeSenders). That rule is only worth
 * having if it cannot be got round by typing the Registrar's address into a From line -
 * which anybody can do, with any mail program, in a minute. So "from the Registrar" here
 * means what the mail provider found when the message arrived: a DKIM signature - made
 * with a key the sending domain publishes - by the sender's own domain. A signature by
 * ksdc.in, on mail from registrar@ksdc.in, is ksdc.in vouching for it.
 *
 * SPF is NOT enough on its own, although the first version of this rule took it. SPF says
 * only that the server that handed the message over is one the domain lists as allowed to
 * send its mail - and ksdc.in's list (looked up on 15 October 2026) includes its web host's
 * whole shared mail service (include:webhostbox.net, and through it several more), used by
 * a great many unrelated customers. Any of them could send mail as registrar@ksdc.in and
 * pass SPF. And ksdc.in publishes no DMARC policy, so the provider does not turn such mail
 * away either. A ksdc.in signature cannot be made from those servers; so only the signature
 * counts. On 15 October 2026 the Registrar's three messages in the real mailbox all carried
 * one, so no genuine mail is lost by this; a message that passes SPF alone is only marked
 * unconfirmed, and still reaches the tray.
 *
 * DMARC is not asked for: it said "none" on the Registrar's mail only because ksdc.in
 * publishes no policy, so none of the Registrar's own mail would pass.
 *
 * The provider writes what it found into an Authentication-Results header at the TOP of the
 * message. A sender can put headers of the same name lower down, saying whatever they like,
 * and they arrive intact - so only the topmost one written by the provider is read, and
 * every other is ignored. That is the whole of the security here, and it is why the
 * provider's name is one constant below rather than anything read from the message.
 *
 * Pure: the headers in, an answer out. Everything that acts on the answer is in
 * mail-intake.service.ts.
 */

/**
 * The name the intake mailbox's provider signs its Authentication-Results with (the
 * "authserv-id", the first word of the header). The intake mailbox is Gmail, which writes
 * `Authentication-Results: mx.google.com; ...`.
 *
 * IF THE INTAKE MAILBOX MOVES to another provider, change this to the name that provider
 * writes there (look at the topmost Authentication-Results header of a message in the new
 * mailbox), and MAIL_PROVIDER_NAME with it. Until then every message from a listed sender
 * will read as unconfirmed: it still reaches the tray, marked, and simply stops filing
 * itself - the safe way round.
 */
export const TRUSTED_AUTHSERV_ID = 'mx.google.com';

/** The provider as the officer knows it, for the notes the tray shows. Goes with the above. */
export const MAIL_PROVIDER_NAME = 'Gmail';

/** One result in an Authentication-Results header: "dkim=pass header.i=@ksdc.in". */
export interface AuthResult {
  /** "dkim", "spf", "dmarc", ... lower-cased. */
  method: string;
  /** "pass", "fail", "softfail", "none", ... lower-cased. */
  result: string;
  /** The properties, "header.d", "smtp.mailfrom" and so on, with the key lower-cased. */
  props: Record<string, string>;
}

/** Anything with mailparser's `headers.get()`: a ParsedMail's headers, or a plain Map. */
export interface HeaderSource {
  get(key: string): unknown;
}

/**
 * Every Authentication-Results header, topmost first, as text.
 *
 * mailparser keeps one as a string and several as an array in the order they appear, which
 * is newest first: each server on the way adds its own above the ones already there.
 */
export function authenticationResultsOf(headers: HeaderSource | null | undefined): string[] {
  const value = headers?.get('authentication-results');
  const all = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return all.filter((v): v is string => typeof v === 'string');
}

/**
 * Text with its (comments) taken out - "(google.com: domain of registrar@ksdc.in designates
 * ... as permitted sender)" - so a semicolon or an equals sign inside one cannot be read as
 * part of a result. Nested brackets are allowed, and so are brackets inside "quotes".
 */
function withoutComments(s: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && (quoted || depth > 0)) {
      if (depth === 0) out += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (depth === 0 && c === '"') {
      quoted = !quoted;
      out += c;
    } else if (!quoted && c === '(') {
      depth++;
      out += ' ';
    } else if (!quoted && c === ')' && depth > 0) {
      depth--;
    } else if (depth === 0) {
      out += c;
    }
  }
  return out;
}

/**
 * One Authentication-Results header, read: who wrote it and what it found.
 *
 * Null when it is not a header of that shape at all. Folded lines are unfolded first - a
 * real one runs over four or five lines.
 */
export function parseAuthenticationResults(
  value: string,
): { authservId: string; results: AuthResult[] } | null {
  const text = withoutComments(value.replace(/\r?\n[ \t]+/g, ' ')).replace(/\s+/g, ' ').trim();
  const [head, ...rest] = text.split(';');
  // "mx.google.com" - or "mx.google.com 1", with the optional version after it.
  const authservId = head?.trim().split(' ')[0]?.toLowerCase() ?? '';
  if (!authservId) return null;

  const results: AuthResult[] = [];
  for (const part of rest) {
    const tokens = part.trim().split(' ').filter(Boolean);
    const first = /^([a-z0-9_-]+)(?:\/[0-9]+)?=([a-z0-9_-]+)$/i.exec(tokens[0] ?? '');
    if (!first) continue; // "none", or something this does not understand: no result
    const props: Record<string, string> = {};
    for (const t of tokens.slice(1)) {
      const kv = /^([^=]+)=(.*)$/.exec(t);
      if (kv) props[kv[1]!.toLowerCase()] = kv[2]!.replace(/^"(.*)"$/, '$1');
    }
    results.push({ method: first[1]!.toLowerCase(), result: first[2]!.toLowerCase(), props });
  }
  return { authservId, results };
}

/** The domain of "registrar@ksdc.in", "@ksdc.in" or "ksdc.in", lower-cased. */
function domainOf(s: string | undefined): string | null {
  if (!s) return null;
  const d = s.slice(s.lastIndexOf('@') + 1).trim().toLowerCase().replace(/\.$/, '');
  return d || null;
}

/**
 * A domain that may speak for the sender's: the sender's own, or one it is part of (ksdc.in
 * for mail.ksdc.in). Never a bare "in" or "com" - nobody signs as a whole country's
 * addresses, and accepting one would make every sender there a match.
 */
function speaksFor(domain: string | null, senderDomain: string): boolean {
  if (!domain || !domain.includes('.')) return false;
  return senderDomain === domain || senderDomain.endsWith(`.${domain}`);
}

/** What a signing domain (header.d) may look like: letters, digits, dots and hyphens. */
const SIGNING_DOMAIN = /^[a-z0-9.-]+$/i;
/** And a signing identity (header.i): "@ksdc.in", or a plain address at such a domain. */
const SIGNING_IDENTITY = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]*@[a-z0-9.-]+$/i;

/**
 * Did the mail provider confirm that this message came from `senderAddress`'s domain?
 *
 * Only the topmost Authentication-Results header the provider wrote (TRUSTED_AUTHSERV_ID)
 * is read. Confirmed when, in it, dkim=pass with a signing domain (header.d, or the domain
 * of header.i) that is the sender's domain or one it belongs to - a mailing list's own
 * signature, or a marketing service's, says nothing about the address on the From line.
 * An spf=pass alone is not enough: see the top of this file. Anything else - no such
 * header, softfail, a pass for another domain - is not confirmed.
 *
 * Nor is a provider header with a quotation mark or a backslash anywhere in it. The
 * provider repeats in its header the envelope address the sending server gave, which the
 * sender chooses; an address may legally be written with a quoted part, and inside quotes
 * it can carry ";", brackets and "=" - enough to write a whole fake "dkim=pass" result into
 * the very header that is trusted. The provider's genuine results for the Registrar's mail
 * have no quotes or backslashes, and without them such an address cannot be written; so a
 * header that has one is not read at all. The cost is only that such a message is marked
 * unconfirmed - it still reaches the tray.
 */
export function senderVerified(headers: HeaderSource | null | undefined, senderAddress: string | null | undefined): boolean {
  const senderDomain = domainOf(senderAddress ?? undefined);
  if (!senderDomain || !senderAddress?.includes('@')) return false;

  const topmost = authenticationResultsOf(headers)
    .map((raw) => ({ raw, parsed: parseAuthenticationResults(raw) }))
    .find((h) => h.parsed?.authservId === TRUSTED_AUTHSERV_ID);
  if (!topmost?.parsed || /["\\]/.test(topmost.raw)) return false;

  return topmost.parsed.results.some((r) => {
    if (r.method !== 'dkim' || r.result !== 'pass') return false;
    const d = r.props['header.d'];
    const i = r.props['header.i'];
    return (
      (d !== undefined && SIGNING_DOMAIN.test(d) && speaksFor(domainOf(d), senderDomain)) ||
      (i !== undefined && SIGNING_IDENTITY.test(i) && speaksFor(domainOf(i), senderDomain))
    );
  });
}

/**
 * What the register makes of a message's sender, under the council's list.
 *
 * Null when the list is empty: there is no rule, and the message is taken exactly as it
 * always was. `senderAddress` is the ENVELOPE sender - whoever sent it to the intake
 * mailbox - never the complainant unwrapped from a forward.
 */
export function senderCheckOf(
  intakeSenders: readonly string[] | undefined,
  senderAddress: string | null | undefined,
  headers: HeaderSource | null | undefined,
): MailSenderCheck | null {
  if (!intakeSenders?.length) return null;
  const sender = senderAddress?.trim().toLowerCase() ?? '';
  if (!sender || !intakeSenders.some((a) => a.trim().toLowerCase() === sender)) return 'not_allowed';
  return senderVerified(headers, sender) ? 'verified' : 'unverified';
}

/** "a", "a or b", "a, b or c". */
function either(addresses: readonly string[]): string {
  return addresses.length <= 1
    ? (addresses[0] ?? '')
    : `${addresses.slice(0, -1).join(', ')} or ${addresses.at(-1)}`;
}

/**
 * Why a message from any other address was set aside, in the officer's words. Names the
 * configured addresses, so the officer can see the rule that did it.
 */
export function notFromListedReason(intakeSenders: readonly string[]): string {
  const only = intakeSenders.length === 1 ? 'the only address' : 'the only addresses';
  return (
    `Not from ${either(intakeSenders)}, ${only} complaints are forwarded from. ` +
    'Set aside automatically - bring it back if it is a complaint.'
  );
}

/**
 * The start of the note on a message from a listed address that the provider could not
 * confirm. The tray card and the message page mark such a message too (sender_check), but
 * the note is what says why, and what to do.
 */
export function unconfirmedSenderNote(sender: string): string {
  return (
    `${MAIL_PROVIDER_NAME} could not confirm that this came from the Council's own mail ` +
    `server, although it carries the address ${sender}. Anyone can put an address on an ` +
    'email - check it before acting on it.'
  );
}
