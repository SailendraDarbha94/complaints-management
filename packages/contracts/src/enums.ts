import { z } from 'zod';

/** Helper: keep the tuple shape so Drizzle's pgEnum and Zod share one source. */
const tuple = <T extends readonly [string, ...string[]]>(v: T) => v;

// ─── Case ────────────────────────────────────────────────────────────────────

export const CASE_KINDS = tuple(['patient_complaint', 'ethics_notice'] as const);
export const caseKindSchema = z.enum(CASE_KINDS);
export type CaseKind = z.infer<typeof caseKindSchema>;

/**
 * Eight states in v1. `on_hold` is a boolean with a reason, not a state — sub judice,
 * a party indisposed, or awaiting an external authority all suppress deadlines without
 * multiplying the state space.
 *
 * `awaiting_expert_report` ships in the enum but has no inbound transition until
 * Phase 3 (see case-lifecycle.ts). That is deliberate: the enum and the generated
 * `waiting_on` expression are stable from the first migration, so adding the expert
 * referral flow becomes a code change rather than a migration against a legal register.
 */
export const CASE_STATES = tuple([
  'intake_received',
  'awaiting_complainant_documents',
  'under_scrutiny',
  'awaiting_respondent_reply',
  'ready_for_committee',
  'awaiting_expert_report',
  'awaiting_order_despatch',
  'closed',
] as const);
export const caseStateSchema = z.enum(CASE_STATES);
export type CaseState = z.infer<typeof caseStateSchema>;

/**
 * The column the paper register could never have. Derived in Postgres from `state`,
 * never written by the application — so it cannot drift, and the dashboard cannot be
 * confidently wrong.
 */
export const WAITING_ON = tuple([
  'council_officer',
  'complainant',
  'respondent',
  'expert_body',
  'committee',
  'nobody',
] as const);
export const waitingOnSchema = z.enum(WAITING_ON);
export type WaitingOn = z.infer<typeof waitingOnSchema>;

export const INTAKE_SOURCES = tuple([
  'direct_email',
  'support_forward',
  'dci_ndc_forward',
  'police_forward',
  'post',
  'walk_in',
  'suo_motu',
  'other',
] as const);
export const intakeSourceSchema = z.enum(INTAKE_SOURCES);
export type IntakeSource = z.infer<typeof intakeSourceSchema>;

export const CLOSURE_REASONS = tuple([
  'complainant_unresponsive',
  'amicable_settlement',
  'decided_by_committee',
  'withdrawn',
  'no_jurisdiction',
  'duplicate',
  'court_seized',
  'notice_complied_with',
  'time_barred',
] as const);
export const closureReasonSchema = z.enum(CLOSURE_REASONS);
export type ClosureReason = z.infer<typeof closureReasonSchema>;

/** Per respondent — different respondents on one case genuinely diverge. */
export const CASE_OUTCOMES = tuple([
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
  'cease_and_desist_confirmed',
  'complaint_dismissed',
] as const);
export const caseOutcomeSchema = z.enum(CASE_OUTCOMES);
export type CaseOutcome = z.infer<typeof caseOutcomeSchema>;

// ─── Parties ─────────────────────────────────────────────────────────────────

export const PARTY_ROLES = tuple([
  'complainant',
  'patient',
  'respondent_dentist',
  'respondent_establishment',
  'informant',
  'witness',
  'legal_representative',
] as const);
export const partyRoleSchema = z.enum(PARTY_ROLES);
export type PartyRole = z.infer<typeof partyRoleSchema>;

export const PARTY_KINDS = tuple(['person', 'organisation'] as const);
export const partyKindSchema = z.enum(PARTY_KINDS);
export type PartyKind = z.infer<typeof partyKindSchema>;

/** Per respondent, independent of the case state. */
export const NOTICE_STATES = tuple([
  'not_issued',
  'awaiting_reply',
  'replied',
  'ex_parte',
  'dropped',
] as const);
export const noticeStateSchema = z.enum(NOTICE_STATES);
export type NoticeState = z.infer<typeof noticeStateSchema>;

/**
 * How a notice was served. Proof of service — not the notice count — is what an
 * ex parte finding rests on if it is ever challenged.
 */
export const SERVICE_MODES = tuple([
  'email',
  'registered_post_ad',
  'speed_post',
  'courier',
  'hand_delivery',
  'whatsapp',
] as const);
export const serviceModeSchema = z.enum(SERVICE_MODES);
export type ServiceMode = z.infer<typeof serviceModeSchema>;

// ─── Contact and correspondence ──────────────────────────────────────────────

export const CONTACT_CHANNELS = tuple([
  'email',
  'phone_call',
  'whatsapp',
  'post',
  'in_person',
  'sms',
] as const);
export const contactChannelSchema = z.enum(CONTACT_CHANNELS);
export type ContactChannel = z.infer<typeof contactChannelSchema>;

export const CONTACT_DIRECTIONS = tuple(['in', 'out'] as const);
export const contactDirectionSchema = z.enum(CONTACT_DIRECTIONS);
export type ContactDirection = z.infer<typeof contactDirectionSchema>;

export const CORRESPONDENCE_KINDS = tuple([
  'ack_complaint',
  'request_docs',
  'request_docs_reminder',
  'respondent_explanation_sought',
  'respondent_reminder',
  'respondent_final_notice',
  'summons_complainant',
  'summons_respondent',
  'member_intimation',
  'expert_referral_letter',
  'expert_referral_copy_to_patient',
  'expert_report_share',
  'order_to_respondent',
  'order_to_complainant',
  'closure_intimation',
  'ethics_explanation',
  'ethics_cease_desist',
  'reply_to_referring_authority',
  'rti_reply_cover',
  'inbound',
  'other',
] as const);
export const correspondenceKindSchema = z.enum(CORRESPONDENCE_KINDS);
export type CorrespondenceKind = z.infer<typeof correspondenceKindSchema>;

// ─── Milestones ──────────────────────────────────────────────────────────────

export const MILESTONES = tuple([
  'received',
  'acknowledged',
  'documents_requested',
  'documents_complete',
  'respondent_notice_despatched',
  'respondent_reply_received',
  'respondent_declared_ex_parte',
  'case_closed',
  'case_reopened',
  // Phase 3
  'expert_referral_despatched',
  'expert_report_received',
  'expert_report_shared',
  // Phase 4
  'listed_for_sitting',
  'heard',
  'decision_recorded',
  'order_despatched',
] as const);
export const milestoneSchema = z.enum(MILESTONES);
export type Milestone = z.infer<typeof milestoneSchema>;

/**
 * Mandatory on every milestone. Anything other than `recorded` is footnoted in every
 * export and printed case file — which is what stops a reconstructed backlog date from
 * becoming indistinguishable from a recorded fact in an RTI reply or a writ petition.
 */
export const DATE_SOURCES = tuple([
  'recorded',
  'from_physical_register',
  'estimated_by_officer',
] as const);
export const dateSourceSchema = z.enum(DATE_SOURCES);
export type DateSource = z.infer<typeof dateSourceSchema>;

// ─── Follow-ups ──────────────────────────────────────────────────────────────

export const FOLLOWUP_STAGES = tuple([
  'await_patient_docs',
  'await_respondent_explanation',
  'await_ev_explanation',
  'await_gdc_report',
  'await_order_despatch',
  'await_compliance',
  'await_despatch_entry',
  'await_registrar_signature',
  'await_authority_report_back',
  'propose_ex_parte',
  'propose_closure',
  'no_next_step',
  'ad_hoc',
  /**
   * The RTI clock. Two rows, not one, and the split is deliberate.
   *
   * `rti_reply_due` falls due on the statutory date ITSELF, so the register never shows an
   * RTI deadline that is not the real one. It is statutory, so it cannot be snoozed past
   * that date, and it never escalates - there is nothing to escalate to. It is a wall.
   *
   * `rti_prepare_reply` is the working task, due well before, which escalates the ordinary
   * way. Without it the officer's first warning arrives on the day the reply had to be in
   * the post, which is no warning at all.
   */
  'rti_reply_due',
  'rti_prepare_reply',
  /** s.7(3)(a): the applicant owes a further fee, and the clock is excluded until they pay. */
  'rti_await_fee',
  /** s.11(2): the third party's ten days, running from THEIR receipt of the notice. */
  'rti_await_third_party',
] as const);
export const followupStageSchema = z.enum(FOLLOWUP_STAGES);
export type FollowupStage = z.infer<typeof followupStageSchema>;

export const FOLLOWUP_STATUSES = tuple([
  'open',
  'snoozed',
  'satisfied',
  'escalated',
  'superseded',
  'cancelled',
] as const);
export const followupStatusSchema = z.enum(FOLLOWUP_STATUSES);
export type FollowupStatus = z.infer<typeof followupStatusSchema>;

// ─── Platform ────────────────────────────────────────────────────────────────

/** Three roles in v1. `registrar` and `chairperson` are no-login identity rows. */
export const ROLES = tuple(['officer', 'committee_member', 'auditor'] as const);
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const DOCUMENT_STATUSES = tuple(['stored', 'misfiled_withdrawn'] as const);
export const documentStatusSchema = z.enum(DOCUMENT_STATUSES);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

/**
 * `may_summarise = false` classes are never reachable by any AI path — enforced by a
 * throwing context loader, not by a prompt. The expert report carries the negligence
 * finding; the respondent's explanation is their defence in their own words.
 */
export const DOCUMENT_CLASSES = tuple([
  'complaint_material',
  'respondent_explanation',
  'expert_report',
  'committee_record',
  'outbound_letter',
  'service_proof',
  'legacy_register_extract',
  'other',
] as const);
export const documentClassSchema = z.enum(DOCUMENT_CLASSES);
export type DocumentClass = z.infer<typeof documentClassSchema>;

export const NEVER_SUMMARISE: readonly DocumentClass[] = [
  'expert_report',
  'respondent_explanation',
  'committee_record',
];

// ─── RTI ─────────────────────────────────────────────────────────────────────

/**
 * An RTI request is its own record, not a case type.
 *
 * It has a different clock, a different statute, a different appeal route, and a penalty
 * that lands on a named officer's salary rather than on the council. Filing it as a case
 * would put a 30-day statutory deadline through machinery built for a grievance that has
 * no deadline at all. It links to cases — sometimes to several, often to none.
 */
export const RTI_STATES = tuple([
  /** Logged. The clock is running from the inward date. */
  'received',
  /**
   * A further fee has been intimated and is unpaid. s.7(3)(a): the period between the
   * despatch of the intimation and the payment is EXCLUDED — the only true stop-the-clock
   * in the Act.
   */
  'fee_awaited',
  /**
   * The officer has recorded an intention to disclose third-party information, which is
   * the statutory trigger in s.11(1). The deadline becomes 40 days, not 30.
   */
  'third_party_consultation',
  /** Transferred to another public authority under s.6(3). Our clock stops there. */
  'transferred',
  /** The decision has been despatched. */
  'replied',
  /**
   * Finished. Distinct from `replied` because a first appeal is condonable beyond its own
   * 30 days and a second appeal to the Commission currently takes about 1 year 9 months,
   * so a file stays re-openable long after the reply went out.
   */
  'closed',
] as const);
export const rtiStateSchema = z.enum(RTI_STATES);
export type RtiState = z.infer<typeof rtiStateSchema>;

/** How the application reached the council. Post and email are the two that actually happen. */
export const RTI_CHANNELS = tuple([
  'post',
  'email',
  'by_hand',
  /** Forwarded to us by another public authority under s.6(3). */
  'transferred_in',
  'other',
] as const);
export const rtiChannelSchema = z.enum(RTI_CHANNELS);
export type RtiChannel = z.infer<typeof rtiChannelSchema>;

/**
 * What the council decided.
 *
 * `query_not_information` is here because it is common and it is NOT a refusal: an
 * applicant who asks "why did the Council not act sooner" is asking a question, and s.2(f)
 * defines information as material that exists in some record. Answering that with a s.8
 * ground would be wrong and appealable; saying so plainly is correct. It is kept separate
 * precisely so the refusal composer does not offer exemption sections for it.
 */
export const RTI_DECISIONS = tuple([
  'information_supplied',
  'partly_supplied',
  'refused',
  'information_not_held',
  'transferred',
  'query_not_information',
] as const);
export const rtiDecisionSchema = z.enum(RTI_DECISIONS);
export type RtiDecision = z.infer<typeof rtiDecisionSchema>;

/**
 * The ONLY grounds on which information may be withheld.
 *
 * s.8(1)(a) to (j) and s.9. Section 11 is deliberately absent and must stay absent: two
 * CIC decisions are explicit that a refusal rests on s.8(1) or s.9 and that s.11 is the
 * procedure you follow first, never a ground. Because this list is a Postgres enum, a
 * refusal "under s.11" cannot be stored, not merely cannot be typed.
 */
export const RTI_EXEMPTION_SECTIONS = tuple([
  's8_1_a',
  's8_1_b',
  's8_1_c',
  's8_1_d',
  's8_1_e',
  's8_1_f',
  's8_1_g',
  's8_1_h',
  's8_1_i',
  's8_1_j',
  's9',
] as const);
export const rtiExemptionSectionSchema = z.enum(RTI_EXEMPTION_SECTIONS);
export type RtiExemptionSection = z.infer<typeof rtiExemptionSectionSchema>;

// ─── Inward mail ─────────────────────────────────────────────────────────────

/**
 * What became of a message in the inward tray.
 *
 * A message is not a case. Most forwards are complaints, some are replies on a case
 * already open, and some are circulars or misdirected mail — so a message is stored as
 * itself first, and exactly one of these three things happens to it afterwards.
 */
export const MAIL_STATUSES = tuple(['unfiled', 'filed', 'dismissed'] as const);
export const mailStatusSchema = z.enum(MAIL_STATUSES);
export type MailStatus = z.infer<typeof mailStatusSchema>;

/**
 * How a message came to be attached to a case.
 *
 * Recorded on the row, because "why is this letter on this file" is a question somebody
 * will ask in two years, and "a person decided" and "it quoted the number" are very
 * different answers to it.
 */
export const MAIL_MATCH_RUNGS = tuple([
  /** The case number was in the subject line. The strongest signal there is. */
  'reference_subject',
  /** The case number was in the body, usually inside a quoted reply. */
  'reference_body',
  /** An address the register knows. SUGGESTS ONLY - see matching.ts for why. */
  'sender',
  /** A person decided. */
  'officer',
] as const);
export const mailMatchRungSchema = z.enum(MAIL_MATCH_RUNGS);
export type MailMatchRung = z.infer<typeof mailMatchRungSchema>;

/**
 * Which shape of forward was unwrapped.
 *
 * Kept so that a parser regression can be traced to the mail client that produced it
 * rather than guessed at. `rfc822_attachment` is the only form that carries a real
 * timezone; every other form's date is text with no offset in it.
 */
export const MAIL_FORWARD_KINDS = tuple([
  'rfc822_attachment',
  'gmail',
  'outlook_web',
  'outlook_desktop',
  'apple_mail',
  'generic',
  'none',
  'header_block',
] as const);
export const mailForwardKindSchema = z.enum(MAIL_FORWARD_KINDS);
export type MailForwardKind = z.infer<typeof mailForwardKindSchema>;
