import { describe, expect, it } from 'vitest';
import {
  BLANK,
  extractTokens,
  fieldsFor,
  renderTemplate,
  validateTemplate,
} from './template.js';
import { CORRESPONDENCE_KINDS } from './enums.js';

describe('rendering', () => {
  const ctx = {
    council: { name: 'Karnataka State Dental Council', registrarName: 'R Venugopal' },
    case: { number: 'KSDC/COMP/2026-27/0042' },
    complainant: { name: 'Smt. K. Devi', mobile: '9845012345' },
    respondent: { name: 'Dr A. Rao', registrationNo: '' },
    deadline: { days: 7, date: '18 September 2026' },
  };

  it('substitutes fields', () => {
    expect(renderTemplate('Ref: Complaint No. {{case.number}}', ctx)).toBe(
      'Ref: Complaint No. KSDC/COMP/2026-27/0042',
    );
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('{{ case.number }}', ctx)).toBe('KSDC/COMP/2026-27/0042');
  });

  it('renders a missing value as a visible blank, never as nothing', () => {
    // A letter that silently drops its deadline reads as finished and is not. One with
    // __________ where the date belongs is obviously unfinished, and gets caught before
    // the Registrar signs it.
    expect(renderTemplate('Reply by {{deadline.missing}}.', ctx)).toBe(`Reply by ${BLANK}.`);
    expect(renderTemplate('{{nothing.at.all}}', ctx)).toBe(BLANK);
  });

  it('includes a conditional branch when the field has a value', () => {
    const body = '{{respondent.name}}{{#if respondent.clinic}}, {{respondent.clinic}}{{/if}}';
    expect(renderTemplate(body, { ...ctx, respondent: { ...ctx.respondent, clinic: 'Smile Dental' } }))
      .toBe('Dr A. Rao, Smile Dental');
  });

  it('drops a conditional branch entirely when the field is empty', () => {
    // Crucially the fields inside are not evaluated either, so an absent registration
    // number leaves no BLANK behind in text that was meant to disappear.
    const body = 'Dr Rao{{#if respondent.registrationNo}} (Reg. No. {{respondent.registrationNo}}){{/if}}';
    expect(renderTemplate(body, ctx)).toBe('Dr Rao');
    expect(renderTemplate(body, ctx)).not.toContain(BLANK);
  });

  it('treats whitespace, empty arrays and false as absent', () => {
    const body = '{{#if x}}yes{{/if}}';
    for (const x of ['', '   ', [], false, null, undefined]) {
      expect(renderTemplate(body, { x }), String(x)).toBe('');
    }
    for (const x of ['a', ['a'], true, 0]) {
      expect(renderTemplate(body, { x }), String(x)).toBe('yes');
    }
  });

  it('joins an address block onto separate lines', () => {
    const rendered = renderTemplate('{{council.addressLines}}', {
      council: { addressLines: ['No. 143, 5th Main Road', 'Chamarajpet', 'Bengaluru - 560 018'] },
    });
    expect(rendered.split('\n')).toHaveLength(3);
  });

  it('escapes for HTML but leaves plain text alone', () => {
    const value = { complainant: { name: 'Smith & Sons <clinic>' } };
    expect(renderTemplate('{{complainant.name}}', value, 'text')).toBe('Smith & Sons <clinic>');
    expect(renderTemplate('{{complainant.name}}', value, 'html')).toBe(
      'Smith &amp; Sons &lt;clinic&gt;',
    );
  });

  it('does not re-render a value that itself looks like a token', () => {
    // A complainant could name their clinic "{{council.registrarName}}". The output must
    // be that string, not the Registrar's name.
    const rendered = renderTemplate('{{complainant.name}}', {
      complainant: { name: '{{council.registrarName}}' },
      council: { registrarName: 'R Venugopal' },
    });
    expect(rendered).toBe('{{council.registrarName}}');
    expect(rendered).not.toContain('Venugopal');
  });

  it('ignores anything that is not a plain field or conditional', () => {
    // No helpers, no expressions, no calls: the grammar is two constructs and that is all.
    const body = '{{#each items}}x{{/each}} {{ foo() }} {{a-b}}';
    expect(renderTemplate(body, {})).toBe(body);
  });
});

describe('validation', () => {
  it('finds every field a template uses, inside conditionals too', () => {
    const body = 'Dear {{complainant.name}}{{#if patient.name}}, patient {{patient.name}}{{/if}}';
    expect(extractTokens(body)).toEqual(['complainant.name', 'patient.name']);
  });

  it('rejects a field the letter cannot have', () => {
    // A document request has no decision to quote. Better to say so while it is being
    // written than to leave a blank on a signed letter.
    const result = validateTemplate('{{decision.operativeText}}', fieldsFor('request_docs'));
    expect(result.ok).toBe(false);
    expect(result.unknownFields).toEqual(['decision.operativeText']);
  });

  it('accepts a template that only uses permitted fields', () => {
    const body = 'Ref: {{case.number}}\n\nDear {{complainant.name}}, reply by {{deadline.date}}.';
    expect(validateTemplate(body, fieldsFor('request_docs')).ok).toBe(true);
  });

  it('reports an unclosed conditional', () => {
    const result = validateTemplate('{{#if patient.name}}x', fieldsFor('request_docs'));
    expect(result.ok).toBe(false);
    expect(result.unclosedConditionals).toBe(1);
  });
});

describe('the field vocabulary', () => {
  it('covers every correspondence kind', () => {
    for (const kind of CORRESPONDENCE_KINDS) {
      expect(fieldsFor(kind).length, kind).toBeGreaterThan(0);
    }
  });

  it('offers the case number and the council everywhere', () => {
    // Every outgoing letter carries the complaint number on its reference line.
    for (const kind of CORRESPONDENCE_KINDS) {
      expect(fieldsFor(kind), kind).toContain('case.number');
      expect(fieldsFor(kind), kind).toContain('council.registrarName');
    }
  });

  it('does not offer a sitting date to a document request', () => {
    expect(fieldsFor('request_docs')).not.toContain('sitting.date');
    expect(fieldsFor('summons_complainant')).toContain('sitting.date');
  });

  it('offers the expert questions only on the referral letters', () => {
    expect(fieldsFor('expert_referral_letter')).toContain('expert.questions');
    expect(fieldsFor('request_docs')).not.toContain('expert.questions');
  });
});
