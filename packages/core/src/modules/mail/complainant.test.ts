import { describe, expect, it } from 'vitest';
import {
  intakeAccountOf,
  isOwnAddress,
  ownAddressesOf,
  suggestedComplainant,
} from './complainant.js';

/**
 * The Council never complains to itself.
 *
 * Written after the first real forward from the office webmail opened a case naming the
 * Council's own registrar address as the complainant. Invented addresses throughout.
 */

const own = ownAddressesOf({
  officialEmail: 'Registrar@Example-Council.in',
  website: 'https://www.example-council.in/',
  intakeAccount: 'council.intake@gmail.com',
});

describe("the Council's own addresses", () => {
  it('include the official address, whatever its case', () => {
    expect(isOwnAddress('registrar@example-council.in', own)).toBe(true);
    expect(isOwnAddress('REGISTRAR@EXAMPLE-COUNCIL.IN', own)).toBe(true);
  });

  it('include every address on the Council website domain, and its subdomains', () => {
    expect(isOwnAddress('president@example-council.in', own)).toBe(true);
    expect(isOwnAddress('office@mail.example-council.in', own)).toBe(true);
  });

  it('include the intake mailbox this software reads', () => {
    expect(isOwnAddress('council.intake@gmail.com', own)).toBe(true);
  });

  it('do NOT include everyone who shares a public mail provider with the intake mailbox', () => {
    // The domain comes from the website, never from a gmail.com address.
    expect(isOwnAddress('a.patient@gmail.com', own)).toBe(false);
  });

  it('do not include a domain that merely ends in the same letters', () => {
    expect(isOwnAddress('someone@notexample-council.in', own)).toBe(false);
  });

  it('read the account out of a stored mailbox key', () => {
    expect(intakeAccountOf('council.intake@gmail.com/INBOX')).toBe('council.intake@gmail.com');
    expect(intakeAccountOf('INBOX')).toBeNull();
    expect(intakeAccountOf(null)).toBeNull();
  });
});

describe('the complainant a message points at', () => {
  const fromOffice = {
    envelope_from: 'registrar@example-council.in',
    envelope_from_name: 'Registrar Example Council',
  };

  it('is the original sender of a forward', () => {
    expect(
      suggestedComplainant(
        { ...fromOffice, original_from: 'ln.rao@example.in', original_from_name: 'L. N. Rao' },
        own,
      ),
    ).toEqual({ name: 'L. N. Rao', email: 'ln.rao@example.in' });
  });

  it('is unknown - not the Council - when a forward from the office could not be read', () => {
    expect(
      suggestedComplainant({ ...fromOffice, original_from: null, original_from_name: null }, own),
    ).toBeNull();
  });

  it('is the sender when somebody wrote to us directly', () => {
    expect(
      suggestedComplainant(
        {
          envelope_from: 'A.Patient@Example.in',
          envelope_from_name: 'A. Patient',
          original_from: null,
          original_from_name: null,
        },
        own,
      ),
    ).toEqual({ name: 'A. Patient', email: 'a.patient@example.in' });
  });

  it("never borrows the forwarding officer's name for somebody else's address", () => {
    const out = suggestedComplainant(
      { ...fromOffice, original_from: 'ln.rao@example.in', original_from_name: null },
      own,
    );
    expect(out).toEqual({ name: 'ln.rao', email: 'ln.rao@example.in' });
  });

  it('is unknown when the "original" is a letter of our own, forwarded back to us', () => {
    expect(
      suggestedComplainant(
        { ...fromOffice, original_from: 'registrar@example-council.in', original_from_name: 'Registrar' },
        own,
      ),
    ).toBeNull();
  });
});
