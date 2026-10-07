import { describe, expect, it } from 'vitest';
import { respondentKey, scoreCase, type EvalExpectedLike } from './eval-score.js';
import type { SuggestedRespondent, TriageProposal, TriageResult } from './types.js';

/**
 * The evaluation's marking, without spending anything.
 *
 * A scorer that is quietly too generous makes every later decision about the playbook on
 * a number that was never true - so each test below is a way the first version of it was
 * wrong, or could have been.
 */

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function answered(proposal: TriageProposal): TriageResult {
  return { ok: true, proposal, model: 'm', usage, costUsd: 0, toolCalls: 0 };
}

const dentist = (name: string, over: Partial<SuggestedRespondent> = {}): SuggestedRespondent => ({
  name,
  registrationNo: null,
  clinicName: null,
  isEstablishment: false,
  partyId: null,
  registeredDentistId: null,
  ...over,
});

function complaint(respondents: SuggestedRespondent[], complainantEmail: string | null = null): TriageResult {
  return answered({
    decision: 'new_complaint',
    confidence: 'high',
    reasoning: 'r',
    notComplaint: null,
    followUp: null,
    newComplaint: { summary: 's', complainantName: 'c', complainantEmail, respondents },
  });
}

describe('naming respondents', () => {
  const chain: EvalExpectedLike = {
    decision: 'new_complaint',
    respondentNames: ['Dr Meghana Kulkarni', 'Dantavarna Dental Clinics'],
  };

  it('does not count a dentist\'s clinic as naming the clinic itself', () => {
    // The chain email's whole point: name the establishment as well.
    const s = scoreCase(
      chain,
      complaint([dentist('Dr Meghana Kulkarni', { clinicName: 'Dantavarna Dental Clinics, Jayanagar, Bengaluru' })]),
    );
    expect(s.respondentsRight).toBe(false);
    expect(s.missingRespondents).toEqual(['Dantavarna Dental Clinics']);
    expect(s.pass).toBe(false);
  });

  it('passes the right two, in any order, written loosely', () => {
    const s = scoreCase(
      chain,
      complaint([
        dentist('Dantavarna Dental Clinics, Jayanagar', { isEstablishment: true }),
        dentist('Dr. Meghana  Kulkarni'),
      ]),
    );
    expect(s).toMatchObject({ respondentsRight: true, missingRespondents: [], unexpectedRespondents: [], pass: true });
  });

  it('ignores case, punctuation, spacing and a leading Dr', () => {
    expect(respondentKey('Dr. K.S. Rao')).toBe(respondentKey('k s rao'));
    const one: EvalExpectedLike = { decision: 'new_complaint', respondentNames: ['Dr Divya Nair'] };
    expect(scoreCase(one, complaint([dentist('Dr. Divya Nair')])).respondentsRight).toBe(true);
    expect(scoreCase(one, complaint([dentist('DIVYA NAIR')])).respondentsRight).toBe(true);
  });

  it('fails a respondent the key does not name', () => {
    const one: EvalExpectedLike = { decision: 'new_complaint', respondentNames: ['Dr Divya Nair'] };
    const s = scoreCase(one, complaint([dentist('Dr Divya Nair'), dentist('Reddy Dental Specialities')]));
    expect(s.respondentsRight).toBe(false);
    expect(s.unexpectedRespondents).toEqual(['Reddy Dental Specialities']);
  });

  it('does not let one respondent answer for two', () => {
    const two: EvalExpectedLike = { decision: 'new_complaint', respondentNames: ['Dr Rao', 'Dr Rao'] };
    expect(scoreCase(two, complaint([dentist('Dr Rao')])).respondentsRight).toBe(false);
  });
});

describe('the namesake who must not be linked', () => {
  const key: EvalExpectedLike = {
    decision: 'new_complaint',
    respondentNames: ['Dr Arjun Reddy', 'Dr Divya Nair'],
    unlinkedRespondents: ['Dr Arjun Reddy'],
  };

  it('fails when the namesake is linked to the register', () => {
    const s = scoreCase(
      key,
      complaint([dentist('Dr Arjun Reddy', { registeredDentistId: 'eval-rd-dr-arjun-reddy' }), dentist('Dr Divya Nair')]),
    );
    expect(s).toMatchObject({ respondentsRight: true, linksRight: false, wronglyLinked: ['Dr Arjun Reddy'], pass: false });
  });

  it('passes when he is named and left unlinked', () => {
    const s = scoreCase(key, complaint([dentist('Dr Arjun Reddy'), dentist('Dr Divya Nair')]));
    expect(s).toMatchObject({ linksRight: true, pass: true });
  });
});

describe('the rest of the key', () => {
  it('a follow-up is right only on the right case, however the number was written', () => {
    const key: EvalExpectedLike = { decision: 'follow_up', caseNumber: 'KSDC/COMP/2026-27/0011' };
    const fu = (caseNumber: string) =>
      answered({
        decision: 'follow_up',
        confidence: 'high',
        reasoning: 'r',
        notComplaint: null,
        followUp: { caseNumber, because: 'b' },
        newComplaint: null,
      });
    expect(scoreCase(key, fu('KSDC/COMP/2026-27/0011')).pass).toBe(true);
    expect(scoreCase(key, fu('ksdc-comp-2026-27-11')).pass).toBe(true);
    expect(scoreCase(key, fu('KSDC/COMP/2026-27/0012')).pass).toBe(false);
  });

  it('checks the complainant\'s address when the key gives one, and a failed run passes nothing', () => {
    const key: EvalExpectedLike = { decision: 'new_complaint', complainantEmail: 'a@example.in' };
    expect(scoreCase(key, complaint([], 'A@Example.in')).complainantEmailRight).toBe(true);
    expect(scoreCase(key, complaint([], null)).pass).toBe(false);
    const failed: TriageResult = { ok: false, error: 'e', model: 'm', usage, costUsd: 0, toolCalls: 0 };
    expect(scoreCase({ decision: 'not_a_complaint' }, failed)).toMatchObject({ decisionRight: false, pass: false });
  });
});
