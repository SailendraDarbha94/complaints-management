import { describe, expect, it } from 'vitest';
import { CASE_STATES, type CaseState } from './enums.js';
import {
  CASE_EVENTS,
  OPEN_STATES,
  TRANSITIONS,
  WAITING_ON_BY_STATE,
  availableEvents,
  eventsInPhase,
  isTransitionAllowed,
  resolveTarget,
  transitionFor,
  waitingOnFor,
} from './case-lifecycle.js';
import {
  CASE_NUMBER_RE,
  fiscalYearOf,
  formatCaseNumber,
  parseCaseNumber,
  subjectWithReference,
} from './case-number.js';

describe('the transition table', () => {
  it('declares exactly 17 events in Phase 1', () => {
    // docs/00-build-plan.md §4. If this number changes, the plan changed with it.
    expect(new Set(eventsInPhase(1)).size).toBe(17);
  });

  it('has one rule per declared event, and no orphan events', () => {
    const declared = new Set(CASE_EVENTS);
    const ruled = new Set(TRANSITIONS.map((t) => t.event));
    expect(ruled).toEqual(declared);
    expect(TRANSITIONS.length).toBe(CASE_EVENTS.length);
  });

  // One test per row — the plan's requirement.
  it.each(TRANSITIONS.map((t) => [t.event, t] as const))(
    'rule %s is internally consistent',
    (_event, rule) => {
      if (rule.from === 'CREATE') {
        expect(rule.to).not.toBe('SAME');
      } else {
        expect(rule.from.length).toBeGreaterThan(0);
        for (const s of rule.from) expect(CASE_STATES).toContain(s);
      }
      if (rule.to !== 'SAME') expect(CASE_STATES).toContain(rule.to);
      // Respondent- and hold-scoped events must not move the case state.
      if (rule.scope !== 'case') expect(rule.to).toBe('SAME');
      expect(rule.description.length).toBeGreaterThan(20);
    },
  );

  it('reaches every state except awaiting_expert_report within Phase 1', () => {
    const reachable = new Set<CaseState>();
    for (const t of TRANSITIONS) {
      if (t.phase > 1 || t.to === 'SAME') continue;
      reachable.add(t.to);
    }
    const unreachable = CASE_STATES.filter((s) => !reachable.has(s));
    // Deliberate: the expert referral flow arrives in Phase 3, but the enum and the
    // generated waiting_on expression ship complete so that is a code change, not a
    // migration against a legal register. See enums.ts.
    expect(unreachable).toEqual(['awaiting_expert_report']);
  });

  it('reaches every state once Phase 3 is enabled', () => {
    const reachable = new Set<CaseState>();
    for (const t of TRANSITIONS) if (t.to !== 'SAME') reachable.add(t.to);
    for (const s of CASE_STATES) expect(reachable).toContain(s);
  });

  it('lets every open state reach closed', () => {
    for (const s of OPEN_STATES) {
      const closers = availableEvents(s).filter((t) => t.to === 'closed');
      expect(closers.length, `${s} has no route to closed`).toBeGreaterThan(0);
    }
  });

  it('allows a closed case to be reopened, and nothing else', () => {
    const events = availableEvents('closed').map((t) => t.event);
    expect(events).toEqual(['REOPEN']);
  });

  it('requires a reason for every adverse or terminal transition', () => {
    for (const event of ['CLOSE', 'REOPEN', 'DECLARE_RESPONDENT_EX_PARTE', 'DROP_RESPONDENT'] as const) {
      expect(transitionFor(event).requiresReason, event).toBe(true);
    }
  });

  it('never offers system events as buttons', () => {
    for (const s of CASE_STATES) {
      expect(availableEvents(s).some((t) => t.system)).toBe(false);
    }
    expect(
      availableEvents('awaiting_respondent_reply', { includeSystem: true }).some((t) => t.system),
    ).toBe(true);
  });

  it('hides Phase 3 events from a Phase 1 council', () => {
    expect(isTransitionAllowed('ready_for_committee', 'REFER_TO_EXPERT')).toBe(false);
    expect(isTransitionAllowed('ready_for_committee', 'REFER_TO_EXPERT', { phase: 3 })).toBe(true);
  });

  it('keeps the case state still for respondent- and hold-scoped events', () => {
    expect(resolveTarget(transitionFor('RECORD_RESPONDENT_REPLY'), 'awaiting_respondent_reply')).toBe(
      'awaiting_respondent_reply',
    );
    expect(resolveTarget(transitionFor('PUT_ON_HOLD'), 'under_scrutiny')).toBe('under_scrutiny');
  });

  it('rejects an event from the wrong state', () => {
    expect(isTransitionAllowed('intake_received', 'DESPATCH_ORDER')).toBe(false);
    expect(isTransitionAllowed('awaiting_order_despatch', 'DESPATCH_ORDER')).toBe(true);
  });
});

describe('waiting_on', () => {
  it('maps every state, exhaustively', () => {
    for (const s of CASE_STATES) expect(WAITING_ON_BY_STATE[s]).toBeDefined();
    expect(Object.keys(WAITING_ON_BY_STATE).sort()).toEqual([...CASE_STATES].sort());
  });

  it('parks a closed case against nobody, and every open case against someone', () => {
    expect(waitingOnFor('closed')).toBe('nobody');
    for (const s of OPEN_STATES) expect(waitingOnFor(s)).not.toBe('nobody');
  });

  it('answers the four dashboard questions', () => {
    expect(waitingOnFor('awaiting_complainant_documents')).toBe('complainant');
    expect(waitingOnFor('awaiting_respondent_reply')).toBe('respondent');
    expect(waitingOnFor('awaiting_expert_report')).toBe('expert_body');
    expect(waitingOnFor('under_scrutiny')).toBe('council_officer');
  });
});

describe('the case number', () => {
  it('round-trips through a subject line — the only thread key a copy-paste send preserves', () => {
    const n = formatCaseNumber('KSDC', 'COMP', '2026-27', 42);
    expect(n).toBe('KSDC/COMP/2026-27/0042');

    const subject = subjectWithReference('Re: your complaint against Dr A. Rao', n);
    const parsed = parseCaseNumber(subject);

    expect(parsed).not.toBeNull();
    expect(parsed!.raw).toBe(n);
    expect(parsed!.councilCode).toBe('KSDC');
    expect(parsed!.series).toBe('COMP');
    expect(parsed!.fiscalYear).toBe('2026-27');
    expect(parsed!.serial).toBe(42);
  });

  it('does not double-stamp a subject that already carries a reference', () => {
    const n = formatCaseNumber('KSDC', 'COMP', '2026-27', 7);
    const once = subjectWithReference('Explanation sought', n);
    expect(subjectWithReference(once, n)).toBe(once);
  });

  it('finds the reference in a real-looking reply subject', () => {
    const s = 'RE: RE: Fwd: Explanation sought [KSDC/COMP/2026-27/0011] - Dr Kamath';
    expect(parseCaseNumber(s)?.serial).toBe(11);
  });

  it('uses the Indian financial year, turning over on 1 April', () => {
    expect(fiscalYearOf(new Date(Date.UTC(2026, 8, 10)))).toBe('2026-27'); // 10 Sep 2026
    expect(fiscalYearOf(new Date(Date.UTC(2027, 2, 31)))).toBe('2026-27'); // 31 Mar 2027
    expect(fiscalYearOf(new Date(Date.UTC(2027, 3, 1)))).toBe('2027-28'); // 1 Apr 2027
    expect(fiscalYearOf(new Date(Date.UTC(2026, 0, 15)))).toBe('2025-26'); // 15 Jan 2026
  });

  it('separates the three series', () => {
    expect(formatCaseNumber('KSDC', 'ETH', '2026-27', 7)).toBe('KSDC/ETH/2026-27/0007');
    expect(formatCaseNumber('KSDC', 'RTI', '2026-27', 3)).toBe('KSDC/RTI/2026-27/0003');
  });

  it('rejects a malformed fiscal year or serial rather than writing a bad number', () => {
    expect(() => formatCaseNumber('KSDC', 'COMP', '2026', 1)).toThrow();
    expect(() => formatCaseNumber('KSDC', 'COMP', '2026-27', 0)).toThrow();
  });

  it('does not match the office-wide despatch number', () => {
    // KSDC/297/2026-27 is the outward despatch register — a different book, and the
    // software never generates it. It must never be mistaken for a case reference.
    expect(CASE_NUMBER_RE.test('KSDC/297/2026-27')).toBe(false);
    expect(parseCaseNumber('Ref. No. KSDC/297/2026-27')).toBeNull();
  });
});
