import type {
  MailSuggestionView,
  SuggestedRespondent,
  SuggestionAttachmentRead,
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
    case 'council_letter_copy': {
      // The Council's own letter, not anybody's reply: said first, because that is the
      // point of the answer - filed as a reply it would stop reminders nobody answered.
      const c = s.councilCopy;
      return c
        ? `Suggested: copy of a Council letter → ${c.caseNumber}${c.closed ? ' (closed)' : ''} — ${c.letter}`
        : 'Suggested: copy of a Council letter';
    }
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
    case 'council_letter_copy': {
      const c = s.councilCopy;
      if (!c) return 'It did not say which case.';
      return c.caseFileId ? null : `${c.caseNumber} is not a live case in the register.`;
    }
    default:
      return 'It was not sure, so there is nothing to accept.';
  }
}

/**
 * What to tell the officer before filing on a closed case - or null when the case is open.
 * Said in the confirm step on the card and beside the button on the message page.
 */
export function closedCaseWarning(s: MailSuggestionView): string | null {
  if (s.decision === 'council_letter_copy' && s.councilCopy?.closed) {
    return `${s.councilCopy.caseNumber} is closed. Filing the copy adds it to a closed case; whether to reopen the case is your decision.`;
  }
  if (s.decision !== 'follow_up' || !s.followUp?.closed) return null;
  return `${s.followUp.caseNumber} is closed. Filing this adds it to a closed case; whether to reopen the case is your decision.`;
}

/**
 * The case a suggestion would file the message on - a follow-up's or a copy's - or null.
 * One place, so the card and the message page offer the same case for both.
 */
export function suggestedCase(
  s: MailSuggestionView,
): { caseFileId: string | null; caseNumber: string; closed: boolean } | null {
  if (s.decision === 'follow_up') return s.followUp ?? null;
  if (s.decision === 'council_letter_copy') return s.councilCopy ?? null;
  return null;
}

/**
 * What accepting a copy of a Council letter does - said beside the button, because it is
 * less than the officer might expect: it files the copy, and records nothing as sent.
 * Recording the letter as sent starts a reminder or counts a notice. That is the message
 * page's own "File the copy" panel, where what it will do is shown first - shown for a copy
 * only the assistant recognised too, while its suggestion waits - or the case page ("I have
 * sent this" on the letter, or the step's own button), before accepting or instead of it.
 *
 * When the case has a draft of the letter, accepting closes that draft off as sent (so
 * "I have sent this" cannot record it a second time) - still without starting a reminder.
 */
export const COPY_ACCEPT_EFFECT =
  'Files it on the case as a copy of a letter the Council sent - attached to that letter when the case ' +
  'records it as sent, otherwise put on the case as a letter sent. It never counts as a reply, and no ' +
  'reminder starts or stops: to start one, record the letter as sent first.';

/**
 * Why a suggestion cannot be accepted on a message the register itself knows is a copy of
 * a letter the Council sent, or null when it can.
 *
 * "Open a case" and "add it as their reply" are both wrong for such a message, and the
 * register refuses the first and files the second as a copy anyway - so Accept would be a
 * dead button, or do something other than its label says. Rejecting stays open, and the
 * copy is filed with its own panel.
 */
export function notForACopy(s: MailSuggestionView, isCouncilCopy: boolean): string | null {
  if (!isCouncilCopy || s.status !== 'pending') return null;
  if (s.decision !== 'new_complaint' && s.decision !== 'follow_up') return null;
  return (
    'The register recognises this as a copy of a letter the Council sent, so it is not ' +
    (s.decision === 'new_complaint' ? 'opened as a case' : 'added as a reply') +
    '. File it with the "File the copy" panel, or reject this suggestion.'
  );
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

// ─── What it read ────────────────────────────────────────────────────────────

/*
 * The assistant opens an attached file only when the email alone does not let it decide,
 * and whatever it opens is sent to Anthropic. The Registrar's sign-off is about what is
 * sent, so every suggestion says which files went - on the card and on the message page,
 * in the same words, failed readings included - and so do the readings of the same email
 * that are NOT the one on screen (a failed "ask again", one replaced since).
 */

/**
 * The files it read for this suggestion; empty when it went by the email alone. `?? []`
 * because the web app reads core from its BUILT output: a server not yet rebuilt sends no
 * such field, and a tray that crashed on that would be worse than one that said nothing.
 */
export function attachmentsRead(s: MailSuggestionView): SuggestionAttachmentRead[] {
  return s.attachmentsRead ?? [];
}

/** Files the email's other readings sent, not already named by this one. `?? []` as above. */
export function otherReadingsSent(s: MailSuggestionView): SuggestionAttachmentRead[] {
  return s.otherReadingsSent ?? [];
}

/** Every file named on the card, this reading's first: for the names shown on hover. */
export function allFilesSent(s: MailSuggestionView): SuggestionAttachmentRead[] {
  return [...attachmentsRead(s), ...otherReadingsSent(s)];
}

/**
 * One file as the officer reads it: "letter.pdf (first 10 of 25 pages)", "scan.pdf (all 3
 * pages)", "photo.jpg". A PDF cut short says how short, since what it did not see may
 * matter; a whole one says so too, so that "it saw all of it" is never left to a guess.
 */
export function attachmentReadName(a: SuggestionAttachmentRead): string {
  const name = a.filename.trim() || 'a file with no name';
  const sent = a.pagesSent;
  const total = a.pagesTotal;
  if (sent === null || sent === undefined) return name;
  const pages = (n: number) => `${n} page${n === 1 ? '' : 's'}`;
  if (typeof total !== 'number') return `${name} (${pages(sent)})`;
  if (sent < total) return `${name} (first ${sent} of ${pages(total)})`;
  return `${name} (${total === 1 ? '1 page' : `all ${total} pages`})`;
}

const attachments = (n: number) => `${n} attachment${n === 1 ? '' : 's'}`;

/**
 * "It read 1 attachment" - the card's short form, which opens to the full line. Null when
 * no reading of this email sent a file. "It", here and below: a bare "Read: letter.pdf"
 * can be taken as an instruction to the officer, which is the opposite of what it means.
 */
export function attachmentsReadSummary(s: MailSuggestionView): string | null {
  const own = attachmentsRead(s).length;
  const others = otherReadingsSent(s).length;
  if (own === 0 && others === 0) return null;
  if (others === 0) return `It read ${attachments(own)}`;
  if (own === 0) return `Another reading of this email read ${attachments(others)}`;
  return `It read ${attachments(own)}, and another reading ${others} more`;
}

/**
 * "It read letter.pdf (first 10 of 25 pages) and photo.jpg. Their contents were sent to
 * Anthropic with the email." Then, when another reading of the same email sent files this
 * one does not name, a sentence saying so. Null when no reading sent anything.
 *
 * A failed reading says the files WERE sent: "the assistant could not read this one" must
 * not be taken to mean nothing left the office. And it does not say the reading has ended:
 * a row also reads as failed while the model is still at work on it (STILL_READING, whose
 * own words allow for both), so the sentence is worded to be true either way.
 */
export function attachmentsReadLine(s: MailSuggestionView): string | null {
  const parts: string[] = [];
  const read = attachmentsRead(s);
  if (read.length > 0) {
    const files = joinNames(read.map(attachmentReadName));
    parts.push(
      s.status === 'failed'
        ? `It read ${files}, so ${read.length === 1 ? 'its' : 'their'} contents were sent to Anthropic, ` +
            'though this reading has no suggestion to show.'
        : `It read ${files}. ${read.length === 1 ? 'Its' : 'Their'} contents were sent to Anthropic with the email.`,
    );
  }
  const elsewhere = otherReadingsSent(s);
  if (elsewhere.length > 0) {
    const files = joinNames(elsewhere.map(attachmentReadName));
    const its = elsewhere.length === 1 ? 'Its' : 'Their';
    parts.push(
      read.length > 0
        ? `Another reading of this email also read ${files}. ${its} contents were sent to Anthropic too.`
        : `Another reading of this email, not the one shown here, read ${files}. ${its} contents were sent to Anthropic.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * What to say when "Ask again" over a suggestion still on the card comes back failed.
 *
 * A failed reading never replaces a pending suggestion - the card goes on showing the one
 * that is live - so without this the press would look as though nothing had happened, and
 * the officer would not know to look at what that reading sent (the card's own line names
 * it once the page refreshes). Null when the answer is what the page will show anyway.
 */
export function askAgainFailed(
  shown: MailSuggestionView | null,
  returned: MailSuggestionView | null | undefined,
): string | null {
  if (!returned || returned.status !== 'failed') return null;
  if (!shown || shown.status !== 'pending' || shown.id === returned.id) return null;
  return `Asking again did not work, so the suggestion above still stands: ${returned.error ?? 'no reason was given.'}`;
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
