import { describe, expect, it } from 'vitest';
import { renderTemplate, subjectWithReference } from '@ksdc/contracts';
import { KSDC_TEMPLATES } from '@ksdc/config';
import { ownAddressesOf } from './complainant.js';
import {
  addressesIn,
  bareSubject,
  comparableName,
  copyDateOf,
  copyWhenOf,
  councilCopyOf,
  dayFromDateText,
  inferLetterKind,
  inferLetterKinds,
  isInternalForward,
  kindForRecipient,
  readsThrough,
  sideOf,
  sideOfRole,
  writtenByCouncilTo,
  OWN_ADDRESS_MARK,
  OWN_MAILBOX_MARK,
  sameSubject,
  toLineForReader,
} from './council-copy.js';

/**
 * Telling a copy of the Council's own letter from everything else in the intake mailbox.
 *
 * Written after it became clear that a copy of "Documents required - <case>" forwarded to
 * the intake address filed itself as the patient's reply and stopped the reminder for the
 * very documents it asked for. Invented names and addresses throughout.
 */

const own = ownAddressesOf({
  officialEmail: 'registrar@example-council.in',
  website: 'https://www.example-council.in/',
  intakeAccount: 'council.intake@gmail.com',
});

const none = { original_from: null, original_to: null };

describe('addressesIn', () => {
  it('reads a quoted display name with a comma in it as one person', () => {
    expect(addressesIn('"Kumar, Ravi" <ravi@x.com>, s@y.in')).toEqual([
      { email: 'ravi@x.com', name: 'Kumar, Ravi' },
      { email: 's@y.in', name: null },
    ]);
  });

  it('reads angle brackets, bare addresses and semicolons', () => {
    expect(addressesIn('Asha Rao <Asha.Rao@Example.in>; b@example.in')).toEqual([
      { email: 'asha.rao@example.in', name: 'Asha Rao' },
      { email: 'b@example.in', name: null },
    ]);
  });

  it('takes mailto: off, in brackets and bare', () => {
    expect(addressesIn('Asha Rao [mailto:asha@example.in]')).toEqual([
      { email: 'asha@example.in', name: 'Asha Rao' },
    ]);
    expect(addressesIn('<mailto:b@example.in>, mailto:c@example.in')).toEqual([
      { email: 'b@example.in', name: null },
      { email: 'c@example.in', name: null },
    ]);
  });

  it('is empty for nothing, and leaves out a piece with no address in it', () => {
    expect(addressesIn('')).toEqual([]);
    expect(addressesIn(null)).toEqual([]);
    expect(addressesIn('   ')).toEqual([]);
    expect(addressesIn('undisclosed-recipients:;')).toEqual([]);
  });

  it('lists each address once', () => {
    expect(addressesIn('a@x.in, A <A@X.IN>')).toEqual([{ email: 'a@x.in', name: null }]);
  });

  it('does not repeat the address as a name', () => {
    expect(addressesIn('"a@x.in" <a@x.in>')).toEqual([{ email: 'a@x.in', name: null }]);
  });
});

describe('toLineForReader', () => {
  it("marks the intake mailbox, which is not on the Council's domain, as the Council's own", () => {
    expect(toLineForReader('council.intake@gmail.com', own, 'council.intake@gmail.com')).toBe(
      `council.intake@gmail.com ${OWN_MAILBOX_MARK}`,
    );
    expect(toLineForReader('Ravi <ravi@example.com>, Council.Intake@Gmail.com', own, 'council.intake@gmail.com')).toBe(
      `Ravi <ravi@example.com>, council.intake@gmail.com ${OWN_MAILBOX_MARK}`,
    );
  });

  it('marks another own address off the domain, and leaves the domain itself to the playbook', () => {
    const offDomain = ownAddressesOf({ officialEmail: 'ksdc.registrar@yahoo.example', website: 'https://example-council.in' });
    expect(toLineForReader('ksdc.registrar@yahoo.example', offDomain, null)).toBe(
      `ksdc.registrar@yahoo.example ${OWN_ADDRESS_MARK}`,
    );
    // Nothing to mark: the line exactly as the email wrote it.
    expect(toLineForReader('"Kumar, Ravi" <ravi@example.com>, registrar@example-council.in', own, 'council.intake@gmail.com')).toBe(
      '"Kumar, Ravi" <ravi@example.com>, registrar@example-council.in',
    );
    expect(toLineForReader('  ', own, null)).toBeNull();
    expect(toLineForReader(null, own, null)).toBeNull();
  });
});

describe('councilCopyOf', () => {
  it('a forward of our letter: from the Council, to a patient', () => {
    expect(
      councilCopyOf(
        {
          original_from: 'registrar@example-council.in',
          original_to: 'Ravi Kumar <ravi@example.com>',
          envelope_from: 'officer@example-council.in',
          envelope_to: 'council.intake@gmail.com',
        },
        own,
      ),
    ).toEqual({ recipients: [{ email: 'ravi@example.com', name: 'Ravi Kumar' }] });
  });

  it('only the recipients outside the Council count', () => {
    expect(
      councilCopyOf(
        {
          original_from: 'registrar@example-council.in',
          original_to: 'ravi@example.com, president@example-council.in, council.intake@gmail.com',
          envelope_from: 'officer@example-council.in',
          envelope_to: 'council.intake@gmail.com',
        },
        own,
      )?.recipients.map((r) => r.email),
    ).toEqual(['ravi@example.com']);
  });

  it('a letter sent with the intake mailbox in Cc or Bcc', () => {
    expect(
      councilCopyOf(
        {
          ...none,
          envelope_from: 'registrar@example-council.in',
          envelope_to: 'Dr. S. Mehta <s.mehta@clinic.example>',
          subject: 'Explanation called for - KSDC/COMP/2026-27/0042',
        },
        own,
      ),
    ).toEqual({ recipients: [{ email: 's.mehta@clinic.example', name: 'Dr. S. Mehta' }] });
  });

  it('NOT an office forward the unwrapper did not recognise (from the Council, to the intake mailbox)', () => {
    expect(
      councilCopyOf(
        {
          ...none,
          envelope_from: 'registrar@example-council.in',
          envelope_to: 'council.intake@gmail.com',
          subject: 'Fwd: Treatment complaint',
        },
        own,
      ),
    ).toBeNull();
  });

  it('NOT an unrecognised forward even when the mailbox address is not known: its To is where the forward went', () => {
    const noIntake = ownAddressesOf({ officialEmail: 'registrar@example-council.in', website: null });
    expect(
      councilCopyOf(
        {
          ...none,
          envelope_from: 'registrar@example-council.in',
          envelope_to: 'intake@elsewhere.example',
          subject: 'Fwd: Treatment complaint',
        },
        noIntake,
      ),
    ).toBeNull();
  });

  it('NOT a Council-to-Council internal forward', () => {
    expect(
      councilCopyOf(
        {
          original_from: 'registrar@example-council.in',
          original_to: 'support@example-council.in',
          envelope_from: 'support@example-council.in',
          envelope_to: 'council.intake@gmail.com',
        },
        own,
      ),
    ).toBeNull();
  });

  it("NOT a patient's reply that quotes our letter, forwarded or written to us directly", () => {
    expect(
      councilCopyOf(
        {
          original_from: 'ravi@example.com',
          original_to: 'registrar@example-council.in',
          envelope_from: 'officer@example-council.in',
          envelope_to: 'council.intake@gmail.com',
        },
        own,
      ),
    ).toBeNull();
    expect(
      councilCopyOf(
        {
          ...none,
          envelope_from: 'ravi@example.com',
          envelope_to: 'registrar@example-council.in, council.intake@gmail.com',
          subject: 'Re: Documents required - KSDC/COMP/2026-27/0042',
        },
        own,
      ),
    ).toBeNull();
  });

  it("NOT a patient's Outlook reply, whose quoted letter the unwrapper reads as the original", () => {
    // Outlook quotes the letter it answers under a rule of underscores (or "-----Original
    // Message-----") with From/To headers, and the unwrapper reads that block like a
    // forward's. The reply was still sent by the patient - so it is not our copy.
    expect(
      councilCopyOf(
        {
          original_from: 'registrar@example-council.in',
          original_to: 'Ravi Kumar <ravi@example.com>',
          envelope_from: 'ravi@example.com',
          envelope_to: 'council.intake@gmail.com',
          subject: 'RE: Documents required - KSDC/COMP/2026-27/0042',
        },
        own,
      ),
    ).toBeNull();
    // A dentist's explanation, likewise.
    expect(
      councilCopyOf(
        {
          original_from: 'registrar@example-council.in',
          original_to: 'Dr. S. Mehta <s.mehta@clinic.example>',
          envelope_from: 's.mehta@clinic.example',
          envelope_to: 'registrar@example-council.in, council.intake@gmail.com',
        },
        own,
      ),
    ).toBeNull();
  });

  it('a letter of ours that forwards something on - to the dentist, intake in Cc - is our letter', () => {
    // The complaint inside it is the complainant's; the message itself is the Council
    // writing to the dentist. Read by its original, it filed itself as the complaint arriving.
    expect(
      councilCopyOf(
        {
          original_from: 'ravi@example.com',
          original_to: 'registrar@example-council.in',
          envelope_from: 'registrar@example-council.in',
          envelope_to: 'Dr Mehta <mehta@clinic.example>',
          subject: 'Fwd: Complaint against you - KSDC/COMP/2026-27/0042',
        },
        own,
      ),
    ).toEqual({ recipients: [{ email: 'mehta@clinic.example', name: 'Dr Mehta' }] });
    expect(
      writtenByCouncilTo(
        {
          original_from: 'ravi@example.com',
          original_to: null,
          envelope_from: 'registrar@example-council.in',
          envelope_to: 'mehta@clinic.example',
          subject: 'Fwd: Complaint against you',
        },
        own,
      ),
    ).toEqual([{ email: 'mehta@clinic.example', name: null }]);
  });

  it('...but only when the intake mailbox is known: otherwise its To may be the mailbox under another name', () => {
    const noIntake = ownAddressesOf({ officialEmail: 'registrar@example-council.in', website: null });
    expect(noIntake.intakeKnown).toBe(false);
    expect(own.intakeKnown).toBe(true);
    expect(
      councilCopyOf(
        {
          original_from: 'ravi@example.com',
          original_to: 'registrar@example-council.in',
          envelope_from: 'registrar@example-council.in',
          envelope_to: 'intake@elsewhere.example',
          subject: 'Fwd: Treatment complaint',
        },
        noIntake,
      ),
    ).toBeNull();
  });

  it("NOT an office forward of a patient's reply addressed to the intake mailbox AND somebody else", () => {
    // The registrar forwards the patient's reply with the bills to the intake mailbox and to
    // the President. The President on the To line does not make it the Council writing to
    // the President: it is the patient's reply, and must still answer the reminder.
    const forward = {
      original_from: 'ravi@example.com',
      original_to: 'registrar@example-council.in',
      envelope_from: 'registrar@example-council.in',
      subject: 'Fwd: Re: Documents required - KSDC/COMP/2026-27/0042',
    };
    expect(
      councilCopyOf({ ...forward, envelope_to: 'council.intake@gmail.com, President <president.ksdc@gmail.com>' }, own),
    ).toBeNull();
    // Titled as a forward, even when the unwrapper could not open it.
    expect(
      councilCopyOf(
        {
          ...none,
          envelope_from: 'registrar@example-council.in',
          envelope_to: 'council.intake@gmail.com, member.ksdc@gmail.com',
          subject: 'Fwd: Treatment complaint',
        },
        own,
      ),
    ).toBeNull();
  });

  it('NOT an office forward to the intake mailbox under another spelling Gmail delivers to it', () => {
    for (const to of [
      'council.in.take@gmail.com',
      'councilintake@gmail.com',
      'Council Intake <council.intake+office@gmail.com>',
      'council.intake@googlemail.com',
    ]) {
      expect(
        councilCopyOf(
          {
            original_from: 'ravi@example.com',
            original_to: 'registrar@example-council.in',
            envelope_from: 'registrar@example-council.in',
            envelope_to: to,
            subject: 'Fwd: Re: Documents required - KSDC/COMP/2026-27/0042',
          },
          own,
        ),
        to,
      ).toBeNull();
    }
  });

  it('a forward from the Council with the intake mailbox only in Cc is still our letter', () => {
    // The officer forwarding the complaint on to the dentist: nothing of the Council's on To.
    expect(
      councilCopyOf(
        {
          original_from: 'ravi@example.com',
          original_to: 'registrar@example-council.in',
          envelope_from: 'registrar@example-council.in',
          envelope_to: 'Dr Mehta <mehta@clinic.example>, member.ksdc@gmail.com',
          subject: 'Fwd: Complaint against you - KSDC/COMP/2026-27/0042',
        },
        own,
      )?.recipients.map((r) => r.email),
    ).toEqual(['mehta@clinic.example', 'member.ksdc@gmail.com']);
    // And a letter that is not a forward is our letter whoever else is on its To line.
    expect(
      councilCopyOf(
        {
          ...none,
          envelope_from: 'registrar@example-council.in',
          envelope_to: 'Ravi Kumar <ravi@example.com>, council.intake@gmail.com',
          subject: 'Documents required - KSDC/COMP/2026-27/0042',
        },
        own,
      )?.recipients.map((r) => r.email),
    ).toEqual(['ravi@example.com']);
  });

  it('NOT a forward of our letter whose To line was not kept', () => {
    expect(
      councilCopyOf(
        {
          original_from: 'registrar@example-council.in',
          original_to: null,
          envelope_from: 'officer@example-council.in',
          envelope_to: 'council.intake@gmail.com',
        },
        own,
      ),
    ).toBeNull();
  });
});

describe('inferLetterKind', () => {
  const templates = KSDC_TEMPLATES.map((t) => ({ kind: t.kind, subjectTpl: t.subject }));
  const merge = (series: string) => ({
    case: { number: `KSDC/${series}/2026-27/0042` },
    patient: { name: 'A. Patient' },
  });
  // The two hearing notices share a subject word for word, and are different letters to
  // different people: the subject alone names both, and kindForRecipient chooses.
  const HEARING = ['summons_complainant', 'summons_respondent'];

  for (const t of KSDC_TEMPLATES) {
    const series = t.kind.startsWith('ethics_') ? 'ETH' : 'COMP';
    const number = `KSDC/${series}/2026-27/0042`;
    const rendered = renderTemplate(t.subject, merge(series), 'text');
    const subject = subjectWithReference(rendered, number);

    it(`knows "${t.name}" by its subject, bare and with Fwd:/Re: and the reference`, () => {
      for (const s of [
        rendered,
        subject,
        `Fwd: ${subject}`,
        `FW: Fwd: ${subject}`,
        `Re: ${subject}`,
        `RE: Fw: ${rendered}`,
        `${rendered} [${number}]`,
        `  fwd:   ${subject.toUpperCase()}  `,
      ]) {
        const kinds = inferLetterKinds(s, templates);
        if (HEARING.includes(t.kind)) expect(kinds, s).toEqual(HEARING);
        else expect(kinds, s).toEqual([t.kind]);
        expect(inferLetterKind(s, templates), s).toBe(kinds[0]);
      }
    });
  }

  it('tells the explanation sought on a complaint from the one on an ethics case by the series', () => {
    expect(inferLetterKind('Fwd: Explanation called for - KSDC/COMP/2026-27/0042', templates)).toBe(
      'respondent_explanation_sought',
    );
    expect(inferLetterKind('Fwd: Explanation called for - KSDC/ETH/2026-27/0007', templates)).toBe(
      'ethics_explanation',
    );
  });

  it('chooses between the two hearing notices by who the copy went to, or not at all', () => {
    const both = inferLetterKinds('Fwd: Hearing before the Ethical Committee - KSDC/COMP/2026-27/0042', templates);
    expect(both).toEqual(['summons_complainant', 'summons_respondent']);
    expect(kindForRecipient(both, ['respondent_dentist'])).toBe('summons_respondent');
    expect(kindForRecipient(both, ['respondent_establishment'])).toBe('summons_respondent');
    expect(kindForRecipient(both, ['complainant'])).toBe('summons_complainant');
    expect(kindForRecipient(both, ['patient', 'complainant'])).toBe('summons_complainant');
    // Somebody on neither side, or on both: the officer is asked.
    expect(kindForRecipient(both, [])).toBeNull();
    expect(kindForRecipient(both, ['witness'])).toBeNull();
    expect(kindForRecipient(both, ['complainant', 'respondent_dentist'])).toBeNull();
    // One kind needs no choosing.
    expect(kindForRecipient(['request_docs'], [])).toBe('request_docs');
    expect(kindForRecipient([], ['complainant'])).toBeNull();
  });

  it('prefers the more specific template: a reminder is not the letter it reminds about', () => {
    expect(inferLetterKind('Reminder - explanation called for - KSDC/COMP/2026-27/0042', templates)).toBe(
      'respondent_reminder',
    );
    expect(inferLetterKind('Reminder: documents required - KSDC/COMP/2026-27/0042', templates)).toBe(
      'request_docs_reminder',
    );
  });

  it("is null for a patient's own words, even when they quote the number", () => {
    expect(inferLetterKind('Complaint about Dr X', templates)).toBeNull();
    expect(inferLetterKind('Re: my bills KSDC/COMP/2026-27/0042', templates)).toBeNull();
    expect(inferLetterKind('', templates)).toBeNull();
  });

  it('follows a template the officer has reworded, and never says inbound', () => {
    const edited = [
      { kind: 'request_docs' as const, subjectTpl: 'Papers needed for {{case.number}}' },
      { kind: 'inbound' as const, subjectTpl: '{{case.number}}' },
    ];
    expect(inferLetterKind('Fwd: Papers needed for KSDC/COMP/2026-27/0042', edited)).toBe('request_docs');
    expect(inferLetterKind('KSDC/COMP/2026-27/0042', edited)).toBeNull();
  });
});

describe('subjects and dates', () => {
  it('takes stacked prefixes off', () => {
    expect(bareSubject('Fwd: RE:  Fw:Documents   required')).toBe('Documents required');
    expect(sameSubject('Fwd: Documents required [X]', 'documents  required [x]')).toBe(true);
    expect(sameSubject('', '')).toBe(false);
  });

  it('compares names without titles, punctuation, case or spacing', () => {
    expect(comparableName('Dr. P. Shetty')).toBe(comparableName('dr P  Shetty'));
    expect(comparableName('Dr. P. Shetty')).not.toBe(comparableName('Dr. Q. Shetty'));
    expect(comparableName(null)).toBe('');
  });

  it("reads the day an in-body forward's date line names, and only beyond doubt", () => {
    expect(dayFromDateText('Fri, 10 Oct 2026 at 11:30')).toBe('2026-10-10');
    expect(dayFromDateText('Friday, October 3, 2026 11:02 AM')).toBe('2026-10-03');
    expect(dayFromDateText('3rd October 2026 11:02')).toBe('2026-10-03');
    expect(dayFromDateText('2026-09-18 15:15')).toBe('2026-09-18');
    expect(dayFromDateText('Sat, Sep 6, 2026 at 9:15 PM')).toBe('2026-09-06');
    // Day and month in figures read either way round: not read at all.
    expect(dayFromDateText('03/10/2026 11:02')).toBeNull();
    expect(dayFromDateText('31 Feb 2026')).toBeNull();
    expect(dayFromDateText('Market day, 2026')).toBeNull();
    expect(dayFromDateText('')).toBeNull();
    expect(dayFromDateText(null)).toBeNull();
  });

  it("says how far a copy's date can be trusted", () => {
    const envelope = new Date('2026-10-30T05:00:00Z');
    const attached = new Date('2026-10-10T05:00:00Z');
    expect(copyWhenOf({ original_date: attached, envelope_date: envelope, forward_kind: 'rfc822_attachment' })).toEqual({
      date: attached,
      basis: 'exact',
    });
    // Sent with the intake mailbox in Cc: the copy's date is the letter's.
    expect(copyWhenOf({ original_date: null, envelope_date: envelope, forward_kind: 'none' })).toEqual({
      date: envelope,
      basis: 'exact',
    });
    // Forwarded, with a date line that names a day: that day, at midday in Bengaluru.
    expect(
      copyWhenOf({
        original_date: null,
        envelope_date: envelope,
        forward_kind: 'gmail',
        original_date_text: 'Fri, 10 Oct 2026 at 11:30',
      }),
    ).toEqual({ date: new Date('2026-10-10T06:00:00Z'), basis: 'stated_day' });
    // Forwarded, the day unreadable - or after the forward, so misread: only the forward's date.
    for (const text of ['10/10/2026 11:30', 'Mon, 9 Nov 2026 at 10:00', null]) {
      expect(
        copyWhenOf({ original_date: null, envelope_date: envelope, forward_kind: 'gmail', original_date_text: text }),
      ).toEqual({ date: envelope, basis: 'forwarded' });
    }
  });

  it("dates a copy by the original's own date when it kept one, else by the copy", () => {
    const original = new Date('2026-10-10T05:00:00Z');
    const envelope = new Date('2026-10-11T05:00:00Z');
    expect(copyDateOf({ original_date: original, envelope_date: envelope })).toEqual(original);
    expect(copyDateOf({ original_date: null, envelope_date: envelope.toISOString() })).toEqual(envelope);
  });
});

describe('isInternalForward', () => {
  it('is the Council writing only to itself', () => {
    expect(isInternalForward({ fromAddress: 'support@example-council.in', to: 'registrar@example-council.in' }, own)).toBe(
      true,
    );
    expect(isInternalForward({ fromAddress: 'registrar@example-council.in', to: null }, own)).toBe(true);
  });

  it('is never a letter of ours to somebody outside, nor anybody else writing', () => {
    expect(
      isInternalForward({ fromAddress: 'registrar@example-council.in', to: 'Ravi <ravi@example.com>' }, own),
    ).toBe(false);
    expect(isInternalForward({ fromAddress: 'ravi@example.com', to: 'registrar@example-council.in' }, own)).toBe(false);
  });
});

describe('readsThrough', () => {
  const patient = { fromAddress: 'kdevi@example.in' };
  const grievanceCell = {
    fromAddress: 'grievance@health.example.gov.in',
    to: 'registrar@example-council.in',
    subject: 'Fwd: Complaint against Dr. Rao',
  };

  it('reads through the Council passing mail to itself', () => {
    expect(
      readsThrough({ fromAddress: 'support@example-council.in', to: 'registrar@example-council.in', subject: 'Complaint' }, patient, own),
    ).toBe(true);
  });

  it("reads through an outside body's forward of somebody else's complaint", () => {
    expect(readsThrough(grievanceCell, patient, own)).toBe(true);
    expect(readsThrough({ ...grievanceCell, subject: 'FW: complaint' }, patient, own)).toBe(true);
  });

  it("never reads through a reply, the forwarder's own mail, our letter, or our letter to an outsider", () => {
    // A patient's Outlook reply quotes our letter below their words: the patient wrote it.
    expect(readsThrough({ ...grievanceCell, subject: 'RE: Documents required' }, { fromAddress: 'registrar@example-council.in' }, own)).toBe(false);
    expect(readsThrough({ ...grievanceCell, subject: 'Complaint against Dr. Rao' }, patient, own)).toBe(false);
    // A dentist forwarding our notice back, their explanation on top: the dentist's.
    expect(readsThrough({ ...grievanceCell, fromAddress: 'dr@clinic.example' }, { fromAddress: 'registrar@example-council.in' }, own)).toBe(false);
    // Somebody forwarding their own earlier mail: their covering note is theirs too.
    expect(readsThrough({ ...grievanceCell, fromAddress: 'kdevi@example.in' }, patient, own)).toBe(false);
    // The Council's letter to an outsider is a copy, never read through.
    expect(
      readsThrough({ fromAddress: 'registrar@example-council.in', to: 'ravi@example.com', subject: 'Fwd: x' }, patient, own),
    ).toBe(false);
  });
});

describe('sideOf and sideOfRole', () => {
  it('reads every letter to a dentist as written to a respondent, whatever it was stored as', () => {
    expect(sideOf('summons_respondent')).toBe('respondent');
    expect(sideOf('order_to_respondent')).toBe('respondent');
    expect(sideOf('ethics_explanation')).toBe('respondent');
    expect(sideOf('summons_complainant')).toBe('complainant');
    expect(sideOf('request_docs')).toBeNull();
    expect(sideOfRole('patient')).toBe('complainant');
    expect(sideOfRole('respondent_dentist')).toBe('respondent');
    expect(sideOfRole('witness')).toBeNull();
  });
});

describe('copyWhenOf, for a letter that is the message itself', () => {
  it('is the message date, not the date of anything it forwards', () => {
    const m = {
      original_date: null,
      envelope_date: new Date('2026-10-11T04:30:00Z'),
      original_date_text: 'Sat, 20 Sep 2026 at 09:00',
      forward_kind: 'gmail',
    };
    expect(copyWhenOf(m).basis).toBe('stated_day');
    expect(copyWhenOf(m, true)).toEqual({ date: new Date('2026-10-11T04:30:00Z'), basis: 'exact' });
  });
});
