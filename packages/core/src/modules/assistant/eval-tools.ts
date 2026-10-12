import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { prepareAttachment } from './attachment-prep.js';
import {
  canonicalCaseNumber,
  nameHasWords,
  nameWords,
  registrationMatches,
  withoutContacts,
} from './text-rules.js';
import type {
  AttachmentReadResult,
  CaseDetail,
  CaseSearchHit,
  DentistHit,
  TriageEmail,
  TriageTools,
} from './types.js';

export { withoutContacts };

/**
 * The three lookups, answered from an invented register held in memory - and the
 * attachment reader, answered from invented files.
 *
 * For the evaluation runner (scripts/assistant-eval.ts) only. It lets the assistant be
 * scored against known answers without a database - and, more to the point, without the
 * real register: the evaluation sends every email and every lookup result to the API,
 * and nothing real belongs in that.
 *
 * AN INVENTED FILE is the text of each of its pages (the eval set's `pages`), drawn into a
 * real PDF here and then handed to the very function the register's reader uses
 * (attachment-prep.ts), so it is cut, measured and refused exactly as a real file would
 * be. Whatever an attachment's name or declared type, if it has pages it is that PDF; an
 * attachment with no pages has nothing in it to read, and says so.
 *
 * It behaves like the real lookups where the behaviour changes the model's answer: the
 * same kinds of match (case number, complainant and patient names, the complainant's
 * email, a phone number by its digits, a respondent's name), the match stated in words,
 * and NO contact details in any result. A seed's emails and mobiles are there to be
 * searched BY, never returned - exactly the rule the real tools keep - so a model that
 * scores well here has not learned to lean on data it will not get in production.
 *
 * AND NO MORE GENEROUS THAN PRODUCTION. A name is matched by the very rule the real
 * lookups use (text-rules.ts), and a dentist's CLINIC is not searched, because the real
 * search does not search it either - a clinic is found by name only when the clinic itself
 * was named on a case. An evaluation that found what production cannot would score the
 * assistant on links it will never make for the officer.
 *
 * The seed's shape is spelled out below rather than imported from @ksdc/config, so these
 * tools (and their tests) do not depend on that package having been rebuilt. The runner
 * passes ASSISTANT_EVAL_SEED in, and the compiler checks it against this shape there: if
 * the two ever drift, the runner stops compiling rather than quietly matching on nothing.
 */

export interface EvalSeedLike {
  cases: Array<{
    caseNumber: string;
    summary: string;
    state: string;
    /** YYYY-MM-DD */
    openedOn: string;
    closed: boolean;
    complainant: { name: string; email: string | null; mobile: string | null };
    patientName: string | null;
    respondents: Array<{
      name: string;
      registrationNo: string | null;
      clinicName: string | null;
      isEstablishment: boolean;
    }>;
    recentLetters: Array<{ direction: 'in' | 'out'; subject: string; date: string }>;
  }>;
  dentists: Array<{
    name: string;
    registrationNo: string | null;
    clinicName: string | null;
    priorCases: number;
  }>;
}

/** The eval set's attachment, as config's EvalAttachment writes it. */
export interface EvalAttachmentLike {
  filename: string;
  contentType: string | null;
  stored: boolean;
  /** The text of each page of an invented PDF, plain ASCII / Latin-1 (drawn in Helvetica). */
  pages?: string[];
}

/** The eval set's email, as config's EvalEmail writes it: core's TriageEmail without refs. */
export interface EvalEmailLike extends Omit<TriageEmail, 'attachments'> {
  attachments: EvalAttachmentLike[];
}

type SeedCase = EvalSeedLike['cases'][number];

const MAX_HITS = 10;

// ─── Matching ────────────────────────────────────────────────────────────────

/**
 * Does a query name this person (or clinic)? The real lookups' rule (text-rules.ts):
 * every word of the query, honorifics and initials left out, somewhere in the name - so
 * "Suresh Rao" finds "Dr. Suresh K. Rao", "S Rao" finds every Rao (the initial narrows
 * nothing), and a query of initials alone matches nobody.
 */
function nameMatches(query: string, name: string | null): boolean {
  return nameHasWords(name, nameWords(query));
}

/** A name reduced to its significant words, for telling two seed entries apart. */
function nameKey(name: string): string {
  return nameWords(name).join(' ');
}

/** Case numbers as the register reads them: case and spacing do not matter. */
function caseKey(text: string): string {
  return text.trim().toUpperCase().replace(/\s+/g, '');
}

function digitsOf(text: string | null): string {
  return (text ?? '').replace(/\D/g, '');
}

/**
 * A phone number, by its digits: "+91 98450-12345", "098450 12345" and "9845012345" are one
 * number. The last ten digits decide - the length of an Indian mobile - and fewer than
 * seven digits is not a phone number at all (it is a year, a serial, a pin code).
 */
function phoneMatches(query: string, mobile: string | null): boolean {
  const q = digitsOf(query).slice(-10);
  const m = digitsOf(mobile).slice(-10);
  if (q.length < 7 || m.length < 7) return false;
  return m.endsWith(q) || q.endsWith(m);
}

function emailMatches(query: string, email: string | null): boolean {
  const q = query.trim().toLowerCase();
  return !!email && q.includes('@') && q === email.trim().toLowerCase();
}

// ─── The dentists the invented register knows ───────────────────────────────

interface KnownDentist {
  name: string;
  registrationNo: string | null;
  clinicName: string | null;
  priorCases: number;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The seed's dentists, plus anyone named on a seed case who is not among them - the real
 * register finds a respondent from an earlier case whether or not they are in the
 * register of dentists, so the invented one must too.
 */
function knownDentists(seed: EvalSeedLike): KnownDentist[] {
  const all: KnownDentist[] = seed.dentists.map((d) => ({ ...d }));
  const byName = new Map(all.map((d) => [nameKey(d.name), d]));
  for (const c of seed.cases) {
    for (const r of c.respondents) {
      const key = nameKey(r.name);
      if (byName.has(key)) continue;
      const named = seed.cases.filter((x) => x.respondents.some((y) => nameKey(y.name) === key)).length;
      const d = { name: r.name, registrationNo: r.registrationNo, clinicName: r.clinicName, priorCases: named };
      all.push(d);
      byName.set(key, d);
    }
  }
  return all;
}

/**
 * A hit shaped as the real search shapes it: someone already named on a case comes back
 * with a party id ("seen_before"); someone known only from the register of dentists comes
 * back with a register id and no party. The ids are stable strings, so a run's suggestion
 * can be compared with the seed - and so the engine's "only ids a lookup returned" rule is
 * exercised by the evaluation exactly as it is in production.
 */
function dentistHit(d: KnownDentist): DentistHit {
  const seenBefore = d.priorCases > 0;
  return {
    partyId: seenBefore ? `eval-party-${slug(d.name)}` : null,
    registeredDentistId: !seenBefore || d.registrationNo ? `eval-rd-${slug(d.name)}` : null,
    name: d.name,
    registrationNo: d.registrationNo,
    clinicName: d.clinicName,
    priorCases: d.priorCases,
    source: seenBefore ? 'seen_before' : 'register',
  };
}

// ─── The tools ───────────────────────────────────────────────────────────────

function caseHit(c: SeedCase, matchedOn: string[]): CaseSearchHit {
  return {
    caseNumber: c.caseNumber,
    summary: withoutContacts(c.summary),
    state: c.state,
    openedOn: c.openedOn,
    closed: c.closed,
    complainantName: c.complainant.name,
    patientName: c.patientName,
    respondentNames: c.respondents.map((r) => r.name),
    matchedOn,
  };
}

/** What a query matched on one case, in words - the words the real lookup uses. */
function matchesOf(query: string, c: SeedCase): string[] {
  const on: string[] = [];
  const q = caseKey(query);
  const number = caseKey(c.caseNumber);
  if (q === number || (q.length >= 8 && q.includes(number))) on.push('case number');
  else if (q.length >= 4 && number.includes(q)) on.push('part of the case number');
  if (nameMatches(query, c.complainant.name)) on.push('complainant name');
  if (nameMatches(query, c.patientName)) on.push('patient name');
  if (emailMatches(query, c.complainant.email)) on.push('complainant email');
  if (phoneMatches(query, c.complainant.mobile)) on.push('phone number');
  // A respondent by name only - an establishment's name is its clinic's name. A dentist's
  // clinic is not searched, because the real lookup does not search it (see the header).
  if (c.respondents.some((r) => nameMatches(query, r.name))) on.push('respondent name');
  return on;
}

// ─── Attachments ─────────────────────────────────────────────────────────────

/**
 * The handle of the attachment at this index: a1, a2... in the order of the email's
 * attachments array - the same numbering the service gives the tray's attachments.
 */
export function attachmentRef(index: number): string {
  return `a${index + 1}`;
}

/** An evaluation email as the engine is given it: handles assigned, page texts left behind. */
export function evalTriageEmail(email: EvalEmailLike): TriageEmail {
  return {
    fromName: email.fromName,
    fromAddress: email.fromAddress,
    forwardedBy: email.forwardedBy,
    subject: email.subject,
    dateText: email.dateText,
    body: email.body,
    attachments: email.attachments.map((a, i) => ({
      ref: attachmentRef(i),
      filename: a.filename,
      contentType: a.contentType,
      stored: a.stored,
    })),
  };
}

/** A4, in points, with margins a letter would have. */
const PAGE_SIZE: [number, number] = [595.28, 841.89];
const MARGIN = 56;
/** Largest first; a page that will not fit in 11-point type is tried smaller, down to 6. */
const FONT_SIZES = [11, 10, 9, 8, 7, 6];

/**
 * Typographic characters an author is likely to paste, in their plain forms. Anything
 * else Helvetica's WinAnsi encoding cannot draw - the rupee sign above all - stops the
 * rendering with a message naming the page, rather than being quietly changed.
 */
const PLAIN: Array<[RegExp, string]> = [
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—]/g, '-'],
  [/…/g, '...'],
  [/[   ]/g, ' '],
  [/\t/g, '    '],
];

function plain(text: string): string {
  return PLAIN.reduce((t, [re, to]) => t.replace(re, to), text);
}

/** Greedy word wrap to `width` points; a word longer than a line is broken where it must be. */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/ +/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (fits(candidate)) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      let rest = word;
      while (!fits(rest)) {
        let n = rest.length - 1;
        while (n > 1 && !fits(rest.slice(0, n))) n--;
        lines.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * The invented file: one A4 page per string, its text wrapped to the page. A page that
 * does not fit even in 6-point type is an error in the evaluation set, not something to
 * spill onto a page the answer key never wrote - so it throws, naming the page.
 */
export async function renderEvalPdf(pages: string[]): Promise<Buffer> {
  // No metadata of its own (no creation date), so the same pages are the same bytes.
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const width = PAGE_SIZE[0] - 2 * MARGIN;
  const height = PAGE_SIZE[1] - 2 * MARGIN;

  for (const [i, raw] of pages.entries()) {
    const text = plain(raw);
    let laid: { lines: string[]; size: number; leading: number } | null = null;
    try {
      for (const size of FONT_SIZES) {
        const lines = wrapText(text, font, size, width);
        const leading = size * 1.3;
        if (lines.length * leading <= height) {
          laid = { lines, size, leading };
          break;
        }
      }
    } catch (err) {
      throw new Error(
        `Evaluation attachment page ${i + 1} has a character Helvetica cannot draw ` +
          `(${err instanceof Error ? err.message : String(err)}). Write it in plain ASCII - "Rs", not the rupee sign.`,
      );
    }
    if (!laid) throw new Error(`Evaluation attachment page ${i + 1} does not fit on one page, even in 6-point type.`);

    const page = doc.addPage(PAGE_SIZE);
    let y = PAGE_SIZE[1] - MARGIN - laid.size;
    for (const line of laid.lines) {
      if (line) page.drawText(line, { x: MARGIN, y, size: laid.size, font });
      y -= laid.leading;
    }
  }
  return Buffer.from(await doc.save());
}

export interface EvalToolsOptions {
  /** The email being triaged: read_attachment opens these, by handle (a1 is the first). */
  attachments?: EvalAttachmentLike[];
  /**
   * MAIL_ASSISTANT_MAX_PDF_PAGES. The runner passes the configured value; the default is
   * the setting's own (ASSISTANT_DEFAULTS in config.ts, not imported so that these tools
   * do not load @ksdc/config).
   */
  maxPdfPages?: number;
}

/**
 * The tools for ONE evaluation email: the lookups are the invented register's, the same
 * for every email; the reader opens this email's attachments only, as the register's
 * reader opens only the message it was built for.
 */
export function createEvalTools(seed: EvalSeedLike, opts: EvalToolsOptions = {}): TriageTools {
  const dentists = knownDentists(seed);
  const attachments = opts.attachments ?? [];
  const maxPdfPages = opts.maxPdfPages ?? 10;

  return {
    async readAttachment(ref): Promise<AttachmentReadResult> {
      const m = /^a(\d+)$/i.exec(ref.trim());
      const a = m ? attachments[Number(m[1]) - 1] : undefined;
      if (!a) return { ok: false, reason: 'There is no attachment with that handle.' };
      if (!a.stored) return { ok: false, reason: 'The register did not keep this file.' };
      if (!a.pages?.length) return { ok: false, reason: 'This test attachment has no contents.' };
      return prepareAttachment(await renderEvalPdf(a.pages), { maxPdfPages });
    },

    async searchCases(query) {
      return seed.cases
        .map((c) => ({ c, on: matchesOf(query, c) }))
        .filter((x) => x.on.length > 0)
        // More kinds of match first, then the newest case: the order a person would read them.
        .sort((a, b) => b.on.length - a.on.length || b.c.openedOn.localeCompare(a.c.openedOn))
        .slice(0, MAX_HITS)
        .map((x) => caseHit(x.c, x.on));
    },

    async getCase(caseNumber): Promise<CaseDetail | null> {
      // As written, or in the register's own form - as the real lookup reads it.
      const wanted = [caseKey(caseNumber), caseKey(canonicalCaseNumber(caseNumber) ?? caseNumber)];
      const c = seed.cases.find((x) => wanted.includes(caseKey(x.caseNumber)));
      if (!c) return null;
      return {
        caseNumber: c.caseNumber,
        summary: withoutContacts(c.summary),
        state: c.state,
        openedOn: c.openedOn,
        // The seed records THAT a case is closed but not when; `state` carries the fact,
        // and a closing date is not invented to fill the field.
        closedOn: null,
        complainantName: c.complainant.name,
        patientName: c.patientName,
        respondents: c.respondents.map((r) => ({
          name: r.name,
          registrationNo: r.registrationNo,
          clinicName: r.clinicName,
        })),
        recentLetters: c.recentLetters.map((l) => ({
          direction: l.direction,
          subject: withoutContacts(l.subject),
          date: l.date,
        })),
      };
    },

    async searchDentists(query) {
      // As the real search: a query with a digit is a registration number, anything else a
      // name - never a dentist's clinic (see the header).
      return dentists
        .filter((d) =>
          /\d/.test(query) ? registrationMatches(query, d.registrationNo) : nameMatches(query, d.name),
        )
        .sort((a, b) => b.priorCases - a.priorCases || a.name.localeCompare(b.name))
        .slice(0, MAX_HITS)
        .map(dentistHit);
    },
  };
}
