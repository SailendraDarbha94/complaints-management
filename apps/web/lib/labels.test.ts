import { describe, expect, it } from 'vitest';
import { CANCEL_EVENT, RESTORE_EVENT } from '@ksdc/core';
import { EVENT_LABEL } from './labels';

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
});
