import { z } from 'zod';
import {
  CASE_STATES,
  type CaseState,
  type FollowupStage,
  type Milestone,
  type WaitingOn,
} from './enums.js';

/**
 * The case lifecycle, as data.
 *
 * One array. One test per row. One `availableEvents()` that drives every button on
 * web and (later) mobile, so no UI re-implements a guard and no screen can offer an
 * action the service will reject.
 */

export const CASE_EVENTS = [
  'LOG_INTAKE',
  'REQUEST_DOCUMENTS',
  'MARK_COMPLETE_ON_ARRIVAL',
  'DOCUMENTS_RECEIVED',
  'ISSUE_RESPONDENT_NOTICE',
  'RECORD_RESPONDENT_REPLY',
  'DECLARE_RESPONDENT_EX_PARTE',
  'DROP_RESPONDENT',
  'ALL_RESPONDENTS_RESOLVED',
  'RECORD_DECISION',
  'DESPATCH_ORDER',
  'REPORT_SETTLEMENT',
  'MARK_COMPLAINANT_UNRESPONSIVE',
  'PUT_ON_HOLD',
  'RESUME',
  'CLOSE',
  'REOPEN',
  // Phase 3 — the expert referral flow. Declared here so the transition table is the
  // single source of truth; gated out of Phase 1 by `phase`, not by being missing.
  'REFER_TO_EXPERT',
  'RECORD_EXPERT_REPORT',
] as const;
export const caseEventSchema = z.enum(CASE_EVENTS);
export type CaseEvent = (typeof CASE_EVENTS)[number];

export type BuildPhase = 1 | 2 | 3 | 4 | 5 | 6;

/** Every state except `closed`. */
export const OPEN_STATES = CASE_STATES.filter((s) => s !== 'closed') as readonly CaseState[];

/**
 * `SAME` means the case state does not change. Used by respondent-scoped events (the
 * respondent's own status moves, the case waits on the remaining respondents) and by
 * the on-hold toggle.
 */
export type TransitionTarget = CaseState | 'SAME';

export type TransitionScope = 'case' | 'respondent' | 'hold';

export interface TransitionRule {
  readonly event: CaseEvent;
  /** `'CREATE'` means the case does not exist yet. */
  readonly from: readonly CaseState[] | 'CREATE';
  readonly to: TransitionTarget;
  readonly scope: TransitionScope;
  readonly phase: BuildPhase;
  /** Raised by the engine, not offered to a person. */
  readonly system?: boolean;
  readonly requiresReason?: boolean;
  /** Milestones written, in order, inside the same transaction as the transition. */
  readonly milestones?: readonly Milestone[];
  /** Follow-up stages opened by this transition. */
  readonly opens?: readonly FollowupStage[];
  /** Follow-up stages superseded (not satisfied — superseded) by this transition. */
  readonly supersedes?: readonly FollowupStage[];
  readonly description: string;
}

export const TRANSITIONS: readonly TransitionRule[] = [
  {
    event: 'LOG_INTAKE',
    from: 'CREATE',
    to: 'intake_received',
    scope: 'case',
    phase: 1,
    milestones: ['received'],
    opens: ['ad_hoc'],
    description:
      'A complaint arrives. `received` is stamped from the email timestamp or the physical ' +
      'stamp — never from when it was typed in.',
  },
  {
    event: 'REQUEST_DOCUMENTS',
    from: ['intake_received'],
    to: 'awaiting_complainant_documents',
    scope: 'case',
    phase: 1,
    milestones: ['acknowledged', 'documents_requested'],
    opens: ['await_patient_docs'],
    supersedes: ['ad_hoc', 'no_next_step'],
    description:
      'The step-2 letter: bills, prescriptions, a timeline, a summary and the dentist’s ' +
      'details. The clock starts when the officer confirms it was sent, not when it was drafted.',
  },
  {
    event: 'MARK_COMPLETE_ON_ARRIVAL',
    from: ['intake_received'],
    to: 'under_scrutiny',
    scope: 'case',
    phase: 1,
    milestones: ['acknowledged', 'documents_complete'],
    supersedes: ['ad_hoc', 'no_next_step'],
    description: 'The rare complaint that arrives complete. Skips the document request.',
  },
  {
    event: 'DOCUMENTS_RECEIVED',
    from: ['awaiting_complainant_documents'],
    to: 'under_scrutiny',
    scope: 'case',
    phase: 1,
    milestones: ['documents_complete'],
    supersedes: ['await_patient_docs', 'propose_closure'],
    description:
      'Every downstream deadline runs from `documents_complete`, not from receipt — the council ' +
      'cannot be held to a clock that started while it was still waiting for bills.',
  },
  {
    event: 'ISSUE_RESPONDENT_NOTICE',
    // Also allowed from `awaiting_respondent_reply`, and that is not a convenience: it is
    // how reminders 2 and 3 go to the same dentist, and how a first notice reaches a
    // co-respondent named later on a chain-clinic complaint. Restricting it to
    // `under_scrutiny` would make the three-notice ladder unreachable.
    from: ['under_scrutiny', 'awaiting_respondent_reply'],
    to: 'awaiting_respondent_reply',
    scope: 'case',
    phase: 1,
    milestones: ['respondent_notice_despatched'],
    opens: ['await_respondent_explanation'],
    supersedes: ['no_next_step'],
    description:
      'A notice to one respondent. Increments that respondent’s notice count — but only ' +
      'because the officer confirmed a dispatch. A timer never does this.',
  },
  {
    event: 'RECORD_RESPONDENT_REPLY',
    from: ['awaiting_respondent_reply'],
    to: 'SAME',
    scope: 'respondent',
    phase: 1,
    milestones: ['respondent_reply_received'],
    description:
      'One respondent has replied. The case keeps waiting on the others; the engine raises ' +
      'ALL_RESPONDENTS_RESOLVED when the last one is settled.',
  },
  {
    event: 'DECLARE_RESPONDENT_EX_PARTE',
    from: ['awaiting_respondent_reply'],
    to: 'SAME',
    scope: 'respondent',
    phase: 1,
    requiresReason: true,
    milestones: ['respondent_declared_ex_parte'],
    supersedes: ['propose_ex_parte'],
    description:
      'An officer decision, never an automatic one. Eligibility is computed from dispatched ' +
      'notices with proof of service, never from a reminder counter.',
  },
  {
    event: 'DROP_RESPONDENT',
    from: ['awaiting_respondent_reply'],
    to: 'SAME',
    scope: 'respondent',
    phase: 1,
    requiresReason: true,
    description:
      'Named in error, not a registered dentist, or no longer a respondent. Recorded, not deleted.',
  },
  {
    event: 'ALL_RESPONDENTS_RESOLVED',
    from: ['awaiting_respondent_reply'],
    to: 'ready_for_committee',
    scope: 'case',
    phase: 1,
    system: true,
    supersedes: ['await_respondent_explanation', 'propose_ex_parte'],
    description:
      'Raised by the engine when every respondent has replied, gone ex parte, or been dropped.',
  },
  {
    event: 'RECORD_DECISION',
    from: ['ready_for_committee'],
    to: 'awaiting_order_despatch',
    scope: 'case',
    phase: 1,
    milestones: ['decision_recorded'],
    opens: ['await_order_despatch'],
    supersedes: ['no_next_step'],
    description:
      'The committee has decided. In Phase 1 the officer types the operative text; Phase 4 ' +
      'attaches it to a sitting with attendance and per-respondent outcomes.',
  },
  {
    event: 'DESPATCH_ORDER',
    from: ['awaiting_order_despatch'],
    to: 'closed',
    scope: 'case',
    phase: 1,
    milestones: ['order_despatched', 'case_closed'],
    supersedes: ['await_order_despatch'],
    description:
      'Decision letters have gone to the parties. Closes with reason `decided_by_committee`.',
  },
  {
    event: 'REPORT_SETTLEMENT',
    from: ['under_scrutiny', 'awaiting_respondent_reply', 'ready_for_committee', 'awaiting_expert_report'],
    to: 'closed',
    scope: 'case',
    phase: 1,
    requiresReason: true,
    milestones: ['case_closed'],
    description:
      'Patient and dentist have settled between themselves. Closes with reason ' +
      '`amicable_settlement` — one of the three endings the officer named.',
  },
  {
    event: 'MARK_COMPLAINANT_UNRESPONSIVE',
    from: ['awaiting_complainant_documents'],
    to: 'closed',
    scope: 'case',
    phase: 1,
    requiresReason: true,
    milestones: ['case_closed'],
    supersedes: ['await_patient_docs', 'propose_closure'],
    description:
      'The ergonomic path out of the `propose_closure` follow-up. Forces the reason ' +
      '`complainant_unresponsive` so the register never records a bare closure.',
  },
  {
    event: 'PUT_ON_HOLD',
    from: OPEN_STATES,
    to: 'SAME',
    scope: 'hold',
    phase: 1,
    requiresReason: true,
    description:
      'Sub judice, a party indisposed, or awaiting an external authority. Suppresses deadlines ' +
      'and moves the case to its own dashboard bucket. Not a state — a flag with a reason.',
  },
  {
    event: 'RESUME',
    from: OPEN_STATES,
    to: 'SAME',
    scope: 'hold',
    phase: 1,
    description: 'Lifts the hold. Follow-up due dates are recomputed from the resume date.',
  },
  {
    event: 'CLOSE',
    from: OPEN_STATES,
    to: 'closed',
    scope: 'case',
    phase: 1,
    requiresReason: true,
    milestones: ['case_closed'],
    description:
      'The officer closes, with a reason. Committee cover is available and optional, never a ' +
      'gate — a sitting is six to eight weeks away and a closure cannot wait for it.',
  },
  {
    event: 'REOPEN',
    from: ['closed'],
    to: 'under_scrutiny',
    scope: 'case',
    phase: 1,
    requiresReason: true,
    milestones: ['case_reopened'],
    opens: ['no_next_step'],
    description:
      'The complainant disputes the order, or a court directs a rehearing. There is no separate ' +
      'appeal entity in v1 — see docs/00-build-plan.md §4.',
  },

  // ── Phase 3 ───────────────────────────────────────────────────────────────
  {
    event: 'REFER_TO_EXPERT',
    from: ['ready_for_committee'],
    to: 'awaiting_expert_report',
    scope: 'case',
    phase: 3,
    milestones: ['expert_referral_despatched'],
    opens: ['await_gdc_report'],
    description:
      'The GDCRI referral has been signed, sealed, scanned and dispatched. The state is entered ' +
      'on dispatch, not on drafting — timers run from the stamped date.',
  },
  {
    event: 'RECORD_EXPERT_REPORT',
    from: ['awaiting_expert_report'],
    to: 'ready_for_committee',
    scope: 'case',
    phase: 3,
    milestones: ['expert_report_received'],
    supersedes: ['await_gdc_report'],
    description:
      'The report is stored verbatim and returns to the committee. Sharing it with the patient ' +
      'is a separate, committee-gated decision.',
  },
] as const;

/** `waiting_on` is generated in Postgres. This mirror exists for the UI and for tests. */
export const WAITING_ON_BY_STATE: Readonly<Record<CaseState, WaitingOn>> = {
  intake_received: 'council_officer',
  under_scrutiny: 'council_officer',
  ready_for_committee: 'council_officer',
  awaiting_order_despatch: 'council_officer',
  awaiting_complainant_documents: 'complainant',
  awaiting_respondent_reply: 'respondent',
  awaiting_expert_report: 'expert_body',
  closed: 'nobody',
};

/** The dashboard question each bucket answers. Used as the group heading on Today. */
export const WAITING_ON_LABEL: Readonly<Record<WaitingOn, string>> = {
  council_officer: 'On my desk',
  complainant: 'Waiting on the complainant',
  respondent: 'Waiting on a dentist',
  expert_body: 'Waiting on GDCRI',
  committee: 'Waiting on the committee',
  nobody: 'Closed',
};

export function waitingOnFor(state: CaseState): WaitingOn {
  return WAITING_ON_BY_STATE[state];
}

const byEvent = new Map<CaseEvent, TransitionRule>(TRANSITIONS.map((t) => [t.event, t]));

export function transitionFor(event: CaseEvent): TransitionRule {
  const rule = byEvent.get(event);
  if (!rule) throw new Error(`Unknown case event: ${event}`);
  return rule;
}

export function resolveTarget(rule: TransitionRule, current: CaseState): CaseState {
  return rule.to === 'SAME' ? current : rule.to;
}

export interface AvailableEventsOptions {
  /** Highest build phase enabled for this council. Defaults to 1. */
  readonly phase?: BuildPhase;
  /** Include engine-raised events. Defaults to false — these are never buttons. */
  readonly includeSystem?: boolean;
}

/**
 * The single source of truth for which actions a case offers. Every button on every
 * client is derived from this; nothing re-implements a guard.
 */
export function availableEvents(
  current: CaseState,
  opts: AvailableEventsOptions = {},
): readonly TransitionRule[] {
  const phase = opts.phase ?? 1;
  return TRANSITIONS.filter((t) => {
    if (t.from === 'CREATE') return false;
    if (t.phase > phase) return false;
    if (t.system && !opts.includeSystem) return false;
    return t.from.includes(current);
  });
}

export function isTransitionAllowed(
  current: CaseState,
  event: CaseEvent,
  opts: AvailableEventsOptions = {},
): boolean {
  const rule = byEvent.get(event);
  if (!rule || rule.from === 'CREATE') return false;
  if (rule.phase > (opts.phase ?? 1)) return false;
  return rule.from.includes(current);
}

/** Events available in a given build phase. Phase 1 is exactly 17 — asserted in tests. */
export function eventsInPhase(phase: BuildPhase): readonly CaseEvent[] {
  return TRANSITIONS.filter((t) => t.phase <= phase).map((t) => t.event);
}
