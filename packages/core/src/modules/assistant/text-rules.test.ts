import { describe, expect, it } from 'vitest';
import {
  canonicalCaseNumber,
  nameHasWords,
  nameWords,
  registrationMatches,
  withoutContacts,
} from './text-rules.js';

/**
 * The rules the real lookups and the evaluation's both read names and numbers by. Pure,
 * so no database: what matters is that the two sets of lookups cannot drift apart, and
 * these are the single copy they share.
 */

describe('reading a name query', () => {
  it('drops honorifics, punctuation and lone initials', () => {
    expect(nameWords('Dr. Prashanth Gowda')).toEqual(['prashanth', 'gowda']);
    expect(nameWords('Smt. K. S. Lakshmi')).toEqual(['lakshmi']);
    expect(nameWords("Dr D'Souza")).toEqual(['dsouza']);
    expect(nameWords('Dr. S R')).toEqual([]);
  });

  it('finds a name holding every word, in any order - and nothing on no words', () => {
    const words = nameWords('Dr Gowda Prashanth');
    expect(nameHasWords('Prashanth Gowda', words)).toBe(true);
    expect(nameHasWords('Dr. Prashanth Gowda', nameWords('Prashant Gowda'))).toBe(true);
    expect(nameHasWords('Prashanth Hegde', words)).toBe(false);
    expect(nameHasWords('Dr. K.S. Rao', nameWords('KS Rao'))).toBe(true);
    expect(nameHasWords('Anybody', [])).toBe(false);
    expect(nameHasWords(null, words)).toBe(false);
  });
});

describe('registration numbers', () => {
  it('match on letters and digits, however spaced, and never on a name', () => {
    expect(registrationMatches('KA 12345', 'KA-12345')).toBe(true);
    expect(registrationMatches('ka-12345', 'KA-12345')).toBe(true);
    expect(registrationMatches('12345', 'KA-12345')).toBe(true);
    expect(registrationMatches('KA-12346', 'KA-12345')).toBe(false);
    expect(registrationMatches('ANN', 'ANN-123')).toBe(false); // no digit: a name, not a number
    expect(registrationMatches('12', 'KA-12345')).toBe(false); // too short to narrow anything
    expect(registrationMatches('12345', null)).toBe(false);
  });
});

describe('a loosely written case number', () => {
  it('reads as the register writes it', () => {
    expect(canonicalCaseNumber('KSDC-COMP-2026-27-0042')).toBe('KSDC/COMP/2026-27/0042');
    expect(canonicalCaseNumber('ksdc/comp/2026-27/42')).toBe('KSDC/COMP/2026-27/0042');
    expect(canonicalCaseNumber(' KSDC COMP 2026 27 42 ')).toBe('KSDC/COMP/2026-27/0042');
    expect(canonicalCaseNumber('KSDC/COMP/2026-27/0042')).toBe('KSDC/COMP/2026-27/0042');
  });

  it('is not invented from something that is not one', () => {
    // The office despatch number, another body's shape, a bare serial, prose.
    expect(canonicalCaseNumber('KSDC/297/2026-27')).toBeNull();
    expect(canonicalCaseNumber('42')).toBeNull();
    expect(canonicalCaseNumber('complaint no. 42 of 2026-27')).toBeNull();
  });
});

describe('contact details in free text', () => {
  it('are taken out, while dates and case numbers survive', () => {
    expect(withoutContacts('Please call 98450 12345 / ravi@example.in')).toBe(
      'Please call [number removed] / [address removed]',
    );
    expect(withoutContacts('Hearing on 2026-09-14 in KSDC/COMP/2026-27/0012')).toBe(
      'Hearing on 2026-09-14 in KSDC/COMP/2026-27/0012',
    );
  });
});
