import type {
  MailSuggestionView,
  SuggestedRespondent,
  SuggestionOverrides,
} from '@/lib/api';

/**
 * How a suggestion is put into words - one place, for the tray card, the message page and
 * the report.
 *
 * Pure functions with no 'use client' and no server import, so a server page and a client
 * component can both call them. That matters more than it looks: the card and the message
 * page describing the same suggestion in two different sentences would leave the officer
 * wondering whether they were looking at two suggestions.
 */

/** "Dr A", "Dr A and Dr B", "Dr A, Dr B and Smile Dental". */
export function joinNames(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? '';
  return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
}

/**
 * The one line the officer reads first.
 *
 * Starts with "Suggested:" or "Not sure:" so it can never be mistaken for something that
 * has already happened; the register has not changed, and the sentence must not imply it
 * has. Null when there is nothing to say (a suggestion with no decision and no error,
 * which the contract does not produce but a half-written row could).
 */
export function suggestionHeadline(s: MailSuggestionView): string | null {
  if (s.status === 'failed') {
    return `The assistant could not read this one: ${s.error ?? 'no reason was given.'}`;
  }
  switch (s.decision) {
    case 'new_complaint': {
      const nc = s.newComplaint;
      if (!nc) return 'Suggested: open a case';
      // Cleared by the server when the model named the Council itself (see acceptBlocker).
      const who = nc.complainantName.trim() || 'a complainant it could not name';
      const against = joinNames(nc.respondents.map((r) => r.name));
      return against
        ? `Suggested: open a case for ${who} against ${against}`
        : `Suggested: open a case for ${who} — no dentist named yet`;
    }
    case 'follow_up':
      // "(closed)" in the line itself, not only in the reasons behind a click: filing on a
      // closed case is a decision the officer must see they are making.
      return s.followUp
        ? `Suggested: add to ${s.followUp.caseNumber}${s.followUp.closed ? ' (closed)' : ''} — ${s.followUp.because}`
        : 'Suggested: add to a case';
    case 'not_a_complaint':
      return s.notComplaint
        ? `Suggested: not a complaint — ${s.notComplaint.reason}`
        : 'Suggested: not a complaint';
    case 'unsure':
      return `Not sure: ${s.reasoning ?? 'it could not tell what this is.'}`;
    default:
      return null;
  }
}

/**
 * The chip beside the headline. Seal red is kept for lateness and for ending a case, so a
 * low-confidence suggestion is amber, not red: it is a reason to look harder, not alarm.
 * None for 'unsure' - "Not sure" with a "Not very sure" chip beside it says it twice.
 */
export function confidenceChipClass(s: MailSuggestionView): string | null {
  if (s.status === 'failed' || s.decision === 'unsure' || !s.confidence) return null;
  return s.confidence === 'high'
    ? 'chip chip-verbatim'
    : s.confidence === 'low'
      ? 'chip chip-draft'
      : 'chip';
}

/**
 * Whether the suggestion can be carried out as it stands, and if not, why not.
 *
 * A follow-up whose number is not a live case cannot be filed anywhere until the officer
 * picks the right case, and "not sure" has nothing to carry out - in both, Accept is not
 * offered, rather than offered and refused. The reason only: the way forward differs
 * between the card and the message page, so each caller says its own.
 */
export function acceptBlocker(s: MailSuggestionView): string | null {
  if (s.status !== 'pending') return 'This suggestion has already been dealt with.';
  switch (s.decision) {
    case 'new_complaint':
      // An empty name is the server having cleared the Council's own address: nobody is
      // put on a case as complaining until the officer says who.
      return s.newComplaint?.complainantName.trim() ? null : 'It did not say who complained.';
    case 'follow_up':
      if (!s.followUp) return 'It did not say which case.';
      return s.followUp.caseFileId
        ? null
        : `${s.followUp.caseNumber} is not a live case in the register.`;
    case 'not_a_complaint':
      return null;
    default:
      return 'It was not sure, so there is nothing to accept.';
  }
}

/**
 * What to tell the officer before filing on a closed case - or null when the case is open.
 * Said in the confirm step on the card and beside the button on the message page.
 */
export function closedCaseWarning(s: MailSuggestionView): string | null {
  if (s.decision !== 'follow_up' || !s.followUp?.closed) return null;
  return `${s.followUp.caseNumber} is closed. Filing this adds it to a closed case; whether to reopen the case is your decision.`;
}

/**
 * "known to the register - 3 earlier cases", for a dentist the model matched.
 *
 * The count needs `priorCases`, which the contract does not carry on a suggested dentist
 * yet (see SuggestedRespondent in lib/api.ts); without it the line still says the match
 * was made, and where from, which is what tells the officer the history will be joined up.
 */
export function knownToRegister(r: SuggestedRespondent): string | null {
  if (!r.partyId && !r.registeredDentistId) return null;
  if (typeof r.priorCases === 'number') {
    const n = r.priorCases;
    return `known to the register — ${n === 0 ? 'no' : n} earlier case${n === 1 ? '' : 's'}`;
  }
  return r.partyId
    ? 'known to the register — named on an earlier case'
    : 'known to the register of dentists';
}

/** One dentist's particulars on a line: "Reg. KA-1123 · Smile Dental · a clinic". */
export function respondentParticulars(r: SuggestedRespondent): string {
  return [
    r.registrationNo && `Reg. ${r.registrationNo}`,
    r.clinicName,
    r.isEstablishment && 'a clinic or chain, not one dentist',
  ]
    .filter(Boolean)
    .join(' · ');
}

// ─── Building overrides ──────────────────────────────────────────────────────

/**
 * A dentist as the server takes it back: without the screen-only `priorCases`, with blank
 * text as null. Two respondents that differ only in a trailing space or '' versus null are
 * the same respondent, and must not turn an unchanged accept into an 'edited' one.
 */
export function normaliseRespondent(
  r: SuggestedRespondent,
): NonNullable<SuggestionOverrides['respondents']>[number] {
  const text = (v: string | null) => (v && v.trim() ? v.trim() : null);
  return {
    name: r.name.trim(),
    registrationNo: text(r.registrationNo),
    clinicName: text(r.clinicName),
    isEstablishment: r.isEstablishment,
    partyId: r.partyId,
    registeredDentistId: r.registeredDentistId,
  };
}

export function sameRespondents(a: SuggestedRespondent[], b: SuggestedRespondent[]): boolean {
  return (
    JSON.stringify(a.map(normaliseRespondent)) === JSON.stringify(b.map(normaliseRespondent))
  );
}
