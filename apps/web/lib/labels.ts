/**
 * How the register talks to the officer.
 *
 * The database speaks in enums; a dental officer does not. Every label lives here so the
 * queue, the case file and the register cannot end up calling the same thing three
 * different names — which on a legal record is not merely untidy, it is a reader being
 * told two things.
 */

export const STATE_LABEL: Record<string, string> = {
  intake_received: 'Received',
  awaiting_complainant_documents: 'Awaiting documents',
  under_scrutiny: 'Under scrutiny',
  awaiting_respondent_reply: 'Awaiting the dentist',
  ready_for_committee: 'Ready for the committee',
  awaiting_expert_report: 'Awaiting GDCRI',
  awaiting_order_despatch: 'Order to despatch',
  closed: 'Closed',
};

export const WAITING_ON_LABEL: Record<string, string> = {
  council_officer: 'On my desk',
  complainant: 'Waiting on the complainant',
  respondent: 'Waiting on a dentist',
  expert_body: 'Waiting on GDCRI',
  committee: 'Waiting on the committee',
  nobody: 'Closed',
};

export const NOTICE_STATE_LABEL: Record<string, string> = {
  not_issued: 'No notice issued',
  awaiting_reply: 'Awaiting reply',
  replied: 'Replied',
  ex_parte: 'Ex parte',
  dropped: 'Dropped',
};

export const PARTY_ROLE_LABEL: Record<string, string> = {
  complainant: 'Complainant',
  patient: 'Patient',
  respondent_dentist: 'Respondent',
  respondent_establishment: 'Establishment',
  informant: 'Informant',
  witness: 'Witness',
  legal_representative: 'Legal representative',
};

export const MILESTONE_LABEL: Record<string, string> = {
  received: 'Complaint received',
  acknowledged: 'Acknowledged',
  documents_requested: 'Documents requested',
  documents_complete: 'Documents complete',
  respondent_notice_despatched: 'Notice despatched to dentist',
  respondent_reply_received: 'Dentist replied',
  respondent_declared_ex_parte: 'Dentist declared ex parte',
  case_closed: 'Case closed',
  case_reopened: 'Case reopened',
  expert_referral_despatched: 'Referred to GDCRI',
  expert_report_received: 'GDCRI report received',
  expert_report_shared: 'Report shared with patient',
  listed_for_sitting: 'Listed for a sitting',
  heard: 'Heard',
  decision_recorded: 'Decision recorded',
  order_despatched: 'Order despatched',
};

export const LETTER_LABEL: Record<string, string> = {
  ack_complaint: 'Acknowledgement',
  request_docs: 'Request for documents',
  request_docs_reminder: 'Reminder for documents',
  respondent_explanation_sought: 'Explanation sought',
  respondent_reminder: 'Reminder to dentist',
  respondent_final_notice: 'Final notice',
  summons_complainant: 'Hearing notice to complainant',
  summons_respondent: 'Hearing notice to dentist',
  member_intimation: 'Member intimation',
  expert_referral_letter: 'GDCRI referral',
  expert_referral_copy_to_patient: 'GDCRI referral - copy to patient',
  expert_report_share: 'Report shared',
  order_to_respondent: 'Order to dentist',
  order_to_complainant: 'Order to complainant',
  closure_intimation: 'Closure intimation',
  ethics_explanation: 'Ethics - explanation sought',
  ethics_cease_desist: 'Ethics - cease and desist',
  reply_to_referring_authority: 'Reply to referring authority',
  rti_reply_cover: 'RTI reply',
  inbound: 'Received',
  other: 'Other',
};

export const EVENT_LABEL: Record<string, string> = {
  REQUEST_DOCUMENTS: 'Request documents',
  MARK_COMPLETE_ON_ARRIVAL: 'Mark documents complete',
  DOCUMENTS_RECEIVED: 'Documents received',
  ISSUE_RESPONDENT_NOTICE: 'Issue a notice',
  RECORD_RESPONDENT_REPLY: 'Record a reply',
  DECLARE_RESPONDENT_EX_PARTE: 'Declare ex parte',
  DROP_RESPONDENT: 'Drop a respondent',
  RECORD_DECISION: 'Record the decision',
  DESPATCH_ORDER: 'Despatch the order',
  REPORT_SETTLEMENT: 'Record a settlement',
  MARK_COMPLAINANT_UNRESPONSIVE: 'Close - complainant unresponsive',
  PUT_ON_HOLD: 'Put on hold',
  RESUME: 'Resume',
  CLOSE: 'Close the case',
  REOPEN: 'Reopen',
  REFER_TO_EXPERT: 'Refer to GDCRI',
  RECORD_EXPERT_REPORT: 'Record the GDCRI report',
};

export const CLOSURE_REASON_LABEL: Record<string, string> = {
  complainant_unresponsive: 'Complainant unresponsive',
  amicable_settlement: 'Settled between the parties',
  decided_by_committee: 'Decided by the committee',
  withdrawn: 'Withdrawn',
  no_jurisdiction: 'Outside our jurisdiction',
  duplicate: 'Duplicate',
  court_seized: 'Before a court',
  notice_complied_with: 'Notice complied with',
  time_barred: 'Time barred',
};

export const DOCUMENT_CLASS_LABEL: Record<string, string> = {
  complaint_material: "Complainant's material",
  respondent_explanation: "Dentist's explanation",
  expert_report: 'GDCRI expert report',
  committee_record: 'Committee record',
  outbound_letter: 'Outgoing letter',
  service_proof: 'Proof of service',
  legacy_register_extract: 'Page from the register',
  other: 'Other',
};

/** Falls back to the raw value rather than to nothing: a blank label hides a bug. */
export function label(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return '-';
  return map[key] ?? key;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── RTI ─────────────────────────────────────────────────────────────────────

/**
 * The register speaks in sections; a reader does not.
 *
 * These labels are what the officer scans. The statutory words themselves live in
 * RTI_EXEMPTIONS in @ksdc/contracts and are quoted into the letter verbatim - a label is
 * for finding the right clause, never for standing in for it in a document.
 */
export const RTI_STATE_LABEL: Record<string, string> = {
  received: 'Clock running',
  fee_awaited: 'Awaiting the fee',
  third_party_consultation: 'Third party consulted',
  transferred: 'Transferred out',
  replied: 'Replied',
  closed: 'Closed',
};

export const RTI_CHANNEL_LABEL: Record<string, string> = {
  post: 'By post',
  email: 'By email',
  by_hand: 'By hand',
  transferred_in: 'Transferred to us',
  other: 'Other',
};

export const RTI_DECISION_LABEL: Record<string, string> = {
  information_supplied: 'Information supplied',
  partly_supplied: 'Partly supplied',
  refused: 'Refused',
  information_not_held: 'Not held by the Council',
  transferred: 'Transferred under s.6(3)',
  query_not_information: 'A question, not a record',
};

export const RTI_SECTION_LABEL: Record<string, string> = {
  s8_1_a: 's.8(1)(a) sovereignty, security, foreign relations',
  s8_1_b: 's.8(1)(b) forbidden by a court, or contempt',
  s8_1_c: 's.8(1)(c) privilege of a legislature',
  s8_1_d: 's.8(1)(d) commercial confidence or trade secrets',
  s8_1_e: 's.8(1)(e) held in a fiduciary relationship',
  s8_1_f: 's.8(1)(f) received in confidence from a foreign government',
  s8_1_g: 's.8(1)(g) endangers life or safety, or a confidential source',
  s8_1_h: 's.8(1)(h) impedes an investigation or prosecution',
  s8_1_i: 's.8(1)(i) cabinet papers',
  s8_1_j: 's.8(1)(j) personal information',
  s9: 's.9 infringement of copyright held by another',
};

export const RTI_STAGE_LABEL: Record<string, string> = {
  rti_reply_due: 'Statutory deadline',
  rti_prepare_reply: 'Prepare the reply',
  rti_await_fee: 'Awaiting the further fee',
  rti_await_third_party: 'Third party may object',
};
