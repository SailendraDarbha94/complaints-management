import { describe, expect, it } from 'vitest';
import { CASE_EVENTS, TRANSITIONS } from '@ksdc/contracts';
import { CANCEL_EVENT, MAIL_PROVIDER_NAME, RESTORE_EVENT } from '@ksdc/core';
import { EVENT_LABEL, UNCONFIRMED_SENDER_TEXT } from './labels';

/**
 * The history events that are not transitions.
 *
 * Cancelling a case and restoring it write to case_state_history under keys that live in
 * @ksdc/core, and the case page's chronology prints them through EVENT_LABEL. labels.ts
 * cannot import those keys - it reaches the browser, and @ksdc/core would bring the
 * database driver with it - so it spells them out, and this is what stops the two
 * spellings drifting apart. If it fails, the chronology is printing a raw key such as
 * CANCEL_OPENED_IN_ERROR into the record the officer reads.
 */
describe('EVENT_LABEL', () => {
  it('names the cancellation and the restore in words', () => {
    for (const event of [CANCEL_EVENT, RESTORE_EVENT]) {
      expect(EVENT_LABEL[event]).toBeDefined();
      expect(EVENT_LABEL[event]).not.toBe(event);
    }
  });

  /**
   * Every event the history can hold, not only the ones a button offers. The chronology
   * printed ALL_RESPONDENTS_RESOLVED raw because it is written by the system and nobody
   * presses it, so nobody had noticed it had no words. Walking the transition table means
   * an event added to @ksdc/contracts fails here before it reaches the officer's record.
   */
  it('has words for every event in the transition table, and for cancel and restore', () => {
    const events = [...new Set([...TRANSITIONS.map((t) => t.event), ...CASE_EVENTS])];
    expect(events.length, 'a broken import would make this vacuous').toBeGreaterThan(15);
    const missing = [...events, CANCEL_EVENT, RESTORE_EVENT].filter(
      (event) => !EVENT_LABEL[event]?.trim() || EVENT_LABEL[event] === event,
    );
    expect(missing).toEqual([]);
  });
});

/**
 * The line the message page shows for an unconfirmed sender names the mail provider, like
 * the note the register writes on the message itself. If the intake mailbox moves and core
 * names another provider, this says so here too.
 */
describe('UNCONFIRMED_SENDER_TEXT', () => {
  it('names the same mail provider as the register does', () => {
    expect(UNCONFIRMED_SENDER_TEXT.startsWith(`${MAIL_PROVIDER_NAME} could not confirm`)).toBe(true);
  });
});
