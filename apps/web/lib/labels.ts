import type {
  MailSuggestionConfidence,
  MailSuggestionDecision,
  MailSuggestionStatus,
} from '@ksdc/contracts';

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
  awaiting_order_despatch: 'Order to dispatch',
  closed: 'Closed',
};

/**
 * A case cancelled as opened in error.
 *
 * Not a state, so not in STATE_LABEL: cancelling leaves the case in the state it was in,
 * so that restoring it puts it back exactly where it stood. Every screen that shows a
 * state therefore asks `deleted_at` first and says this instead - and says the same word,
 * on the case, in the register and in its chip, because a legal record that calls one
 * thing by two names is telling its reader two things.
 */
export const CANCELLED_LABEL = 'Cancelled';

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
  respondent_notice_despatched: 'Notice dispatched to dentist',
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
  order_despatched: 'Order dispatched',
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
  DESPATCH_ORDER: 'Dispatch the order',
  REPORT_SETTLEMENT: 'Record a settlement',
  MARK_COMPLAINANT_UNRESPONSIVE: 'Close - complainant unresponsive',
  PUT_ON_HOLD: 'Put on hold',
  RESUME: 'Resume',
  CLOSE: 'Close the case',
  REOPEN: 'Reopen',
  REFER_TO_EXPERT: 'Refer to GDCRI',
  RECORD_EXPERT_REPORT: 'Record the GDCRI report',
  // Not transitions, but written to the same history (see CANCEL_EVENT and RESTORE_EVENT in
  // @ksdc/core), so the case page's chronology prints them from here - and without an
  // entry, label() would print the raw key into a record the officer reads and prints.
  // Spelled out rather than imported: this file reaches the browser through client
  // components, and @ksdc/core would bring the database driver with it. labels.test.ts
  // holds the two spellings together instead.
  CANCEL_OPENED_IN_ERROR: 'Cancelled - opened in error',
  RESTORE_CANCELLED_CASE: 'Restored after cancellation',
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

// ─── Inward mail ─────────────────────────────────────────────────────────────

/**
 * How the message reached us, in words rather than in parser vocabulary.
 *
 * A kind names the SHAPE of the forward, not the program that sent it, and several clients
 * share a shape: the Council's own Roundcube draws the same 'Original Message' rule as
 * Outlook desktop, and Zimbra and Yahoo write Gmail's 'Forwarded message' line. So those
 * two kinds say only 'forwarded' - naming a mail program the officer never used is worse
 * than naming none.
 */
export const FORWARD_KIND_LABEL: Record<string, string> = {
  rfc822_attachment: 'forwarded as an attachment',
  gmail: 'forwarded',
  outlook_web: 'forwarded from Outlook',
  outlook_desktop: 'forwarded',
  apple_mail: 'forwarded from Apple Mail',
  generic: 'forwarded',
  none: 'sent to us directly',
  header_block: 'forwarded',
};

/** Why a message ended up on the case it is on. */
export const MATCH_RUNG_LABEL: Record<string, string> = {
  reference_subject: 'filed automatically — the subject quoted the case number',
  reference_body: 'filed automatically — the message quoted the case number',
  sender: 'filed on the sender',
  officer: 'filed by the officer',
};

// ─── The mail assistant ──────────────────────────────────────────────────────

/*
 * Keyed by the contract's own enum types rather than by string, so that a decision or a
 * status added in @ksdc/contracts fails the typecheck here instead of reaching the officer
 * as a raw key. A type-only import: nothing from contracts is bundled by these lines.
 *
 * The words are the ordinary buttons' words. The assistant suggests the same three things
 * the officer can already do, and calling them something else on the suggestion would make
 * "accept the suggestion" and "press the button" look like different acts. They are not:
 * both go through the same service.
 */

/** What it suggested, as a heading - the same words as the three ordinary buttons. */
export const SUGGESTION_DECISION_LABEL: Record<MailSuggestionDecision, string> = {
  new_complaint: 'Open a case',
  follow_up: 'Add to a case',
  not_a_complaint: 'Not a complaint',
  unsure: 'Not sure',
};

/**
 * How sure it was. In words a person would use, not 'high/medium/low': the chip is read
 * at a glance on a card, and "fairly sure" is read correctly at a glance where "medium"
 * has to be interpreted.
 */
export const SUGGESTION_CONFIDENCE_LABEL: Record<MailSuggestionConfidence, string> = {
  high: 'Sure',
  medium: 'Fairly sure',
  low: 'Not very sure',
};

/** Where a suggestion stands. 'handled' is the officer deciding with the ordinary buttons. */
export const SUGGESTION_STATUS_LABEL: Record<MailSuggestionStatus, string> = {
  pending: 'Waiting for you',
  accepted: 'Accepted as it was',
  edited: 'Accepted with changes',
  rejected: 'Turned down',
  handled: 'Decided with the usual buttons',
  superseded: 'Replaced by a fresh reading',
  failed: 'Could not be read',
};

/** What finally happened to the message, as the end of "you ...". */
export const SUGGESTION_OUTCOME_LABEL: Record<string, string> = {
  opened_case: 'opened a case',
  filed_on_case: 'added it to a case',
  set_aside: 'set it aside',
  rejected: 'turned the suggestion down',
};

/**
 * Rupees to the US dollar, for an APPROXIMATE figure beside what the assistant cost.
 *
 * Anthropic bills in dollars; the officer budgets in rupees. A fixed, labelled rate is
 * deliberate: a live rate would make last month's figure change every time the page is
 * opened, and this is a feel for the spend, never an invoice. Every screen that converts
 * says "about" and names this rate. Revisit it if the rupee moves a long way.
 */
export const RUPEES_PER_DOLLAR = 88;

/** "$4.20". Sub-cent amounts say so rather than rounding to a misleading "$0.00". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return 'under $0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * "₹370", at RUPEES_PER_DOLLAR, grouped the Indian way (₹1,23,456). Bare, for a place whose
 * own label already says the figure is rough; everywhere else, formatRupeesFromUsd.
 */
export function rupeesFromUsd(usd: number): string {
  const rupees = usd * RUPEES_PER_DOLLAR;
  if (rupees > 0 && rupees < 1) return 'under ₹1';
  return `₹${Math.round(rupees).toLocaleString('en-IN')}`;
}

/** "about ₹370" - never a bare converted figure that could be read as the bill. */
export function formatRupeesFromUsd(usd: number): string {
  const rupees = rupeesFromUsd(usd);
  return rupees.startsWith('under') ? rupees : `about ${rupees}`;
}
