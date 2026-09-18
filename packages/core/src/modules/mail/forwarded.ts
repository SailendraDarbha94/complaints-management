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

/** One forwarded-header line: a known label, a colon, and whatever follows on the same line. */
const LABEL_LINE = /^[ \t>]*\*?[ \t]*(From|To|Cc|Subject|Date|Sent|Reply-To)[ \t]*:\*?[ \t]*(.*)$/i;

/**
 * A line that opens with a rule of three or more `-`, `=` or `_`: a separator, a bare rule,
 * or a closing line. Furniture, and never part of a header value.
 */
const RULE = /^[ \t>]*(?:-{3,}|={3,}|_{3,})/;

/**
 * The narrowest hard wrap a header line is known to get. SquirrelMail breaks every line at
 * 76 characters when it sends, header lines included; html-to-text, which mailparser uses
 * for an HTML-only message, breaks at 80. A header line that long, with the next line's
 * first word unable to fit on it, was broken by a wrapper, not by whoever wrote it.
 */
const WRAP_WIDTH = 76;

/**
 * Is `line`, directly under the header line `prev`, the rest of that header's value?
 *
 * Long values get wrapped: a subject that names a dentist and a clinic is routinely past
 * 80 characters, and a long display name pushes the address onto a line of its own:
 *
 *      From: Lakshminarayana Chikkaballapur Venkatasubbaiah
 *      <lakshminarayana.venkatasubbaiah@example.in>
 *
 * Read one line at a time, that sender has no address and the first line of the body is
 * the tail of the subject. So a line counts as a continuation when it sits INSIDE the
 * block (the line after it is another header or the rule that closes the block), or when
 * `prev` was full enough that the wrapper must have broken it. An indented line is only
 * accepted in the first case: Yahoo starts the body on the line straight after Subject,
 * with a leading space and no blank line, and that must stay the body.
 */
function isContinuation(prev: string, line: string, after: string | undefined): boolean {
  const unquoted = line.replace(/^[ \t]*(?:>[ \t]?)+/, '');
  const content = unquoted.trim();
  if (!content || LABEL_LINE.test(line) || RULE.test(line)) return false;
  if (after !== undefined && (LABEL_LINE.test(after) || RULE.test(after))) return true;
  if (/^[ \t]/.test(unquoted)) return false;
  return prev.trimEnd().length + 1 + content.split(/\s/)[0]!.length > WRAP_WIDTH;
}

/** A forwarded header block as read: one line per header, and where the letter starts. */
interface HeaderBlock {
  /** One line per header, "Label: value", however the client laid it out. */
  rows: string[];
  /** The headers present, with Sent read as Date. */
  fields: Set<string>;
  /** The index of the first line after the block. The body is cut from here. */
  end: number;
}

/**
 * Read the forwarded header block that starts at the label line `lines[start]`.
 *
 * Found on the first real forward from the Council's own webmail. Roundcube lays a
 * forwarded message's headers out as an HTML TABLE - <th>From:</th><td>Name &lt;addr&gt;</td> -
 * and the text/plain alternative it writes from that (its own html2text, not mailparser's)
 * upper-cases the <th> and puts the value on the NEXT line, with a blank line between rows:
 *
 *      SUBJECT:
 *      Customer redressal for treatment related issue
 *
 *      FROM:
 *      A. Complainant <complainant@example.in>
 *
 * A label regex reading "From: value" on one line captures nothing from that. So a label
 * standing alone takes the line under it as its value, a wrapped value is joined back onto
 * its label (see isContinuation), and a blank line between two rows is stepped over.
 *
 * Where the block ENDS matters as much, because what follows it is stored as the
 * complainant's letter, and a letter to the Council routinely opens with labelled lines of
 * its own: "From: <name, address>", "Date: 10/09/2026", "To:" over the addressee. Two rules,
 * both about the block's shape, keep those in the letter:
 *
 * - A block is laid out one way throughout, and its first gap says which. Rows that touch
 *   (Gmail, Outlook, Zimbra, almost everyone) make a blank line the end of the block. Only
 *   rows that start out apart - Roundcube's table, and HTML rendered with a blank line
 *   under every row - are read across blank lines.
 * - No header comes twice in one block. A second From: or Date: is the letter's.
 *
 * Only the rows are rebuilt. The lines from `end` on are left exactly as they are.
 */
function readHeaderBlock(lines: string[], start: number): HeaderBlock {
  const rows: string[] = [];
  const fields = new Set<string>();
  let apart: boolean | undefined;
  let i = start;

  while (i < lines.length) {
    const m = LABEL_LINE.exec(lines[i]!);
    if (!m) break;
    // Date and Sent are one field under two names: Outlook says Sent, the rest Date.
    const label = m[1]!.toLowerCase();
    const field = label === 'sent' ? 'date' : label;
    if (fields.has(field)) break;
    fields.add(field);

    let row = lines[i++]!;
    // Measured against the last PHYSICAL line, not the joined one, which is always long.
    let last = row;
    const under = lines[i];
    // Only when the line under is a value rather than another label: "FROM:" then "TO:"
    // means an empty field, not a sender called "TO:".
    if (m[2]!.trim() === '' && under !== undefined && under.trim() !== '' && !LABEL_LINE.test(under)) {
      row = `${m[1]}: ${under.trim()}`;
      last = under;
      i++;
    }
    while (i < lines.length && isContinuation(last, lines[i]!, lines[i + 1])) {
      last = lines[i++]!;
      row = `${row.trimEnd()} ${last.replace(/^[ \t>]*/, '').trim()}`;
    }
    rows.push(row);

    let next = i;
    while (next < lines.length && lines[next]!.trim() === '') next++;
    if (next === i) {
      apart ??= false;
      continue;
    }
    apart ??= true;
    if (!apart || next === lines.length || !LABEL_LINE.test(lines[next]!)) break;
    i = next;
  }
  return { rows, fields, end: i };
}

/** "Fwd:", "Fw:", "FW:" - the subject a mail client gives a message it is forwarding. */
const FORWARD_SUBJECT = /^\s*(?:fwd?|fw)\s*:/i;

/**
 * A forwarded header block with no separator line above it.
 *
 * Roundcube draws none: the forwarded message opens directly with its Subject / Date /
 * From / To rows. This finds such a block by its SHAPE - a block of header rows containing
 * From and at least two of Subject, Date and To - within the first lines of the message,
 * leaving room for a covering note above it.
 *
 * It is only consulted when the subject says the message is a forward. Without that, a
 * complainant writing to us directly who pasted an earlier email into their complaint
 * would have the pasted sender taken for themselves.
 */
function headerBlockWithoutSeparator(lines: string[]): HeaderBlock | null {
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    if (!LABEL_LINE.test(lines[i]!)) continue;

    const block = readHeaderBlock(lines, i);
    const supporting = ['subject', 'date', 'to'].filter((f) => block.fields.has(f)).length;
    if (block.fields.has('from') && supporting >= 2) return block;
    // Always past line i: a block holds at least the label line it started on.
    i = block.end - 1;
  }
  return null;
}

/** Apple Mail quotes the forwarded block; a parser anchored on `^From:` finds nothing. */
function unquote(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^[ \t]*(?:>[ \t]?)+/, ''))
    .join('\n');
}

/** "----- End forwarded message -----": Horde and Mutt close the forward as well as open it. */
const END_RULE = /^[ \t>]*-{3,}[ \t]*End\b.*-{3,}[ \t]*$/i;

/**
 * The forwarded message's own words, without the furniture some clients put around them.
 *
 * - A rule opening the body that does not introduce another header block closes the one
 *   above it: SquirrelMail draws a bare rule under its headers, Zoho repeats its separator.
 *   A rule followed by From: is a forward nested inside this one and is kept.
 * - An "End forwarded message" line, and whatever the forwarder added below it - their
 *   signature, usually - is not the complainant's.
 * - A body quoted on every line (Zimbra's quote-the-original option, Zoho's blockquote) is
 *   unquoted, one level. Left quoted, snippetOf() drops every line and the card is blank.
 */
function cleanBody(body: string): string | null {
  let lines = body.split('\n');

  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (i < lines.length && RULE.test(lines[i]!)) {
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === '') j++;
    if (j >= lines.length || !LABEL_LINE.test(lines[j]!)) i++;
  }
  lines = lines.slice(i);

  const end = lines.findIndex((l) => END_RULE.test(l));
  if (end !== -1) lines = lines.slice(0, end);

  const written = lines.filter((l) => l.trim() !== '');
  if (written.length && written.every((l) => /^[ \t]*>/.test(l))) {
    lines = lines.map((l) => l.replace(/^[ \t]*>[ \t]?/, ''));
  }
  return lines.join('\n').trim() || null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * The HTML part as plain lines: one per block, no wrapping, entities decoded.
 *
 * Used only when the text gave up no sender, in cases where the HTML still has each header
 * in its own table row or <div> but the text has lost that:
 *
 * - An HTML-only message, its text part dropped by a relay. mailparser's own rendering
 *   runs Roundcube's header table into one wrapped line: "Subject:XDate:YFrom:Name".
 * - Yahoo's own text part, which puts the separator and every header on ONE line, each
 *   value glued to the next label.
 * - An HTML part beside an attachment with no text part: mailparser sets no text at all.
 *
 * All that is needed is a line per block element, which mailparser's rendering does not
 * guarantee. This is not a general HTML renderer and does not try to be.
 */
function htmlAsText(html: string): string {
  return html
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/?(?:p|div|tr|table|tbody|thead|blockquote|h[1-6]|li|ul|ol|pre|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/t[hd]\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec?: string, hex?: string, name?: string) => {
      const code = dec ? Number(dec) : hex ? parseInt(hex, 16) : NaN;
      if (!Number.isNaN(code)) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      return ENTITIES[name!.toLowerCase()] ?? m;
    })
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
  // Outlook 2007/2010 writes the same shape itself as `Name [mailto:addr]`; without the
  // optional prefix the complainant's address would be stored as "mailto:addr".
  const bracketed = /\[(?:mailto:)?([^\]\s]+@[^\]\s]+)\]/i.exec(raw);
  if (bracketed) {
    const before = raw.slice(0, bracketed.index).trim();
    // The address usually appears twice: once as the link text, once in the brackets. It
    // is cut at its `<` when there is one, because Zoho writes `Name<addr>` with no space
    // and the whole of "Gowda<ramesh.gowda@example.in" is otherwise one word to remove.
    const name = before.replace(/<?[^\s<]+@[^\s]+\s*$/, '').trim();
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

  // Routes 2 and 3 read the text part. When that yields no sender, they read the HTML
  // part instead - see htmlAsText() for when the HTML has what the text lost. A sender
  // from either wins; failing that, a `generic` from the text is kept over nothing.
  const fromText = unwrapInBody(parsed.text ?? '', parsed.subject);
  if (fromText.fromAddress || fromText.fromName) return fromText;
  if (typeof parsed.html === 'string' && parsed.html.trim()) {
    const fromHtml = unwrapInBody(htmlAsText(parsed.html), parsed.subject);
    if (fromHtml.fromAddress || fromHtml.fromName || fromText.kind === 'none') return fromHtml;
  }
  return fromText;
}

/** Routes 2 and 3, on one rendering of the message as text. */
function unwrapInBody(raw: string, envelopeSubject: string | undefined): ForwardedOriginal {
  // Two changes to the text as a whole, and neither alters a word of the letter later cut
  // from it: line ends become \n, and non-breaking spaces become spaces. Horde
  // right-aligns its labels with &nbsp; and Outlook on the web puts one straight after each
  // label, so the text arrives with U+00A0 before "Date:" and after "From:", where [ \t]
  // does not match it.
  const text = raw.replace(/\r\n/g, '\n').replace(/\xa0/g, ' ');
  if (!text.trim()) return NOT_A_FORWARD;

  // ── Route 2: an in-body separator, matched by shape. ──────────────────────
  for (const { kind, re } of SEPARATORS) {
    const m = re.exec(text);
    if (!m) continue;

    // Everything after the separator. What precedes it is the officer's own covering
    // note, which belongs to the forward rather than to the complaint.
    const after = unquote(text.slice(m.index + m[0].length)).split('\n');

    // The header block opens within the first lines under the separator - Apple Mail
    // leaves a blank line first - and the body is everything below it.
    const start = after.slice(0, 12).findIndex((l) => LABEL_LINE.test(l));
    const block = start === -1 ? null : readHeaderBlock(after, start);
    const headerBlock = block?.rows.join('\n') ?? '';
    const body = cleanBody(after.slice(block?.end ?? 0).join('\n'));

    const fromLine = LABELS.from.exec(headerBlock)?.[1] ?? '';
    const { address, name } = addressFrom(fromLine);
    const subject = LABELS.subject.exec(headerBlock)?.[1]?.trim().replace(/\*/g, '') || null;
    const to = LABELS.to.exec(headerBlock)?.[1]?.trim().replace(/\*/g, '') || null;
    const dateText = LABELS.date.exec(headerBlock)?.[1]?.trim().replace(/\*/g, '') || null;

    // A separator with no `From:` under it is not a header block we understood. Say
    // `generic` and hand the officer the whole thing rather than inventing a sender.
    if (!address && !name) {
      return { ...NOT_A_FORWARD, kind: 'generic', body: after.join('\n').trim() || null };
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
      body,
    };
  }

  // ── Route 3: a header block with no separator above it. ───────────────────
  //
  // Roundcube - the Council's own webmail - forwards this way, and so do Zimbra and classic
  // Outlook in HTML compose. Only tried when the subject says this IS a forward; see
  // headerBlockWithoutSeparator() for why.
  if (FORWARD_SUBJECT.test(envelopeSubject ?? '')) {
    const lines = text.split('\n');
    const block = headerBlockWithoutSeparator(lines);
    if (block) {
      const headerBlock = unquote(block.rows.join('\n'));
      const { address, name } = addressFrom(LABELS.from.exec(headerBlock)?.[1] ?? '');
      if (address || name) {
        return {
          kind: 'header_block',
          fromAddress: address,
          fromName: name,
          to: LABELS.to.exec(headerBlock)?.[1]?.trim().replace(/\*/g, '') || null,
          subject: LABELS.subject.exec(headerBlock)?.[1]?.trim().replace(/\*/g, '') || null,
          // Text, not a timestamp, for the same reason as every other in-body header: the
          // "2026-09-18 15:15" Roundcube writes carries no timezone at all.
          date: null,
          dateText: LABELS.date.exec(headerBlock)?.[1]?.trim().replace(/\*/g, '') || null,
          body: cleanBody(lines.slice(block.end).join('\n')),
        };
      }
    }
  }

  return NOT_A_FORWARD;
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
