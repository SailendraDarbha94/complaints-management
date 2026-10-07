import { describe, expect, it } from 'vitest';
import * as config from '@ksdc/config';
import { createEvalTools, withoutContacts, type EvalSeedLike } from './eval-tools.js';

/**
 * The invented register the evaluation runs against.
 *
 * What matters is that it finds what the real lookups would find, by the same kinds of
 * match - and that, like them, it never hands back an email address or a phone number,
 * however it was searched. A seed of its own, invented, so these tests do not move when
 * the evaluation set is edited.
 */

const SEED: EvalSeedLike = {
  cases: [
    {
      caseNumber: 'KSDC/COMP/2026-27/0012',
      summary: 'Crown came off within a week; refitting refused (call 98450 12345, or asha.alt@example.org)',
      state: 'notice_issued',
      openedOn: '2026-07-02',
      closed: false,
      complainant: { name: 'Asha Rao', email: 'asha.rao@example.com', mobile: '+91 98450 12345' },
      patientName: 'Ravi Rao',
      respondents: [{ name: 'Dr. Suresh Rao', registrationNo: 'KSDC-1234', clinicName: 'Smile Dental', isEstablishment: false }],
      recentLetters: [
        { direction: 'out', subject: 'Notice to respondent', date: '2026-07-10' },
        { direction: 'in', subject: 'Reply sent from 9845012345 on 2026-07-14', date: '2026-07-14' },
      ],
    },
    {
      caseNumber: 'KSDC/COMP/2025-26/0101',
      summary: 'Implant failed within a month',
      state: 'closed',
      openedOn: '2025-11-03',
      closed: true,
      complainant: { name: 'Mohammed Irfan', email: null, mobile: '080-2222 3333' },
      patientName: null,
      respondents: [
        { name: 'Bright Smiles Dental Chain', registrationNo: null, clinicName: null, isEstablishment: true },
        { name: 'Dr. K. Bhat', registrationNo: null, clinicName: 'Bhat Dental', isEstablishment: false },
      ],
      recentLetters: [],
    },
  ],
  dentists: [
    { name: 'Dr. Suresh Rao', registrationNo: 'KSDC-1234', clinicName: 'Smile Dental', priorCases: 1 },
    { name: 'Dr. Lakshmi Narayan', registrationNo: 'KSDC-5678', clinicName: 'Narayan Dental Care', priorCases: 0 },
  ],
};

const CONTACTS = ['asha.rao@example.com', 'asha.alt@example.org', '98450', '9845012345', '2222 3333', '22223333'];

const tools = createEvalTools(SEED);

async function matched(query: string): Promise<Record<string, string[]>> {
  const hits = await tools.searchCases(query);
  return Object.fromEntries(hits.map((h) => [h.caseNumber, h.matchedOn]));
}

describe('searching cases', () => {
  it('finds a case by its number, whatever the case and spacing', async () => {
    expect(await matched('ksdc/comp/2026-27/ 0012')).toEqual({ 'KSDC/COMP/2026-27/0012': ['case number'] });
    expect(await matched('Ref: KSDC/COMP/2025-26/0101')).toEqual({ 'KSDC/COMP/2025-26/0101': ['case number'] });
  });

  it('finds a case by part of its number', async () => {
    expect(await matched('2026-27/0012')).toEqual({ 'KSDC/COMP/2026-27/0012': ['part of the case number'] });
  });

  it('finds the complainant and the patient by name, and says which', async () => {
    expect(await matched('Asha Rao')).toEqual({ 'KSDC/COMP/2026-27/0012': ['complainant name'] });
    expect(await matched('Ravi')).toEqual({ 'KSDC/COMP/2026-27/0012': ['patient name'] });
    // A surname is a search by surname: complainant, patient and dentist all match.
    expect(await matched('Rao')).toEqual({
      'KSDC/COMP/2026-27/0012': ['complainant name', 'patient name', 'respondent name'],
    });
  });

  it('finds the complainant by email address, in any case', async () => {
    expect(await matched('ASHA.RAO@example.com')).toEqual({ 'KSDC/COMP/2026-27/0012': ['complainant email'] });
    expect(await matched('asha@example.com')).toEqual({});
  });

  it('finds a phone number by its digits, however it is written', async () => {
    for (const q of ['9845012345', '+91-98450-12345', '098450 12345']) {
      expect(await matched(q)).toEqual({ 'KSDC/COMP/2026-27/0012': ['phone number'] });
    }
    expect(await matched('080 2222 3333')).toEqual({ 'KSDC/COMP/2025-26/0101': ['phone number'] });
    // Five digits is not a phone number, even when they are the end of one.
    expect(await matched('12345')).toEqual({});
  });

  it('finds a case by the dentist or clinic named on it - by name, as the real search does', async () => {
    expect(await matched('Suresh Rao')).toEqual({ 'KSDC/COMP/2026-27/0012': ['respondent name'] });
    // Every query word inside the name: "Smile Dental" is in "Bright SMILEs DENTAL Chain",
    // which was named on 0101. Dr Suresh Rao's CLINIC is Smile Dental too, but a dentist's
    // clinic is not searched - the real lookup cannot search it, so neither may this one.
    expect(await matched('Smile Dental')).toEqual({ 'KSDC/COMP/2025-26/0101': ['respondent name'] });
    expect(await matched('Bright Smiles')).toEqual({ 'KSDC/COMP/2025-26/0101': ['respondent name'] });
  });

  it('matches nobody on initials alone, or on a stranger', async () => {
    expect(await matched('S R')).toEqual({});
    expect(await matched('Dr.')).toEqual({});
    expect(await matched('Nobody Here')).toEqual({});
  });

  it('returns the case as the contract shapes it', async () => {
    const [hit] = await tools.searchCases('Irfan');
    expect(hit).toEqual({
      caseNumber: 'KSDC/COMP/2025-26/0101',
      summary: 'Implant failed within a month',
      state: 'closed',
      openedOn: '2025-11-03',
      closed: true,
      complainantName: 'Mohammed Irfan',
      patientName: null,
      respondentNames: ['Bright Smiles Dental Chain', 'Dr. K. Bhat'],
      matchedOn: ['complainant name'],
    });
  });
});

describe('opening a case', () => {
  it('by number, in any case', async () => {
    const c = await tools.getCase('ksdc/comp/2026-27/0012');
    expect(c).toMatchObject({
      caseNumber: 'KSDC/COMP/2026-27/0012',
      complainantName: 'Asha Rao',
      patientName: 'Ravi Rao',
      respondents: [{ name: 'Dr. Suresh Rao', registrationNo: 'KSDC-1234', clinicName: 'Smile Dental' }],
    });
    expect(c!.recentLetters).toHaveLength(2);
  });

  it('a closed case says so in its state, and no closing date is made up', async () => {
    expect(await tools.getCase('KSDC/COMP/2025-26/0101')).toMatchObject({ state: 'closed', closedOn: null });
  });

  it('returns null for a number the register does not have', async () => {
    expect(await tools.getCase('KSDC/COMP/2026-27/9999')).toBeNull();
  });

  it('by a number written loosely, as the real lookup reads it', async () => {
    for (const loose of ['KSDC-COMP-2026-27-0012', 'ksdc/comp/2026-27/12', 'KSDC COMP 2026 27 12']) {
      expect((await tools.getCase(loose))?.caseNumber, loose).toBe('KSDC/COMP/2026-27/0012');
    }
  });
});

describe('searching dentists', () => {
  it('finds a dentist named before, with a party id and their history', async () => {
    expect(await tools.searchDentists('Suresh')).toEqual([
      {
        partyId: 'eval-party-dr-suresh-rao',
        registeredDentistId: 'eval-rd-dr-suresh-rao',
        name: 'Dr. Suresh Rao',
        registrationNo: 'KSDC-1234',
        clinicName: 'Smile Dental',
        priorCases: 1,
        source: 'seen_before',
      },
    ]);
  });

  it('finds a dentist known only to the register of dentists, with no party id', async () => {
    const [hit] = await tools.searchDentists('Lakshmi Narayan');
    expect(hit).toMatchObject({ name: 'Dr. Lakshmi Narayan', partyId: null, source: 'register', priorCases: 0 });
    expect(hit!.registeredDentistId).toBeTruthy();
  });

  it('reads a name as the real search does: honorifics dropped, any order, no clinic', async () => {
    expect((await tools.searchDentists('Dr. Rao Suresh')).map((d) => d.name)).toEqual(['Dr. Suresh Rao']);
    expect((await tools.searchDentists('Dr Suresh Rao (Smile Dental)')).map((d) => d.name)).toEqual([]);
    // The clinic a dentist works at does not find them - production cannot do that.
    expect(await tools.searchDentists('Narayan Dental Care')).toEqual([]);
  });

  it('finds a dentist by registration number, whole or in part', async () => {
    expect((await tools.searchDentists('ksdc 5678')).map((d) => d.name)).toEqual(['Dr. Lakshmi Narayan']);
    expect((await tools.searchDentists('1234')).map((d) => d.name)).toEqual(['Dr. Suresh Rao']);
  });

  it('finds respondents of earlier cases who are not in the dentists list', async () => {
    expect(await tools.searchDentists('Bhat')).toEqual([
      expect.objectContaining({ name: 'Dr. K. Bhat', priorCases: 1, source: 'seen_before', partyId: 'eval-party-dr-k-bhat' }),
    ]);
    expect((await tools.searchDentists('Bright Smiles'))[0]).toMatchObject({ name: 'Bright Smiles Dental Chain' });
  });
});

describe('contact details', () => {
  it('are never returned, however the register is searched', async () => {
    const queries = [
      'Asha Rao', 'Rao', 'asha.rao@example.com', '9845012345', '080 2222 3333', 'Irfan', 'Suresh',
      'KSDC/COMP/2026-27/0012', 'KSDC/COMP/2025-26/0101', 'Smile Dental', 'Bhat', 'Narayan',
    ];
    const out: unknown[] = [];
    for (const q of queries) {
      out.push(await tools.searchCases(q), await tools.searchDentists(q), await tools.getCase(q));
    }
    const text = JSON.stringify(out);
    expect(text).toContain('Asha Rao'); // the searches did find things
    for (const c of CONTACTS) expect(text).not.toContain(c);
  });

  it('are taken out of free text, while dates and case numbers survive', () => {
    expect(withoutContacts('Call 98450 12345 or write to a.b@example.com')).toBe(
      'Call [number removed] or write to [address removed]',
    );
    expect(withoutContacts('Hearing on 2026-09-14 in KSDC/COMP/2026-27/0012')).toBe(
      'Hearing on 2026-09-14 in KSDC/COMP/2026-27/0012',
    );
  });
});

/**
 * The real evaluation set, when @ksdc/config has been built with it. Skipped otherwise -
 * these check the set's own consistency, not the tools, and the set is written elsewhere.
 */
const real = (config as Record<string, unknown>).ASSISTANT_EVAL_SEED as EvalSeedLike | undefined;
const realCases = (config as Record<string, unknown>).ASSISTANT_EVAL_CASES as
  | Array<{ id: string; expected: { decision: string; caseNumber?: string } }>
  | undefined;

describe.skipIf(!real || !realCases)('the evaluation set in @ksdc/config', () => {
  it('has every follow-up answer on its invented register', async () => {
    const t = createEvalTools(real!);
    for (const c of realCases!) {
      if (c.expected.decision !== 'follow_up' || !c.expected.caseNumber) continue;
      expect(await t.getCase(c.expected.caseNumber), `${c.id} expects ${c.expected.caseNumber}`).not.toBeNull();
    }
  });

  it('leaks no contact details through any lookup', async () => {
    const t = createEvalTools(real!);
    const contacts = real!.cases.flatMap((c) => [c.complainant.email, c.complainant.mobile]).filter((x): x is string => !!x);
    const out: unknown[] = [];
    for (const c of real!.cases) {
      for (const q of [c.complainant.name, c.complainant.email, c.complainant.mobile, c.caseNumber]) {
        if (!q) continue;
        out.push(await t.searchCases(q), await t.searchDentists(q), await t.getCase(q));
      }
    }
    const text = JSON.stringify(out);
    for (const c of contacts) {
      expect(text).not.toContain(c);
      const digits = c.replace(/\D/g, '');
      if (digits.length >= 10) expect(text.replace(/\D/g, ' ')).not.toContain(digits.slice(-10));
    }
  });
});
