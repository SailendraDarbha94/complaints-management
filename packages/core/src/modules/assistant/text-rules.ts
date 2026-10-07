/**
 * How the lookups read a name, and what they keep out of free text - written once.
 *
 * Two sets of lookups answer the model: the real ones (register-tools.ts, from the
 * database) and the evaluation's (eval-tools.ts, from an invented register in memory).
 * The evaluation is only worth running if a lookup that succeeds there would succeed in
 * production too. When each kept its own idea of "does this query name that person", the
 * evaluation found "Dr Prashanth Gowda" and production did not, and the score said the
 * assistant linked dentists it would in fact have named as strangers. So the rules both
 * sets depend on live here, and both import them.
 *
 * Pure functions, no database, no SDK: safe to import from anywhere.
 */

/**
 * Titles people put before a name. "Dr Ramesh" must find "Ramesh Bhat", and a query of
 * "Dr" alone would otherwise match every dentist in the register.
 */
export const HONORIFICS: ReadonlySet<string> = new Set([
  'dr',
  'mr',
  'mrs',
  'ms',
  'miss',
  'smt',
  'sri',
  'shri',
  'kum',
  'prof',
  'master',
]);

/** Letters and digits only, lower-cased, words separated by single spaces. */
export function normalisedName(text: string | null | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The words of a name query that say who someone is.
 *
 * Punctuation is dropped within a word ("K.S." is "ks", "D'Souza" is "dsouza"), honorifics
 * are dropped, and so is anything shorter than two characters: an initial on its own
 * matches half the register and narrows nothing. At most six words - a query is a name,
 * not a sentence.
 */
export function nameWords(query: string): string[] {
  return query
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase())
    .filter((w) => w.length >= 2 && !HONORIFICS.has(w))
    .slice(0, 6);
}

/**
 * Does this name contain every word of the query, in any order?
 *
 * Not one substring: the model writes "Gowda Prashanth" as readily as "Prashanth Gowda",
 * and the register holds whichever the complainant typed. Each word is matched anywhere in
 * the name with its punctuation removed - the same "contains" the database's ILIKE does -
 * so "ks rao" finds "Dr. K.S. Rao", and "prashant" finds "Prashanth". No words, no match:
 * an empty query names nobody.
 */
export function nameHasWords(name: string | null | undefined, words: string[]): boolean {
  if (words.length === 0) return false;
  const n = normalisedName(name);
  return n.length > 0 && words.every((w) => n.includes(w));
}

/**
 * Does a query give this registration number, whole or in part?
 *
 * Compared on letters and digits alone, so "KA 12345", "ka-12345" and "KA12345" are one
 * number however the email or the model wrote it. A query with no digit is a name, not a
 * number - "ANN" is inside too many numbers - and fewer than three characters narrows
 * nothing.
 */
export function registrationMatches(query: string, registrationNo: string | null | undefined): boolean {
  if (!registrationNo) return false;
  const q = registrationKey(query);
  return q.length >= 3 && /\d/.test(q) && registrationKey(registrationNo).includes(q);
}

export function registrationKey(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * A case number written loosely, in the register's own form - or null if it is not one.
 *
 * The playbook says it plainly: a number in the register's exact form would have filed
 * the message by itself, so the numbers the assistant meets are the loose ones -
 * "KSDC-COMP-2026-27-0042", "ksdc/comp/2026-27/42", "KSDC COMP 2026 27 42". Opening a case
 * "by number" only on the exact form would make the one lookup the playbook insists on
 * before any follow-up fail on exactly the mail it exists for. Two words, the four-digit
 * year, the two-digit year after it, and the serial padded to four: CODE/SERIES/YYYY-YY/NNNN.
 */
export function canonicalCaseNumber(text: string): string | null {
  const m = /^\s*([A-Za-z]{2,10})\W*([A-Za-z]{2,10})\W*(\d{4})\W*(\d{2})\W*(\d{1,4})\s*$/.exec(text);
  if (!m) return null;
  const [, code, series, year, next, serial] = m;
  return `${code!.toUpperCase()}/${series!.toUpperCase()}/${year}-${next}/${serial!.padStart(4, '0')}`;
}

// ─── Keeping contact details out of what the model reads ─────────────────────

const EMAIL_IN_TEXT = /[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}/g;
const DIGIT_RUN = /\+?\d[\d\s-]*\d/g;

/**
 * Free text with any email address or phone number taken out.
 *
 * The lookups are built field by field and carry no contact fields at all; this is the
 * second line, for the free text they do carry - a case summary, the subject of an
 * earlier letter - which was written by whoever sent it and very often quotes a number to
 * call back on. Those belong to other complainants, and a model reading an email anybody
 * on the internet could have written has no use for them. Ten digits or more is a phone
 * number; eight is a date ("2026-09-14"), and dates and case numbers must survive.
 */
export function withoutContacts(text: string): string {
  return text
    .replace(EMAIL_IN_TEXT, '[address removed]')
    .replace(DIGIT_RUN, (run) => (run.replace(/\D/g, '').length >= 10 ? '[number removed]' : run));
}
