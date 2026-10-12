import { CASE_NUMBER_RE, type CorrespondenceKind } from '@ksdc/contracts';
import { addressFrom } from './forwarded.js';
import { deliveredAddress, isOwnAddress, type OwnAddresses } from './complainant.js';

/**
 * A copy of the Council's own letter, arriving in the intake mailbox.
 *
 * The officer drafts a letter on the case page, sends it from Council webmail, and clicks
 * "I have sent this" - which records the letter and starts whatever its sending means for
 * the case: the reminder for the complainant's documents, or the next notice to a dentist.
 * Then, sometimes, a copy of that same letter reaches the intake mailbox as well: forwarded
 * there for the record, or sent with the intake address in Cc or Bcc.
 *
 * Before this module the register could not tell such a copy from a reply. Its subject
 * quotes the case number, so it filed itself as a letter RECEIVED from the patient, and
 * filing a received letter closes every reminder the case was waiting on - the Today screen
 * stopped chasing the documents on the strength of the Council's own request for them. A
 * copy quoting a wrong but valid number went onto the wrong case without a question, and a
 * copy filed by hand did the same damage.
 *
 * So this decides, from the addresses alone, whether a message is a copy of a letter the
 * Council sent, and to whom. Nothing here touches the database: the service that files the
 * copy (MailIntakeService.fileCouncilCopy) and the matcher that finds its case
 * (matching.ts, matchCouncilCopy) build on it.
 *
 * THE RULE: a copy is a message written BY the Council TO somebody who is not the Council.
 * The Council's addresses are the same ones complainant.ts uses - the official address,
 * the intake mailbox, anything on the Council website's domain - so the two can never
 * disagree about who "we" are.
 */

export interface CouncilCopyRecipient {
  /** Lower-cased. */
  email: string;
  /** The display name the header gave with the address, when it gave one. */
  name: string | null;
}

export interface CouncilCopy {
  /** Who the letter went to: the addresses on its To line that are not the Council's. */
  recipients: CouncilCopyRecipient[];
}

/**
 * Split a To or Cc header line into its addresses.
 *
 * Commas separate addresses except inside a quoted display name ("Kumar, Ravi"), angle
 * brackets or square brackets - which is exactly where a mail client puts the commas that
 * a plain split(',') would cut. Semicolons separate too, because Outlook writes them.
 *
 * Each piece is then read by forwarded.ts's addressFrom(), the same reader the unwrapper
 * uses for the sender, so `Name <addr>`, a bare address and the `Name [mailto:addr]` shape
 * of an HTML-only forward are all understood here as they are there. A piece with no
 * address in it (a group name, "undisclosed-recipients:;") is left out. Each address once.
 */
export function addressesIn(headerText: string | null | undefined): CouncilCopyRecipient[] {
  if (!headerText?.trim()) return [];

  const pieces: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let square = 0;
  for (let i = 0; i < headerText.length; i++) {
    const ch = headerText[i]!;
    if (ch === '\\' && quoted && i + 1 < headerText.length) {
      current += ch + headerText[++i]!;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    else if (!quoted && ch === '[') square++;
    else if (!quoted && ch === ']') square = Math.max(0, square - 1);
    else if (!quoted && angle === 0 && square === 0 && (ch === ',' || ch === ';')) {
      pieces.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  pieces.push(current);

  const seen = new Set<string>();
  const found: CouncilCopyRecipient[] = [];
  for (const piece of pieces) {
    if (!piece.trim()) continue;
    const { address, name } = addressFrom(piece);
    const email = address?.replace(/^mailto:/i, '').trim().toLowerCase();
    if (!email || !email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    const cleanName = name?.replace(/^["']+|["']+$/g, '').replace(/\\(.)/g, '$1').trim() || null;
    // A "name" that is only the address again says nothing.
    found.push({ email, name: cleanName && cleanName.toLowerCase() !== email ? cleanName : null });
  }
  return found;
}

/** What the mail assistant is shown beside the intake mailbox's own address in a To line. */
export const OWN_MAILBOX_MARK = "(this mailbox - the Council's own)";
/** ...and beside any other address of the Council's that is not on its website's domain. */
export const OWN_ADDRESS_MARK = "(the Council's own address)";

/**
 * A To line as the mail assistant is shown it: each address the Council's own, but not on
 * its website's domain, marked as such.
 *
 * The intake mailbox is a Gmail account. The playbook tells the model that ksdc.in is the
 * Council and that "this mailbox" is too - but not which address this mailbox IS, and it
 * must not be told in the playbook, which is the same text for every council and every
 * email. Without the mark, an office forward the unwrapper could not read arrives with the
 * sender left blank and "To: someaccount@gmail.com", which reads exactly like the Council
 * writing to an outsider - a copy of a Council letter - when it is most likely a complaint.
 *
 * A line with no address the register can read is returned as it was.
 */
export function toLineForReader(
  line: string | null | undefined,
  own: OwnAddresses,
  intakeAccount: string | null,
): string | null {
  const text = line?.trim();
  if (!text) return null;
  const people = addressesIn(text);
  if (!people.length) return text;
  const intake = intakeAccount?.trim() ? deliveredAddress(intakeAccount) : null;
  const onDomain = (email: string) => {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    return [...own.domains].some((d) => domain === d || domain.endsWith(`.${d}`));
  };
  const markOf = (email: string) =>
    deliveredAddress(email) === intake ? OWN_MAILBOX_MARK : isOwnAddress(email, own) && !onDomain(email) ? OWN_ADDRESS_MARK : null;
  // Untouched when nothing needs marking: the line is the email's own, and is shown as written.
  if (!people.some((p) => markOf(p.email))) return text;
  return people
    .map((p) => {
      const shown = p.name ? `${p.name} <${p.email}>` : p.email;
      const mark = markOf(p.email);
      return mark ? `${shown} ${mark}` : shown;
    })
    .join(', ');
}

/**
 * Was this original written by the Council to nobody but the Council - the support desk
 * passing a complaint to the registrar, say? Then it is only furniture around whatever it
 * forwards, and the unwrapper reads through it (forwarded.ts, readThrough). An original
 * with any recipient outside the Council is a letter of the Council's, and is not.
 */
export function isInternalForward(
  original: { fromAddress: string | null; to: string | null },
  own: OwnAddresses,
): boolean {
  return (
    isOwnAddress(original.fromAddress, own) &&
    addressesIn(original.to).every((r) => isOwnAddress(r.email, own))
  );
}

/** "Fwd:", "Fw:", "FW:" - what a mail client puts on a message it is forwarding. */
const FORWARD_SUBJECT = /^\s*(?:fwd?|fw)\s*:/i;

/**
 * Should the unwrapper read through this forwarded original to `inner`, the message at the
 * top of its body (forwarded.ts, readThrough)? Yes for:
 *
 *   - the Council passing mail only to itself (isInternalForward);
 *   - somebody outside the Council passing on somebody else's mail - a grievance cell, a
 *     police station, the DCI forwarding a patient's complaint - when the original says it
 *     is a forward ("Fwd:" on its own subject, never "Re:") and what it forwards is from
 *     neither the Council nor the forwarder themselves. The complainant is the patient, not
 *     the office that sent it on.
 *
 * Never for a reply: a patient's Outlook "RE:" quotes our letter below their own words, and
 * the patient is who wrote it. Never to the Council's own letter: a dentist forwarding our
 * notice back with their explanation on top is the dentist's explanation, not a copy of the
 * notice. And never through an original the Council sent to somebody outside it, which is
 * a copy of the Council's letter whose sender must stay the Council.
 */
export function readsThrough(
  original: { fromAddress: string | null; to: string | null; subject: string | null },
  inner: { fromAddress: string | null },
  own: OwnAddresses,
): boolean {
  if (isInternalForward(original, own)) return true;
  const from = original.fromAddress?.toLowerCase() ?? null;
  const innerFrom = inner.fromAddress?.toLowerCase() ?? null;
  return (
    from !== null &&
    innerFrom !== null &&
    !isOwnAddress(from, own) &&
    !isOwnAddress(innerFrom, own) &&
    innerFrom !== from &&
    FORWARD_SUBJECT.test(original.subject ?? '')
  );
}

/** A message as councilCopyOf() and writtenByCouncilTo() read it. */
export interface CopyAddressing {
  original_from: string | null;
  original_to: string | null;
  envelope_from: string | null;
  envelope_to: string | null;
  /** The message's own subject, for the "Fwd:" rule below. */
  subject?: string | null;
}

const outsideOf = (to: string | null, own: OwnAddresses) =>
  addressesIn(to).filter((r) => !isOwnAddress(r.email, own));

/**
 * Did the Council itself write THIS message - the one that arrived, not anything inside it -
 * to somebody outside the Council? Then the recipients on its own To line (the envelope's To,
 * never its Cc) are who the Council wrote to, and the intake mailbox had it in Cc or Bcc.
 *
 * That holds whatever the message carries: the officer forwarding a complaint on to the
 * dentist ("Fwd: Complaint against you", To: the dentist, Cc: intake) is the Council writing
 * to the dentist, and the complaint inside it is not mail the Council received. Read by its
 * forwarded original instead, it filed itself as a letter RECEIVED from the complainant and
 * closed the reminder for the documents they had not sent.
 *
 * A FORWARD (titled "Fwd:", or one the unwrapper opened) is read this way only when the
 * Council's own addresses are nowhere on its To line - the intake mailbox in Cc or Bcc, as
 * when the officer forwards the complaint on to the dentist. The office's own forwards
 * into the intake mailbox are addressed TO it, and often to somebody else as well: the
 * registrar forwarding a patient's reply with the bills "To: intake, the President". Read
 * by its To line, that was the Council writing to the President - a "copy of our letter"
 * that was never recorded as received, and the documents reminder ran on although the
 * bills had come. With the intake mailbox on the To line, the forward is what it carries,
 * and rule 2 of councilCopyOf decides by the forwarded original. The intake mailbox is
 * recognised under every spelling Gmail delivers to it (complainant.ts, deliveredAddress).
 *
 * When the intake mailbox's own address is not known at all (own.intakeKnown), a forward
 * addressed to it cannot be told from a forward to an outsider, so no forward is read
 * this way; only a message that is neither unwrapped nor titled as a forward.
 */
export function writtenByCouncilTo(
  m: CopyAddressing,
  own: OwnAddresses,
): CouncilCopyRecipient[] | null {
  if (!isOwnAddress(m.envelope_from, own)) return null;
  const forward = Boolean(m.original_from) || FORWARD_SUBJECT.test(m.subject ?? '');
  if (forward) {
    if (!own.intakeKnown) return null;
    if (addressesIn(m.envelope_to).some((r) => isOwnAddress(r.email, own))) return null;
  }
  const recipients = outsideOf(m.envelope_to, own);
  return recipients.length ? recipients : null;
}

/**
 * Is this message a copy of a letter the Council sent - and if so, to whom?
 *
 * `m` is a mail_message as stored (or as it is about to be stored, at ingest).
 *
 *   1. The message itself was written by the Council to somebody outside it
 *      (writtenByCouncilTo): a letter sent with the intake address in Cc or Bcc - including
 *      a letter that forwards something, such as a complaint forwarded on to the dentist,
 *      as long as no address of the Council's is on its To line. Its recipients are the
 *      outsiders on its own To line.
 *   2. A forward that was unwrapped (original_from set): a copy when the ORIGINAL was from
 *      the Council and went to at least one address that is not the Council's, AND the
 *      message itself came from the Council. Its recipients are those addresses.
 *
 *      The last condition is not decoration. The unwrapper also unwraps the quoted letter
 *      at the bottom of an ordinary Outlook REPLY - a rule of underscores, or "-----Original
 *      Message-----", followed by "From: Registrar ... To: <the patient>" - and reads that
 *      quoted letter as "the original". Trusting original_from alone made a patient's reply
 *      with the bills, or a dentist's explanation, a "copy of our letter": it filed itself
 *      as the Council's own words, and the reminder it answered stayed open. Only the
 *      Council forwards the Council's letters into its own mailbox, so a message whose
 *      envelope sender is anybody else is never a copy, whatever it quotes.
 *   3. Anything else is not a copy.
 *
 * What must stay NOT a copy, and why:
 *   - A forward from the office that the unwrapper did not recognise. It comes from the
 *     Council and is addressed to the intake mailbox, which is the Council too, so rule 1
 *     does not fire. It is most likely a complaint (see the header of complainant.ts for
 *     the history of exactly this message). So is the same forward addressed to the intake
 *     mailbox AND somebody outside - a committee member, the President - or to the intake
 *     mailbox under another spelling of its Gmail address. A subject that says "Fwd:" is
 *     held to the same answer even when the mailbox's own address is not known: the To
 *     line of a forward may then be the intake mailbox under an address the register
 *     cannot recognise.
 *   - A Council-to-Council internal forward (registrar@ to support@): nobody outside was written to.
 *   - A patient's reply that quotes our letter: its sender, forwarded or not, is the
 *     patient. That is a reply, and it must still close the reminder it answers. Sent to us
 *     directly, its envelope sender is the patient (rule 2's last condition); forwarded by
 *     the office, the unwrapper reads the forward's own header block, the first in the
 *     text, whose sender is the patient (forwarded.ts, unwrapInBody).
 */
export function councilCopyOf(m: CopyAddressing, own: OwnAddresses): CouncilCopy | null {
  const direct = writtenByCouncilTo(m, own);
  if (direct) return { recipients: direct };

  if (m.original_from) {
    if (!isOwnAddress(m.original_from, own) || !isOwnAddress(m.envelope_from, own)) return null;
    const recipients = outsideOf(m.original_to, own);
    return recipients.length ? { recipients } : null;
  }
  return null;
}

/** "Fwd:", "Fw:", "FW:", "Re:", "RE:" at the front, as many times as a thread stacked them. */
const SUBJECT_PREFIX = /^\s*(?:(?:fwd?|fw|re)\s*:\s*)+/i;

/** A subject without its reply and forward prefixes, and with its spaces tidied. */
export function bareSubject(subject: string | null | undefined): string {
  let s = (subject ?? '').replace(/\s+/g, ' ').trim();
  for (;;) {
    const next = s.replace(SUBJECT_PREFIX, '').trim();
    if (next === s) return s;
    s = next;
  }
}

/** Two subjects are the same letter when they match without prefixes, case or spacing. */
export function sameSubject(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = bareSubject(a).toLowerCase();
  return x !== '' && x === bareSubject(b).toLowerCase();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** A case number, as a non-capturing group so it can sit inside a larger pattern. */
const CASE_NO = `(?:${CASE_NUMBER_RE.source.replace(/\((?!\?)/g, '(?:')})`;

/**
 * One template's subject line as a pattern: its words exactly, a case number where it says
 * {{case.number}}, anything where it names another field, and an {{#if}} section optional.
 * Followed, optionally, by the " [case number]" subjectWithReference() adds to a subject
 * that does not quote the number itself. Null for a template it cannot make sense of.
 */
function subjectPattern(subjectTpl: string): { re: RegExp; literal: number } | null {
  let source = '';
  let literal = 0;
  const token = /\{\{\s*(#if\s+[^}]*|\/if|[^}]*?)\s*\}\}/g;
  let last = 0;
  for (let m = token.exec(subjectTpl); m; m = token.exec(subjectTpl)) {
    const text = subjectTpl.slice(last, m.index);
    literal += text.replace(/\s+/g, '').length;
    source += text.split(/\s+/).map(escapeRe).join('\\s+');
    const inner = m[1]!.trim();
    if (inner.startsWith('#if')) source += '(?:';
    else if (inner === '/if') source += ')?';
    else if (inner === 'case.number') source += CASE_NO;
    else source += '.+?';
    last = m.index + m[0].length;
  }
  const tail = subjectTpl.slice(last);
  literal += tail.replace(/\s+/g, '').length;
  source += tail.split(/\s+/).map(escapeRe).join('\\s+');
  try {
    return { re: new RegExp(`^\\s*${source}(?:\\s*\\[\\s*${CASE_NO}\\s*\\])?\\s*$`, 'i'), literal };
  } catch {
    return null;
  }
}

/**
 * Which of the Council's letters a subject line is, or null when it is none of them.
 *
 * `templates` are the council's own, as published - the current version of each, so a
 * subject the officer has reworded still matches. Prefixes a mail client adds (Fwd:, Re:)
 * are taken off first. The most specific template wins: "Reminder - explanation called for
 * - X" is the reminder, not the explanation it contains. Two templates that share a subject
 * word for word (the explanation sought from a dentist on a complaint, and on an ethics
 * case) are told apart by the case number's series where they can be.
 *
 * Templates that share a subject and are NOT told apart by the series - the hearing notice
 * to the complainant and the one to the dentist - are different letters to different
 * people, so this does not pretend to choose: see inferLetterKinds, which returns them all,
 * and kindForRecipient, which chooses by who the copy went to once the case is known. This
 * returns the first listed, for a caller that has no case to ask.
 *
 * Never 'inbound': that is not a letter the Council sends.
 */
export function inferLetterKind(
  subject: string | null | undefined,
  templates: ReadonlyArray<{ kind: CorrespondenceKind; subjectTpl: string }>,
): CorrespondenceKind | null {
  return inferLetterKinds(subject, templates)[0] ?? null;
}

/**
 * Every kind a subject line could be, best first - more than one only when templates tie
 * (see inferLetterKind). Empty when it is none of the Council's letters.
 */
export function inferLetterKinds(
  subject: string | null | undefined,
  templates: ReadonlyArray<{ kind: CorrespondenceKind; subjectTpl: string }>,
): CorrespondenceKind[] {
  const s = bareSubject(subject);
  if (!s) return [];
  const series = new RegExp(CASE_NUMBER_RE.source).exec(s)?.[2] ?? null;

  let best: { kinds: CorrespondenceKind[]; score: number } | null = null;
  for (const t of templates) {
    if (t.kind === 'inbound') continue;
    const pattern = subjectPattern(t.subjectTpl);
    if (!pattern || !pattern.re.test(s)) continue;
    const ethics = t.kind.startsWith('ethics_');
    // The series breaks a tie and nothing more: half a point against a whole character.
    const score = pattern.literal + (series ? (ethics === (series === 'ETH') ? 0.5 : 0) : 0);
    if (!best || score > best.score) best = { kinds: [t.kind], score };
    else if (score === best.score && !best.kinds.includes(t.kind)) best.kinds.push(t.kind);
  }
  return best?.kinds ?? [];
}

/**
 * Which side of a case a letter is written to, read from its kind's name: the hearing
 * notice to the dentist (summons_respondent), an order to the dentist, a notice - each is
 * written to a respondent, whatever its stored addressee says. Null for a kind that does
 * not say (a documents request, a covering letter).
 */
export function sideOf(kind: CorrespondenceKind): 'complainant' | 'respondent' | null {
  if (/respondent/.test(kind) || kind.startsWith('ethics_')) return 'respondent';
  if (/complainant|patient/.test(kind)) return 'complainant';
  return null;
}

/** Which side of a case a party is on, from their role on it. */
export function sideOfRole(role: string): 'complainant' | 'respondent' | null {
  if (role === 'complainant' || role === 'patient') return 'complainant';
  if (role.startsWith('respondent')) return 'respondent';
  return null;
}

/**
 * Of kinds that tie on the subject, the one written to the side of the case the copy went
 * to: the hearing notice to the complainant when it went to the complainant or patient,
 * the one to the dentist when it went to a respondent. Null when that does not settle it -
 * the recipient is on neither side, or on both - and the officer is asked.
 */
export function kindForRecipient(
  kinds: readonly CorrespondenceKind[],
  recipientRoles: ReadonlyArray<string>,
): CorrespondenceKind | null {
  if (kinds.length <= 1) return kinds[0] ?? null;
  const complainantSide = recipientRoles.some((r) => sideOfRole(r) === 'complainant');
  const respondentSide = recipientRoles.some((r) => sideOfRole(r) === 'respondent');
  if (complainantSide === respondentSide) return null;
  const want = complainantSide ? 'complainant' : 'respondent';
  const fitting = kinds.filter((k) => sideOf(k) === want);
  return fitting.length === 1 ? fitting[0]! : null;
}

/**
 * A person's name as two records of it can be compared: "Dr. P. Shetty", "Dr P Shetty" and
 * "p. shetty" are the same name. Titles and punctuation go, case and spacing do not count.
 */
export function comparableName(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[.,'"()]/g, ' ')
    .replace(/\b(?:dr|mr|mrs|ms|miss|prof|smt|shri|sri)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How much a copy's date says about when the letter went out.
 *
 *   exact       a real timestamp: the original's own (a forward as an attachment), or the
 *               copy itself when it was sent WITH the letter (intake in Cc or Bcc)
 *   stated_day  the day the forward's own header line names, read from its text
 *   forwarded   only when the copy was forwarded, which says the letter went out on that
 *               day or EARLIER - by how much, nothing here can tell
 */
export type CopyDateBasis = 'exact' | 'stated_day' | 'forwarded';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The calendar day an in-body forward's date line names, as YYYY-MM-DD, or null when it
 * does not name one beyond doubt.
 *
 * Only a DAY, never a time: the line carries no timezone (forwarded.ts), but "Fri, 3 Oct
 * 2026 at 11:02" names 3 October whatever the zone was, give or take a day at midnight.
 * Only shapes that cannot be misread: a month written as a word, or a year-first ISO date.
 * "03/10/2026" is 3 October in Bengaluru and 10 March in Outlook's American settings, so it
 * is not read at all.
 */
export function dayFromDateText(text: string | null | undefined): string | null {
  const s = (text ?? '').trim();
  if (!s) return null;

  let y: number;
  let mo: number;
  let d: number;

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (iso) {
    [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else {
    const month =
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?(?![a-z])/i.exec(
        s,
      );
    const year = /\b(?:19|20)\d{2}\b/.exec(s);
    if (!month || !year) return null;
    mo = MONTHS.indexOf(month[1]!.slice(0, 3).toLowerCase()) + 1;
    y = Number(year[0]);
    // The day sits beside the month word: "3 Oct 2026", or "October 3, 2026".
    const before = /(?:^|[\s,])(\d{1,2})(?:st|nd|rd|th)?\s*$/i.exec(s.slice(0, month.index));
    const after = /^\s*(\d{1,2})(?:st|nd|rd|th)?(?:\s*,|\s|$)/i.exec(s.slice(month.index + month[0].length));
    const day = before?.[1] ?? after?.[1];
    if (!day) return null;
    d = Number(day);
  }

  const at = new Date(Date.UTC(y, mo - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
  return at.toISOString().slice(0, 10);
}

/**
 * When the copy says the letter went out, and how far that can be trusted (CopyDateBasis).
 *
 * A day read from the forward's text is placed at 06:00 UTC - midday in Bengaluru, as the
 * "I have sent this" route places a bare date - and only believed when it is not after the
 * forward itself arrived: a letter cannot be forwarded before it was sent, so a later day
 * means the line was misread.
 */
export function copyWhenOf(
  m: {
    original_date: Date | string | null;
    envelope_date: Date | string;
    original_date_text?: string | null;
    forward_kind?: string | null;
  },
  /**
   * The message that arrived IS the letter (writtenByCouncilTo): its own date is when it
   * went out, whatever it forwards. Read from its forwarded original, the Council's
   * "Fwd: Complaint against you" to the dentist was dated by the complaint inside it.
   */
  direct = false,
): { date: Date; basis: CopyDateBasis } {
  const asDate = (d: Date | string) => (d instanceof Date ? d : new Date(d));
  if (direct) return { date: asDate(m.envelope_date), basis: 'exact' };
  if (m.original_date) return { date: asDate(m.original_date), basis: 'exact' };
  const envelope = asDate(m.envelope_date);
  if (!m.forward_kind || m.forward_kind === 'none') return { date: envelope, basis: 'exact' };
  const day = dayFromDateText(m.original_date_text);
  if (day) {
    const stated = new Date(`${day}T06:00:00Z`);
    if (stated.getTime() <= envelope.getTime() + 86_400_000) return { date: stated, basis: 'stated_day' };
  }
  return { date: envelope, basis: 'forwarded' };
}

/** When the copy says the letter went out: copyWhenOf without the basis. */
export function copyDateOf(m: {
  original_date: Date | string | null;
  envelope_date: Date | string;
  original_date_text?: string | null;
  forward_kind?: string | null;
}): Date {
  return copyWhenOf(m).date;
}
