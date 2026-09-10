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
