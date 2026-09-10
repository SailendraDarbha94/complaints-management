import { describe, expect, it } from 'vitest';
import { fieldsFor, renderTemplate, validateTemplate, BLANK } from '@ksdc/contracts';
import { KSDC_TEMPLATES } from './templates.js';
import { KSDC_CONFIG, KSDC_COUNCIL } from './ksdc.seed.js';

describe('the shipped templates', () => {
  it.each(KSDC_TEMPLATES.map((t) => [t.kind, t] as const))(
    '%s only references fields its letter can have',
    (kind, template) => {
      // A letter offering a field it cannot fill is how __________ ends up on something
      // the Registrar has already signed.
      const bodyCheck = validateTemplate(template.body, fieldsFor(kind));
      expect(bodyCheck.unknownFields, `${kind} body`).toEqual([]);
      expect(bodyCheck.unclosedConditionals, `${kind} body`).toBe(0);

      const subjectCheck = validateTemplate(template.subject, fieldsFor(kind));
      expect(subjectCheck.unknownFields, `${kind} subject`).toEqual([]);
    },
  );

  it('quotes the complaint number on every outgoing letter', () => {
    // Requirement 9: the reference line under the subject. In Phase 1 that token is also
    // the only thread key a copy-paste send preserves, so it is not optional.
    for (const t of KSDC_TEMPLATES) {
      expect(t.body, t.kind).toContain('{{case.number}}');
    }
  });

  it('has exactly one template per kind', () => {
    const kinds = KSDC_TEMPLATES.map((t) => t.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('requires a wet signature only for the GDCRI referral', () => {
    // Requirement 12: the GDC letters are the only ones printed, signed, sealed and
    // scanned back. Everything else goes by email from the officer.
    const signed = KSDC_TEMPLATES.filter((t) => t.requiresRegistrarSignature).map((t) => t.kind);
    expect(signed.sort()).toEqual(['expert_referral_copy_to_patient', 'expert_referral_letter']);
  });

  it('flags the referral as a system template, because its questions are the terms of reference', () => {
    const referral = KSDC_TEMPLATES.find((t) => t.kind === 'expert_referral_letter')!;
    expect(referral.isSystem).toBe(true);
  });
});

describe('the GDCRI referral, against the letter it was transcribed from', () => {
  const referral = KSDC_TEMPLATES.find((t) => t.kind === 'expert_referral_letter')!;

  const ctx = {
    council: {
      name: KSDC_COUNCIL.name,
      registrarName: KSDC_COUNCIL.registrarName,
      registrarTitle: KSDC_COUNCIL.registrarTitle,
    },
    case: { number: 'KSDC/COMP/2026-27/0042' },
    patient: { name: 'Purushottam', mobile: '96628 78536' },
    expert: {
      addresseeTitle: `${KSDC_CONFIG.expertBody.addresseeTitle}, ${KSDC_CONFIG.expertBody.name}`,
      addressLines: KSDC_CONFIG.expertBody.addressLines,
      questions: KSDC_CONFIG.expertBody.referralQuestions.map((q, i) => `${i + 1}. ${q}`),
    },
    letter: { date: '13 August 2026', despatchRef: 'KSDC/297/2026-27' },
  };

  it('reproduces the subject line', () => {
    expect(renderTemplate(referral.subject, ctx)).toBe(
      'Appointment of an Expert in the case of patient named Purushottam',
    );
  });

  it('carries the patient name, mobile and both questions', () => {
    const letter = renderTemplate(referral.body, ctx);
    expect(letter).toContain('patient named Purushottam');
    expect(letter).toContain('Mobile No. 96628 78536');
    expect(letter).toContain('1. Whether Medical Negligence has occurred in this regard');
    expect(letter).toContain('2. Were the standard ethical guidelines followed in this case');
    expect(letter).toContain('The relevant files in this case are attached herewith.');
    expect(letter).toContain('R Venugopal');
    expect(letter).toContain('Registrar');
  });

  it('leaves no blanks when the context is complete', () => {
    expect(renderTemplate(referral.body, ctx)).not.toContain(BLANK);
  });

  it('shows a visible blank when the patient mobile is missing', () => {
    // The number is handwritten on the scanned original, so it can genuinely be absent.
    // Better an obvious gap than a letter that reads as finished without it.
    const letter = renderTemplate(referral.body, {
      ...ctx,
      patient: { name: 'Purushottam', mobile: '' },
    });
    expect(letter).toContain(`Mobile No. ${BLANK}`);
  });
});

describe('the document request, against what the officer sends today', () => {
  const request = KSDC_TEMPLATES.find((t) => t.kind === 'request_docs')!;

  it('asks for each of the six things the officer listed', () => {
    const body = request.body.toLowerCase();
    expect(body).toContain('bills');
    expect(body).toContain('prescriptions');
    expect(body).toContain('timeline');
    expect(body).toContain('summary');
    expect(body).toContain('registration number');
    expect(body).toMatch(/opg|radiograph/);
  });

  it('gives a deadline and says what happens if it passes', () => {
    expect(request.body).toContain('{{deadline.date}}');
    expect(request.body).toMatch(/closed for want of particulars/i);
  });

  it('carries the data-protection line', () => {
    // The DPDP notice the build plan asks for at intake, in the acknowledgement.
    const ack = KSDC_TEMPLATES.find((t) => t.kind === 'ack_complaint')!;
    expect(ack.body).toMatch(/held by the Council for the purpose/i);
  });
});

describe('the respondent letters', () => {
  it('says no finding has been reached', () => {
    // The first thing a dentist wants to know on opening it. Saying so is both fair and
    // the difference between an enquiry and an accusation.
    const notice = KSDC_TEMPLATES.find((t) => t.kind === 'respondent_explanation_sought')!;
    expect(notice.body).toMatch(/No finding has been reached/i);
  });

  it('warns about ex parte only in the final notice', () => {
    const final = KSDC_TEMPLATES.find((t) => t.kind === 'respondent_final_notice')!;
    const first = KSDC_TEMPLATES.find((t) => t.kind === 'respondent_explanation_sought')!;
    expect(final.body).toMatch(/ex parte/i);
    expect(first.body).not.toMatch(/ex parte/i);
  });

  it('drops the registration number cleanly when it is not known', () => {
    const notice = KSDC_TEMPLATES.find((t) => t.kind === 'respondent_explanation_sought')!;
    const rendered = renderTemplate(notice.body, {
      council: { name: 'KSDC', registrarName: 'R V', registrarTitle: 'Registrar' },
      case: { number: 'KSDC/COMP/2026-27/0001' },
      complainant: { name: 'Smt. K. Devi' },
      patient: { name: 'Smt. K. Devi' },
      respondent: { name: 'Dr A. Rao', registrationNo: '', addressLines: ['Bengaluru'] },
      deadline: { days: 7, date: '18 September 2026' },
    });
    expect(rendered).not.toContain('Registration No.');
    expect(rendered).not.toContain(BLANK);
  });
});
