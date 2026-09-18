import { simpleParser, type ParsedMail } from 'mailparser';
import type { MailForwardKind } from '@ksdc/contracts';

/**
 * Digging the original message out of a forward.
 *
 * The officer receives a complaint at the council inbox and forwards it to the address the
 * software watches. So the envelope `From` on everything that arrives here is the officer,
 * every time — and the person the register actually needs to name is buried in the body,
 * written by whichever mail client did the forwarding.
 *
 * THE ONE RULE THIS FILE IS BUILT AROUND: never match a separator as a literal string.
 *
 * Gmail's web client emits ten leading hyphens and NINE trailing ones. It used to emit ten
 * and ten. Outlook Web emits exactly thirty-two underscores. Outlook desktop emits five
 * hyphens each side of `Original Message`, and some hosts emit ten. Apple Mail emits no
 * hyphens at all and quotes the whole block with `>` in the plain-text alternative. A
 * parser anchored on any one of those exact strings fails silently on every message from
 * every other client, and "silently" is the problem: a complaint would be filed under the
 * officer's own name with nobody noticing.
 *
 * WHAT IS RELIABLE, in order:
 *
 *   1. A `message/rfc822` attachment (forward-as-attachment). The original arrives whole,
 *      with real headers and a real timezone. Always tried first, always wins.
 *   2. An in-body separator, matched by SHAPE. Gives a sender and a subject.
 *   3. Nothing. The message is treated as written directly to us, which is also a real
 *      and ordinary case — a complainant can write to the intake address themselves.
 *
 * WHAT IS NEVER RELIABLE: the date on an in-body forward header. `Date: Tue, 16 Sep 2026
 * at 19:12` carries no timezone whatsoever. Parsing it produces either Invalid Date or,
 * worse, a silently host-local timestamp that is correct on a laptop in Bengaluru and five
 * and a half hours wrong on a server anywhere else. Those dates are kept as text, exactly
 * as written, and shown to the officer as text. Only route 1 yields a real timestamp.
 */

export interface ForwardedOriginal {
  kind: MailForwardKind;
  fromAddress: string | null;
  fromName: string | null;
  to: string | null;
  subject: string | null;
  /** Only ever set from a message/rfc822 attachment, where a true offset survives. */
  date: Date | null;
  /** The header line as written, when it carried no timezone we could trust. */
  dateText: string | null;
  /** The forwarded message's own body, with the header block removed. */
  body: string | null;
}

/** Not a forward: somebody wrote to the intake address directly. */
const NOT_A_FORWARD: ForwardedOriginal = {
  kind: 'none',
  fromAddress: null,
  fromName: null,
  to: null,
  subject: null,
  date: null,
  dateText: null,
  body: null,
};

/**
 * The separators, by shape, most specific first.
 *
 * Each dash and underscore count is a RANGE because the counts are not stable even within
 * one client — Gmail's own is asymmetric today and was symmetric a few years ago. The
 * counts in the comments are what was measured, not what is matched.
 */
const SEPARATORS: Array<{ kind: MailForwardKind; re: RegExp }> = [
  // Outlook Web / Outlook.com: a bare rule of ~32 underscores and nothing else.
  { kind: 'outlook_web', re: /^[ \t]*_{16,}[ \t]*$/m },
  // Gmail: measured as 10 leading and 9 trailing hyphens.
  { kind: 'gmail', re: /^[ \t>]*-{3,}[ \t]*Forwarded message[ \t]*-{3,}[ \t]*$/im },
  // Outlook desktop: measured as 5 and 5. Some hosts emit 10 and 10.
  { kind: 'outlook_desktop', re: /^[ \t>]*-{3,}[ \t]*Original Message[ \t]*-{3,}[ \t]*$/im },
  // Apple Mail: no rule characters at all, and `>`-quoted in the text alternative.
  { kind: 'apple_mail', re: /^[ \t>]*Begin forwarded message[ \t]*:[ \t]*$/im },
];

/**
 * The header labels, keyed by label rather than by position.
 *
 * Field ORDER differs by client — Gmail writes From/Date/Subject/To, Outlook writes
 * From/Sent/To/Subject, Apple Mail writes From/Subject/Date/To — so "the second line after
 * the separator is the date" is wrong for two of the three. Outlook also says `Sent:`
 * where the others say `Date:`.
 *
 * The leading `\*?` is not a typo: Gmail's plain-text alternative renders the sender's
 * display name in asterisks, because in the HTML it is a <strong>. Left in, the asterisks
 * end up inside the name and get written to the party record.
 */
const LABELS = {
  from: /^[ \t>]*\*?[ \t]*From[ \t]*:[ \t]*\*?(.*)$/im,
  to: /^[ \t>]*\*?[ \t]*To[ \t]*:[ \t]*\*?(.*)$/im,
  subject: /^[ \t>]*\*?[ \t]*Subject[ \t]*:[ \t]*\*?(.*)$/im,
  date: /^[ \t>]*\*?[ \t]*(?:Date|Sent)[ \t]*:[ \t]*\*?(.*)$/im,
} as const;

/** Apple Mail quotes the forwarded block; a parser anchored on `^From:` finds nothing. */
function unquote(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^[ \t]*(?:>[ \t]?)+/, ''))
    .join('\n');
}

/**
 * Pull an address out of a header value.
 *
 * Handles `Name <addr>`, a bare `addr`, and the shape mailparser produces when it
 * synthesises plain text from an HTML-only forward: it rewrites `<a href="mailto:X">X</a>`
 * as `X [X]`, then hard-wraps the result — so the angle bracket that closes the address
 * can end up on the next physical line, and a naive /<([^>]+)>/ returns null. The `[X]`
 * form is tried before the angle-bracket form for exactly that reason.
 */
function addressFrom(value: string): { address: string | null; name: string | null } {
  const raw = value.trim().replace(/\*/g, '');
  if (!raw) return { address: null, name: null };

  // `Name <addr>` — the ordinary case.
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(raw);
  if (angled) {
    const name = raw.slice(0, angled.index).trim().replace(/^["']|["']$/g, '');
    return { address: angled[1]!.toLowerCase(), name: name || null };
  }

  // `Name addr [addr]` — mailparser's rendering of a mailto link in an HTML-only forward.
  const bracketed = /\[([^\]\s]+@[^\]\s]+)\]/.exec(raw);
  if (bracketed) {
    const before = raw.slice(0, bracketed.index).trim();
    // The address usually appears twice: once as the link text, once in the brackets.
    const name = before.replace(/[^\s]+@[^\s]+\s*$/, '').trim();
    return { address: bracketed[1]!.toLowerCase(), name: name || null };
  }

  // A bare address, possibly with a display name in front of it.
  const bare = /([^\s<>]+@[^\s<>]+)/.exec(raw);
  if (bare) {
    const name = raw.slice(0, bare.index).trim().replace(/^["']|["']$/g, '');
    return { address: bare[1]!.replace(/[.,;]+$/, '').toLowerCase(), name: name || null };
  }

  // A display name with no address at all. Better than nothing for a card.
  return { address: null, name: raw || null };
}

/**
 * Unwrap a forwarded message.
 *
 * `parsed` is what mailparser made of the message that actually arrived. Returns what the
 * ORIGINAL said, or `kind: 'none'` when this was not a forward.
 */
export async function unwrapForward(parsed: ParsedMail): Promise<ForwardedOriginal> {
  // ── Route 1: forwarded as an attachment. Whole, with a real timezone. ──────
  //
  // Detection keys on the content type alone. A message/rfc822 part often carries no
  // Content-Disposition and no filename, so keying on `contentDisposition === 'attachment'`
  // or on a `.eml` extension misses real forward-as-attachment messages.
  const embedded = (parsed.attachments ?? []).find((a) => a.contentType === 'message/rfc822');
  if (embedded?.content) {
    try {
      const inner = await simpleParser(embedded.content as Buffer, { keepCidLinks: true });
      const from = inner.from?.value?.[0];
      if (from?.address) {
        return {
          kind: 'rfc822_attachment',
          fromAddress: from.address.toLowerCase(),
          fromName: from.name || null,
          to: inner.to && 'text' in inner.to ? inner.to.text : null,
          subject: inner.subject ?? null,
          // The one route where the offset is real, so the one route with a timestamp.
          date: inner.date ?? null,
          dateText: null,
          body: (inner.text ?? '').trim() || null,
        };
      }
    } catch {
      // A malformed embedded part is not a reason to lose the message. Fall through to
      // the in-body routes and, failing those, treat it as written to us directly.
    }
  }

  // ── Route 2: an in-body separator, matched by shape. ──────────────────────
  const text = parsed.text ?? '';
  if (!text.trim()) return NOT_A_FORWARD;

  for (const { kind, re } of SEPARATORS) {
    const m = re.exec(text);
    if (!m) continue;

    // Everything after the separator. What precedes it is the officer's own covering
    // note, which belongs to the forward rather than to the complaint.
    const after = unquote(text.slice(m.index + m[0].length));

    // The header block is the run of labelled lines at the top; the body is the rest.
    // Take the first blank line that follows at least one recognised label.
    const headerEnd = findHeaderEnd(after);
    const headerBlock = after.slice(0, headerEnd);
    const body = after.slice(headerEnd).trim();

    const fromLine = LABELS.from.exec(headerBlock)?.[1] ?? '';
    const { address, name } = addressFrom(fromLine);
    const subject = LABELS.subject.exec(headerBlock)?.[1]?.trim().replace(/\*/g, '') || null;
    const to = LABELS.to.exec(headerBlock)?.[1]?.trim().replace(/\*/g, '') || null;
    const dateText = LABELS.date.exec(headerBlock)?.[1]?.trim().replace(/\*/g, '') || null;

    // A separator with no `From:` under it is not a header block we understood. Say
    // `generic` and hand the officer the whole thing rather than inventing a sender.
    if (!address && !name) {
      return { ...NOT_A_FORWARD, kind: 'generic', body: after.trim() || null };
    }

    return {
      kind,
      fromAddress: address,
      fromName: name,
      to,
      subject,
      // Deliberately null. See the note at the top of this file: an in-body forward
      // header carries no timezone, and inventing one is worse than having none.
      date: null,
      dateText,
      body: body || null,
    };
  }

  return NOT_A_FORWARD;
}

/**
 * Where the forwarded header block stops and the message begins.
 *
 * The first blank line after at least one recognised label. Falling back to "no body" when
 * there is no blank line at all is wrong in the other direction — some clients run the
 * headers straight into the text — so the fallback is a small fixed window of lines.
 */
function findHeaderEnd(after: string): number {
  const lines = after.split('\n');
  let seenLabel = false;
  let offset = 0;

  for (let i = 0; i < lines.length && i < 12; i++) {
    const line = lines[i]!;
    const bare = line.replace(/^[ \t]*(?:>[ \t]?)+/, '').trim();
    const isLabel = /^\*?\s*(?:From|To|Cc|Subject|Date|Sent|Reply-To)\s*:/i.test(bare);

    if (isLabel) seenLabel = true;
    else if (seenLabel && bare === '') return offset;
    // A non-blank, non-label line after the labels have started is already the body.
    else if (seenLabel && bare !== '') return offset;

    offset += line.length + 1;
  }
  return seenLabel ? offset : 0;
}

/**
 * The first readable words of a message, for the card in the tray.
 *
 * Quoted lines and signature blocks are dropped: a card whose preview is the officer's own
 * email signature tells the reader nothing about the complaint.
 */
export function snippetOf(text: string | null | undefined, limit = 280): string {
  if (!text) return '';
  const useful = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('>') && !/^-{2,}\s*$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return useful.length <= limit ? useful : `${useful.slice(0, limit - 1)}…`;
}
