import { describe, expect, it } from 'vitest';
import { FOLLOWUP_STAGES } from '@ksdc/contracts';
import { councilConfigSchema, followupRuleFor } from './council-config.js';
import { KSDC_CONFIG } from './ksdc.seed.js';

describe('the KSDC seed', () => {
  it('validates against the config schema', () => {
    expect(() => councilConfigSchema.parse(KSDC_CONFIG)).not.toThrow();
  });

  it('has a rule for every follow-up stage — a stage with no rule cannot be scheduled', () => {
    for (const stage of FOLLOWUP_STAGES) {
      expect(() => followupRuleFor(KSDC_CONFIG, stage), stage).not.toThrow();
    }
  });

  it('ships AI disabled', () => {
    expect(KSDC_CONFIG.aiEnabled).toBe(false);
  });

  it('never lets the software mint an outward despatch number', () => {
    expect(KSDC_CONFIG.numbering.despatchNumberIsExternal).toBe(true);
  });

  it('stops the respondent ladder at a proposal, never at an automatic finding', () => {
    const rule = followupRuleFor(KSDC_CONFIG, 'await_respondent_explanation');
    // First notice + maxEscalations = the configured notice count.
    expect(1 + rule.maxEscalations).toBe(KSDC_CONFIG.respondents.noticesBeforeExParte);
    expect(rule.terminalAction).toBe('propose_ex_parte');
  });

  it('carries the two GDCRI questions verbatim from the scanned letter', () => {
    expect(KSDC_CONFIG.expertBody.referralQuestions).toHaveLength(2);
    expect(KSDC_CONFIG.expertBody.referralQuestions[0]).toMatch(/Negligence/i);
    expect(KSDC_CONFIG.expertBody.referralQuestions[1]).toMatch(/ethical guidelines/i);
  });

  it('sends the digest at 09:00 Asia/Kolkata', () => {
    expect(KSDC_CONFIG.calendar.digestHourLocal).toBe(9);
    expect(KSDC_CONFIG.calendar.timezone).toBe('Asia/Kolkata');
  });
});
