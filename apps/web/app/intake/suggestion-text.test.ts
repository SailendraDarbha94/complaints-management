import { describe, expect, it } from 'vitest';
import type { MailSuggestionView, SuggestedRespondent } from '@/lib/api';
import {
  acceptBlocker,
  allFilesSent,
  askAgainFailed,
  attachmentReadName,
  attachmentsReadLine,
  attachmentsReadSummary,
  closedCaseWarning,
  confidenceChipClass,
  joinNames,
  knownToRegister,
  normaliseRespondent,
  sameRespondents,
  suggestionHeadline,
} from './suggestion-text';

/**
 * The words a suggestion is put into, and the comparison that decides whether the officer
 * changed it.
 *
 * The second matters more than it looks. The server records ANY override as an edit, so if
 * "Change and accept" with nothing changed sent the suggestion back with a trailing space
 * trimmed or a '' where there was a null, every such accept would count against the
 * assistant, and the agreement rate the officer judges it by would be quietly wrong.
 */

function view(over: Partial<MailSuggestionView>): MailSuggestionView {
  return {
    id: 's1',
    mailMessageId: 'm1',
    createdAt: '2026-10-07T05:00:00Z',
    status: 'pending',
    decision: null,
    confidence: 'high',
    reasoning: 'Because.',
    notComplaint: null,
    followUp: null,
    newComplaint: null,
    attachmentsRead: [],
    otherReadingsSent: [],
    model: 'claude-opus-5-5',
    costUsd: 0.03,
    error: null,
    outcome: null,
    ...over,
  };
}

const dentist = (over: Partial<SuggestedRespondent> = {}): SuggestedRespondent => ({
  name: 'Dr Asha Rao',
  registrationNo: 'KA-1123',
  clinicName: 'Smile Dental',
  isEstablishment: false,
  partyId: null,
  registeredDentistId: null,
  ...over,
});

describe('joinNames', () => {
  it('reads as a sentence', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', ' B ', '', 'C'])).toBe('A, B and C');
  });
});

describe('suggestionHeadline', () => {
  it('never reads as something already done', () => {
    const nc = view({
      decision: 'new_complaint',
      newComplaint: {
        summary: 'Crown came off',
        complainantName: 'Ravi Kumar',
        complainantEmail: null,
        respondents: [dentist(), dentist({ name: 'Smile Dental', isEstablishment: true })],
      },
    });
    expect(suggestionHeadline(nc)).toBe(
      'Suggested: open a case for Ravi Kumar against Dr Asha Rao and Smile Dental',
    );

    const fu = view({
      decision: 'follow_up',
      followUp: { caseFileId: 'c1', caseNumber: 'KSDC/12/2026', because: 'it quotes the number', closed: false },
    });
    expect(suggestionHeadline(fu)).toBe('Suggested: add to KSDC/12/2026 — it quotes the number');

    // A closed case says so in the line itself, not behind "Why it thinks so".
    const shut = view({
      decision: 'follow_up',
      followUp: { caseFileId: 'c1', caseNumber: 'KSDC/12/2026', because: 'unpaid settlement', closed: true },
    });
    expect(suggestionHeadline(shut)).toBe('Suggested: add to KSDC/12/2026 (closed) — unpaid settlement');

    const nac = view({ decision: 'not_a_complaint', notComplaint: { reason: 'a circular' } });
    expect(suggestionHeadline(nac)).toBe('Suggested: not a complaint — a circular');

    expect(suggestionHeadline(view({ decision: 'unsure', reasoning: 'Two readings.' }))).toBe(
      'Not sure: Two readings.',
    );
  });

  it('says a failure plainly', () => {
    expect(suggestionHeadline(view({ status: 'failed', error: 'The service was busy.' }))).toBe(
      'The assistant could not read this one: The service was busy.',
    );
  });
});

describe('acceptBlocker', () => {
  it('offers no Accept for a number that is not a live case, or for "not sure"', () => {
    const dead = view({
      decision: 'follow_up',
      followUp: { caseFileId: null, caseNumber: 'KSDC/99/2020', because: 'quoted', closed: false },
    });
    expect(acceptBlocker(dead)).toMatch(/KSDC\/99\/2020 is not a live case/);
    expect(acceptBlocker(view({ decision: 'unsure' }))).not.toBeNull();
    expect(acceptBlocker(view({ decision: 'not_a_complaint', status: 'rejected' }))).not.toBeNull();
    expect(acceptBlocker(view({ decision: 'not_a_complaint', notComplaint: { reason: 'x' } }))).toBeNull();
  });

  it('offers no one-click Accept for a new complaint with nobody named as complainant', () => {
    // The server clears a complainant that was the Council's own address.
    const nobody = view({
      decision: 'new_complaint',
      newComplaint: { summary: 'Crown', complainantName: '', complainantEmail: null, respondents: [] },
    });
    expect(acceptBlocker(nobody)).toMatch(/who complained/);
    expect(suggestionHeadline(nobody)).toMatch(/a complainant it could not name/);
  });
});

describe('closedCaseWarning', () => {
  it('warns before filing on a closed case, and says nothing for an open one', () => {
    const fu = (closed: boolean) =>
      view({
        decision: 'follow_up',
        followUp: { caseFileId: 'c1', caseNumber: 'KSDC/COMP/2025-26/0031', because: 'unpaid', closed },
      });
    expect(closedCaseWarning(fu(true))).toMatch(/KSDC\/COMP\/2025-26\/0031 is closed/);
    expect(closedCaseWarning(fu(false))).toBeNull();
    // A closed case is a confirm step, not a blocker: filing there is allowed.
    expect(acceptBlocker(fu(true))).toBeNull();
  });
});

describe('confidenceChipClass', () => {
  it('puts no chip beside "not sure", and keeps red for lateness', () => {
    expect(confidenceChipClass(view({ decision: 'unsure', confidence: 'low' }))).toBeNull();
    expect(confidenceChipClass(view({ decision: 'not_a_complaint', confidence: 'low' }))).toBe('chip chip-draft');
  });
});

describe('knownToRegister', () => {
  it('says how well the register knows the dentist', () => {
    expect(knownToRegister(dentist())).toBeNull();
    expect(knownToRegister(dentist({ registeredDentistId: 'r1' }))).toBe('known to the register of dentists');
    expect(knownToRegister(dentist({ partyId: 'p1' }))).toMatch(/named on an earlier case/);
    expect(knownToRegister(dentist({ partyId: 'p1', priorCases: 3 }))).toBe(
      'known to the register — 3 earlier cases',
    );
    expect(knownToRegister(dentist({ partyId: 'p1', priorCases: 1 }))).toMatch(/1 earlier case$/);
    expect(knownToRegister(dentist({ registeredDentistId: 'r1', priorCases: 0 }))).toMatch(/no earlier cases/);
  });
});

describe('what it read', () => {
  const letter = { filename: 'complaint_letter.pdf', pagesSent: 10, pagesTotal: 25 };
  const photo = { filename: 'photo.jpg', pagesSent: null, pagesTotal: null };

  it('names each file, and how much of a PDF went', () => {
    expect(attachmentReadName(letter)).toBe('complaint_letter.pdf (first 10 of 25 pages)');
    expect(attachmentReadName(photo)).toBe('photo.jpg');
    expect(attachmentReadName({ filename: 'scan.pdf', pagesSent: 3, pagesTotal: 3 })).toBe('scan.pdf (all 3 pages)');
    expect(attachmentReadName({ filename: 'note.pdf', pagesSent: 1, pagesTotal: 1 })).toBe('note.pdf (1 page)');
    expect(attachmentReadName({ filename: ' ', pagesSent: null, pagesTotal: null })).toBe('a file with no name');
  });

  it('says nothing when it went by the email alone', () => {
    expect(attachmentsReadSummary(view({}))).toBeNull();
    expect(attachmentsReadLine(view({}))).toBeNull();
    // A server not yet rebuilt sends no such fields at all.
    const old = view({});
    delete (old as Partial<MailSuggestionView>).attachmentsRead;
    delete (old as Partial<MailSuggestionView>).otherReadingsSent;
    expect(attachmentsReadLine(old)).toBeNull();
    expect(attachmentsReadSummary(old)).toBeNull();
  });

  it('says which files went to Anthropic, on the card and the page alike', () => {
    const s = view({ decision: 'not_a_complaint', attachmentsRead: [letter, photo] });
    expect(attachmentsReadSummary(s)).toBe('It read 2 attachments');
    expect(attachmentsReadLine(s)).toBe(
      'It read complaint_letter.pdf (first 10 of 25 pages) and photo.jpg. ' +
        'Their contents were sent to Anthropic with the email.',
    );
    expect(attachmentsReadSummary(view({ attachmentsRead: [photo] }))).toBe('It read 1 attachment');
  });

  it('still says so when the reading failed - or is still under way - since the files had gone', () => {
    // A row reads as failed while the model is still at work on it too, so the sentence
    // must not say the reading has ended.
    const s = view({ status: 'failed', error: 'The service was busy.', attachmentsRead: [letter] });
    expect(attachmentsReadLine(s)).toBe(
      'It read complaint_letter.pdf (first 10 of 25 pages), so its contents were sent to Anthropic, ' +
        'though this reading has no suggestion to show.',
    );
    expect(attachmentsReadLine(s)).not.toMatch(/before it failed/i);
  });

  it("names what the email's other readings sent, which no other screen shows", () => {
    // The pending suggestion read the photo; a failed "ask again" also opened the letter.
    const both = view({ attachmentsRead: [photo], otherReadingsSent: [letter] });
    expect(attachmentsReadSummary(both)).toBe('It read 1 attachment, and another reading 1 more');
    expect(attachmentsReadLine(both)).toBe(
      'It read photo.jpg. Its contents were sent to Anthropic with the email. ' +
        'Another reading of this email also read complaint_letter.pdf (first 10 of 25 pages). ' +
        'Its contents were sent to Anthropic too.',
    );
    expect(allFilesSent(both).map((a) => a.filename)).toEqual(['photo.jpg', 'complaint_letter.pdf']);

    // This one went by the email alone; the one before it did not.
    const onlyOthers = view({ otherReadingsSent: [letter, photo] });
    expect(attachmentsReadSummary(onlyOthers)).toBe('Another reading of this email read 2 attachments');
    expect(attachmentsReadLine(onlyOthers)).toBe(
      'Another reading of this email, not the one shown here, read complaint_letter.pdf (first 10 of 25 pages) ' +
        'and photo.jpg. Their contents were sent to Anthropic.',
    );
  });
});

describe('askAgainFailed', () => {
  const live = view({ id: 's1', status: 'pending', decision: 'not_a_complaint' });
  const failed = view({ id: 's2', status: 'failed', error: 'Claude is busy or unavailable just now. Try again later.' });

  it('speaks up when the failed reading will not be the one on the card', () => {
    expect(askAgainFailed(live, failed)).toBe(
      'Asking again did not work, so the suggestion above still stands: ' +
        'Claude is busy or unavailable just now. Try again later.',
    );
  });

  it('says nothing when the page will show the answer anyway', () => {
    expect(askAgainFailed(null, failed)).toBeNull();
    expect(askAgainFailed(view({ id: 's0', status: 'failed' }), failed)).toBeNull();
    expect(askAgainFailed(live, view({ id: 's3', status: 'pending' }))).toBeNull();
    expect(askAgainFailed(live, undefined)).toBeNull();
  });
});

describe('sameRespondents', () => {
  it('does not count blanks, spacing or the screen-only count as a change', () => {
    const before = [dentist({ clinicName: null, priorCases: 2, partyId: 'p1' })];
    const after = [dentist({ name: ' Dr Asha Rao ', clinicName: '', partyId: 'p1' })];
    expect(sameRespondents(after, before)).toBe(true);
  });

  it('counts a real change', () => {
    const before = [dentist({ partyId: 'p1' })];
    expect(sameRespondents([dentist({ partyId: null })], before)).toBe(false);
    expect(sameRespondents([dentist({ partyId: 'p1', isEstablishment: true })], before)).toBe(false);
    expect(sameRespondents([], before)).toBe(false);
  });

  it('never sends priorCases back', () => {
    expect(normaliseRespondent(dentist({ priorCases: 4 }))).not.toHaveProperty('priorCases');
  });
});
