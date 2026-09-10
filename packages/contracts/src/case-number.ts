/**
 * The case number is one format string, one formatter and one regex — ADR-0001.
 *
 * In Phase 1 the officer sends mail by hand from council webmail, so there is no
 * outbound Message-ID to thread on. The reference token in the subject line is the
 * ONLY thread key that survives a copy-paste send. Nothing here may drift from the
 * regex without the round-trip test failing.
 *
 *   KSDC/COMP/2026-27/0042
 *   ^^^^ ^^^^ ^^^^^^^ ^^^^
 *   |    |    |       serial, zero-padded to 4, per council per series per FY
 *   |    |    Indian financial year, 1 April to 31 March
 *   |    series: COMP (patient complaint) | ETH (ethical violation) | RTI
 *   council code
 */

export const CASE_SERIES = ['COMP', 'ETH', 'RTI'] as const;
export type CaseSeries = (typeof CASE_SERIES)[number];

/** Matches a case number anywhere in a string (e.g. an email subject line). */
export const CASE_NUMBER_RE = /\b([A-Z]{2,8})\/(COMP|ETH|RTI)\/(\d{4})-(\d{2})\/(\d{4,6})\b/;
/** Global variant, for finding every reference in a body of text. */
export const CASE_NUMBER_RE_G = new RegExp(CASE_NUMBER_RE.source, 'g');

export interface ParsedCaseNumber {
  councilCode: string;
  series: CaseSeries;
  fiscalYear: string; // canonical "2026-27"
  serial: number;
  raw: string;
}

export function formatCaseNumber(
  councilCode: string,
  series: CaseSeries,
  fiscalYear: string,
  serial: number,
): string {
  if (!/^\d{4}-\d{2}$/.test(fiscalYear)) {
    throw new Error(`fiscalYear must look like "2026-27", got "${fiscalYear}"`);
  }
  if (!Number.isInteger(serial) || serial < 1) {
    throw new Error(`serial must be a positive integer, got ${serial}`);
  }
  return `${councilCode.toUpperCase()}/${series}/${fiscalYear}/${String(serial).padStart(4, '0')}`;
}

/** Parse the first case number found in `text`, or null. Used by the mail matcher. */
export function parseCaseNumber(text: string): ParsedCaseNumber | null {
  const m = CASE_NUMBER_RE.exec(text);
  if (!m) return null;
  const [raw, councilCode, series, startYear, endYY, serial] = m;
  return {
    councilCode: councilCode!,
    series: series as CaseSeries,
    fiscalYear: `${startYear}-${endYY}`,
    serial: Number(serial),
    raw: raw!,
  };
}

/**
 * The Indian financial year containing `date`: 1 April to 31 March.
 * A complaint received on 31 March 2027 belongs to 2026-27; on 1 April 2027, to 2027-28.
 */
export function fiscalYearOf(date: Date): string {
  const y = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? y : y - 1; // getMonth() is 0-based; 3 = April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Inclusive start and exclusive end of a fiscal year, in the council's local calendar. */
export function fiscalYearBounds(fiscalYear: string): { start: Date; endExclusive: Date } {
  const startYear = Number(fiscalYear.slice(0, 4));
  return {
    start: new Date(Date.UTC(startYear, 3, 1)),
    endExclusive: new Date(Date.UTC(startYear + 1, 3, 1)),
  };
}

/** The reference line that prints under the subject of every outgoing letter. */
export function referenceLine(caseNumber: string): string {
  return `Ref: Complaint No. ${caseNumber}`;
}

/** The subject-line token. Phase 2's mail matcher greps for exactly this. */
export function subjectWithReference(subject: string, caseNumber: string): string {
  return CASE_NUMBER_RE.test(subject) ? subject : `${subject} [${caseNumber}]`;
}
