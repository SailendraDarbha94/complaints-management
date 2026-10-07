import type { MailSuggestionDecision } from '@ksdc/contracts';
import { canonicalCaseNumber } from './text-rules.js';
import type { SuggestedRespondent, TriageResult } from './types.js';

/**
 * How one evaluation email is marked against its answer key.
 *
 * Lives here rather than in the runner script so that it can be tested without spending
 * anything: a scorer that is quietly too generous makes every later decision about the
 * playbook on a number that was never true. The first version was - it matched dentists
 * by "contains" against their names AND their clinics, so naming only the dentist of
 * "Dantavarna Dental Clinics, Jayanagar" counted as also naming the clinic; it ignored
 * respondents the answer key did not list; and it failed "Dr. Divya Nair" for a full stop.
 *
 * The answer key's shape is written out here rather than imported from @ksdc/config, as
 * eval-tools.ts does with the seed, so that this file and its tests do not depend on that
 * package having been rebuilt. The runner hands it config's EvalExpected, and the compiler
 * checks the two agree there.
 */

export interface EvalExpectedLike {
  decision: MailSuggestionDecision;
  /** follow_up only: the case it belongs on. */
  caseNumber?: string;
  /** new_complaint only: every respondent a right answer names, and ONLY those. */
  respondentNames?: string[];
  /**
   * new_complaint only: respondents that must be named but NOT linked to anybody the
   * register knows - the namesake in another town, who is a different person until the
   * officer says otherwise.
   */
  unlinkedRespondents?: string[];
  /** new_complaint only, lower-case. */
  complainantEmail?: string;
}

export interface Score {
  decisionRight: boolean;
  /** Null when the check does not apply to this email. */
  caseNumberRight: boolean | null;
  /** Every respondent the key lists, and no others. */
  respondentsRight: boolean | null;
  missingRespondents: string[];
  unexpectedRespondents: string[];
  /** No respondent the key says must stay unlinked was linked. */
  linksRight: boolean | null;
  wronglyLinked: string[];
  complainantEmailRight: boolean | null;
  /** Every check that applies, passed. */
  pass: boolean;
}

/**
 * A respondent's name as the key compares it: case, punctuation, spacing and a leading
 * "Dr" do not count, so "Dr. K.S. Rao", "Dr K. S. Rao" and "k s rao" are one answer.
 */
export function respondentKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .replace(/^dr\s+/, '')
    .replace(/\s+/g, '');
}

/**
 * Does a name the model gave answer for one the key wants? Equal once normalised - or
 * the model's is the key's with more after it, as "Dantavarna Dental Clinics, Jayanagar"
 * is for "Dantavarna Dental Clinics". Never by the respondent's clinic: naming a dentist
 * is not naming the clinic they work at, which is the very mistake the chain email tests.
 */
function answers(got: SuggestedRespondent, want: string): boolean {
  const g = respondentKey(got.name);
  const w = respondentKey(want);
  return w.length > 0 && g.startsWith(w);
}

function caseKey(text: string): string {
  return (canonicalCaseNumber(text) ?? text).trim().toUpperCase().replace(/\s+/g, '');
}

export function scoreCase(expected: EvalExpectedLike, result: TriageResult): Score {
  const p = result.ok ? result.proposal : null;
  const decisionRight = !!p && p.decision === expected.decision;

  let caseNumberRight: boolean | null = null;
  if (expected.decision === 'follow_up' && expected.caseNumber) {
    caseNumberRight = !!p?.followUp && caseKey(p.followUp.caseNumber) === caseKey(expected.caseNumber);
  }

  const named = p?.newComplaint?.respondents ?? [];
  let respondentsRight: boolean | null = null;
  const missingRespondents: string[] = [];
  const unexpectedRespondents: string[] = [];
  let linksRight: boolean | null = null;
  const wronglyLinked: string[] = [];
  let complainantEmailRight: boolean | null = null;

  if (expected.decision === 'new_complaint') {
    if (expected.respondentNames?.length) {
      // Each wanted name takes one respondent, so one respondent cannot answer for two,
      // and whatever is left over was named without the key asking for it.
      const unused = [...named];
      for (const want of expected.respondentNames) {
        const at = unused.findIndex((r) => answers(r, want));
        if (at < 0) missingRespondents.push(want);
        else unused.splice(at, 1);
      }
      unexpectedRespondents.push(...unused.map((r) => r.name));
      respondentsRight = missingRespondents.length === 0 && unexpectedRespondents.length === 0;
    }
    if (expected.unlinkedRespondents?.length) {
      for (const want of expected.unlinkedRespondents) {
        const r = named.find((x) => answers(x, want));
        if (r && (r.partyId || r.registeredDentistId)) wronglyLinked.push(want);
      }
      linksRight = wronglyLinked.length === 0;
    }
    if (expected.complainantEmail) {
      complainantEmailRight =
        (p?.newComplaint?.complainantEmail ?? '').toLowerCase() === expected.complainantEmail.toLowerCase();
    }
  }

  const pass =
    decisionRight &&
    [caseNumberRight, respondentsRight, linksRight, complainantEmailRight].every((x) => x !== false);
  return {
    decisionRight,
    caseNumberRight,
    respondentsRight,
    missingRespondents,
    unexpectedRespondents,
    linksRight,
    wronglyLinked,
    complainantEmailRight,
    pass,
  };
}
