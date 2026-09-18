import type { CouncilConfig } from './council-config.js';

/**
 * Karnataka State Dental Council — tenant #1.
 *
 * Every value here came from the requirements interview (docs/requirements.md) or from
 * the one existing artefact, the scanned GDCRI referral letter. Where a value is our
 * assumption rather than the officer's answer, it says so — those are the lines to
 * check first when something behaves oddly.
 */
export const KSDC_COUNCIL = {
  code: 'KSDC',
  name: 'Karnataka State Dental Council',
  addressLines: [
    'No. 143, 5th Main Road',
    'Chamarajpet',
    'Bengaluru - 560 018',
  ],
  phone: '080-2667 4068',
  website: 'www.ksdc.in',
  officialEmail: 'registrar@ksdc.in',
  registrarName: 'R Venugopal',
  registrarTitle: 'Registrar',
  /** Chairs the ethics committee. No login — an identity row for letters and attribution. */
  presidentTitle: 'President',
  timezone: 'Asia/Kolkata' as const,
} as const;

export const KSDC_CONFIG: CouncilConfig = {
  schemaVersion: 1,
  buildPhase: 1,

  numbering: {
    councilCode: 'KSDC',
    fiscalYearStartMonth: 4,
    serialPadding: 4,
    despatchNumberIsExternal: true,
  },

  calendar: {
    timezone: 'Asia/Kolkata',
    // ASSUMPTION: Mon–Sat, the usual Karnataka government office week. Open question Q(a)
    // in docs/00-build-plan.md — one sentence from the officer fixes every due date.
    workingWeekdays: [1, 2, 3, 4, 5, 6],
    holidays: [],
    digestHourLocal: 9,
  },

  // The officer's answer to Q14 was "5-7 days is the usual timeframe given to each party".
  // We seed 7 — the generous end — because a reminder that fires too early is impolite to
  // a patient who is still gathering bills, and the officer can always chase early by hand.
  followupRules: [
    {
      stage: 'await_patient_docs',
      dueInDays: 7,
      basis: 'working_days',
      maxEscalations: 2,
      escalationGapDays: 7,
      terminalAction: 'propose_closure',
      isStatutory: false,
      label: 'Complainant to send bills, prescriptions, timeline and doctor details',
    },
    {
      stage: 'await_respondent_explanation',
      dueInDays: 7,
      basis: 'working_days',
      // Two escalations after the first notice = three notices in total, then the engine
      // stops and proposes. It never declares ex parte itself.
      maxEscalations: 2,
      escalationGapDays: 7,
      terminalAction: 'propose_ex_parte',
      isStatutory: false,
      label: 'Respondent to send an explanation',
    },
    {
      stage: 'await_ev_explanation',
      dueInDays: 7,
      basis: 'working_days',
      maxEscalations: 2,
      escalationGapDays: 7,
      terminalAction: 'propose_closure',
      isStatutory: false,
      label: 'Dentist to reply to an ethical-violation notice',
    },
    {
      stage: 'await_gdc_report',
      // ASSUMPTION: 21 days then a chase every 14. Open question — if the Dean's office
      // typically takes two months, the first reminder is premature and slightly impolite.
      dueInDays: 21,
      basis: 'calendar_days',
      maxEscalations: 4,
      escalationGapDays: 14,
      terminalAction: 'none',
      isStatutory: false,
      label: 'GDCRI to return the expert report',
    },
    {
      stage: 'await_order_despatch',
      dueInDays: 7,
      basis: 'working_days',
      maxEscalations: 3,
      escalationGapDays: 5,
      terminalAction: 'none',
      isStatutory: false,
      label: 'Dispatch the decision letters to the parties',
    },
    {
      stage: 'await_compliance',
      dueInDays: 30,
      basis: 'calendar_days',
      maxEscalations: 3,
      escalationGapDays: 15,
      terminalAction: 'none',
      isStatutory: false,
      label: 'Respondent to comply with the order (reimbursement or retreatment)',
    },
    {
      stage: 'await_despatch_entry',
      dueInDays: 2,
      basis: 'working_days',
      maxEscalations: 3,
      escalationGapDays: 2,
      terminalAction: 'none',
      isStatutory: false,
      label: 'Enter the outward dispatch number from the office register',
    },
    {
      stage: 'await_registrar_signature',
      dueInDays: 2,
      basis: 'working_days',
      maxEscalations: 5,
      escalationGapDays: 2,
      terminalAction: 'none',
      isStatutory: false,
      // Assigned to the OFFICER, never to the Registrar — he does not log in, and gating
      // the pipeline on a non-user's tap stalls it behind a busy senior person (D6).
      label: 'Get the Registrar to sign',
    },
    {
      stage: 'await_authority_report_back',
      dueInDays: 15,
      basis: 'calendar_days',
      maxEscalations: 2,
      escalationGapDays: 7,
      terminalAction: 'none',
      isStatutory: false,
      label: 'Report back to the referring authority (DCI/NDC, police, government)',
    },
    {
      stage: 'propose_ex_parte',
      dueInDays: 0,
      basis: 'working_days',
      maxEscalations: 0,
      escalationGapDays: 7,
      terminalAction: 'none',
      isStatutory: false,
      label: 'Notice ladder exhausted — decide whether to proceed ex parte',
    },
    {
      stage: 'propose_closure',
      dueInDays: 0,
      basis: 'working_days',
      maxEscalations: 0,
      escalationGapDays: 7,
      terminalAction: 'none',
      isStatutory: false,
      label: 'No response after repeated reminders — decide whether to close',
    },
    {
      stage: 'no_next_step',
      dueInDays: 0,
      basis: 'working_days',
      maxEscalations: 0,
      escalationGapDays: 7,
      terminalAction: 'none',
      isStatutory: false,
      // The invariant: every open case owns at least one open follow-up, or it is flagged
      // as having no next step. A case with no timer is invisible to a timer-based system,
      // and invisible is exactly how a case goes quiet for 34 days.
      label: 'This case has no next step scheduled',
    },
    {
      stage: 'ad_hoc',
      dueInDays: 7,
      basis: 'working_days',
      maxEscalations: 0,
      escalationGapDays: 7,
      terminalAction: 'none',
      isStatutory: false,
      label: 'Officer task',
    },

    // --- RTI -----------------------------------------------------------------
    //
    // Calendar days throughout, never working days. s.7(1) says thirty days and the
    // Commission counts thirty days; a holiday does not lengthen a statutory period, and a
    // register that quietly added the Dasara holidays to an RTI deadline would be telling
    // the officer a comfortable lie about the one clock that costs them money personally.
    {
      stage: 'rti_reply_due',
      // Overridden at the call site with the real statutory date, which accounts for the
      // s.11 forty-day case and for any excluded fee period. This default is the plain
      // s.7(1) thirty days and is what a request with no complications gets.
      dueInDays: 30,
      basis: 'calendar_days',
      // A wall does not escalate. There is nothing after the deadline except the penalty,
      // and a reminder sent the day after would be an insult rather than a help.
      maxEscalations: 0,
      escalationGapDays: 1,
      terminalAction: 'none',
      isStatutory: true,
      label: 'Statutory deadline: the RTI reply must be dispatched',
    },
    {
      stage: 'rti_prepare_reply',
      // Ten clear days before the ordinary deadline. Enough to search the files, take the
      // Registrar's view on a refusal, get a signature and reach the post office.
      dueInDays: 20,
      basis: 'calendar_days',
      maxEscalations: 3,
      escalationGapDays: 3,
      terminalAction: 'none',
      isStatutory: false,
      label: 'Prepare the RTI reply',
    },
    {
      stage: 'rti_await_fee',
      // No statutory period at all: s.7(3)(a) stops the clock but does not say for how
      // long. Fifteen days is a chase, not a deadline, and nothing lapses when it passes.
      dueInDays: 15,
      basis: 'calendar_days',
      maxEscalations: 1,
      escalationGapDays: 15,
      terminalAction: 'none',
      isStatutory: false,
      label: 'Applicant to pay the further fee intimated',
    },
    {
      stage: 'rti_await_third_party',
      // s.11(2) gives the third party ten days from THEIR receipt of the notice, which is
      // a date the council learns from the acknowledgement card. The call site passes the
      // real due date; this default only applies if that date is genuinely unknown.
      dueInDays: 10,
      basis: 'calendar_days',
      maxEscalations: 0,
      escalationGapDays: 5,
      terminalAction: 'none',
      isStatutory: true,
      label: 'Third party to make a representation under s.11(2)',
    },
  ],

  respondents: {
    // Q29: "3 notices to the doctor then the committee proceeds ex-parte."
    // A warning with an override, not a guard — see build plan D3.
    noticesBeforeExParte: 3,
    finalNoticeRequiresProofOfService: true,
  },

  closureReasons: [
    'complainant_unresponsive',
    'amicable_settlement',
    'decided_by_committee',
    'withdrawn',
    'no_jurisdiction',
    'duplicate',
    'court_seized',
    'notice_complied_with',
  ],

  // Q21: the proposed list, plus "referral to medical expert".
  outcomes: [
    'no_misconduct',
    'warning',
    'censure',
    'reimbursement',
    'retreatment',
    'suspension',
    'removal_from_register',
    'amicable_settlement',
    'referral_to_medical_expert',
    'advisory_to_establishment',
    'complaint_dismissed',
  ],

  // Transcribed from the scanned referral letter, KSDC/297/2026-27.
  expertBody: {
    name: 'Govt. Dental College & Research Institute',
    addresseeTitle: 'Dean',
    addressLines: [
      'Govt. Dental College & Research Institute',
      'Victoria Hospital, near City Market, Kalasipalya',
      'Bengaluru - 560002',
    ],
    referralQuestions: [
      'Whether Medical Negligence has occurred in this regard',
      'Were the standard ethical guidelines followed in this case',
    ],
  },

  aiEnabled: false,
  memberSeesAllCases: true,

  retention: {
    // Pending a signed one-page schedule from the Registrar (Phase 5). Null = permanent,
    // which is the safe default when no rule has been checked.
    caseRecordsYears: null,
    backupYears: 8,
  },
};
