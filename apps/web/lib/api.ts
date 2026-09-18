import { cookies } from 'next/headers';

/**
 * The web app is a thin client over the Nest API (build plan D7/§12). It holds no
 * database credentials and does no data access of its own: one place enforces row-level
 * security, and it is not this one.
 *
 * Session tokens live in HttpOnly cookies set by the API. In production both apps sit
 * under ksdc.in, so the browser treats them as same-site; in development both are on
 * localhost, which is same-site too (cookies ignore the port). Server-rendered requests
 * do not carry the browser's cookies automatically, so they are forwarded here.
 */

/**
 * What the SERVER fetches. A server-side fetch cannot use a relative URL, so this one does
 * need an absolute origin - it is this app calling its own route handlers.
 *
 * That hop is now pointless: a server component could import @ksdc/core and call the
 * services directly, saving a round trip through the loopback interface. It is kept for
 * the moment because it holds the diff down; removing it is the obvious next step.
 */
export const API_URL =
  process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

/** What the browser talks to directly, for uploads and form posts. */
export { PUBLIC_API_URL } from './public-api';

export type Urgency =
  | 'needs_decision'
  | 'overdue'
  | 'due_today'
  | 'this_week'
  | 'later'
  | 'snoozed';

export interface QueueItem {
  followUpId: string;
  stage: string;
  urgency: Urgency;
  title: string;
  detail: string | null;
  dueOn: string;
  daysOverdue: number;
  snoozedUntil: string | null;
  escalationLevel: number;
  waitingOnKind: string;
  caseFileId: string | null;
  caseNumber: string | null;
  caseSummary: string | null;
  caseQuietDays: number | null;
  partyName: string | null;
  partyMobile: string | null;
  isStatutory: boolean;
  /** An RTI application, where this row belongs to one instead of to a case. */
  rtiRequestId: string | null;
  rtiNo: string | null;
  rtiDueOn: string | null;
}

export interface QueueGroup {
  key: string;
  label: string;
  count: number;
  overdueCount: number;
  items: QueueItem[];
}

export interface TodayResponse {
  summary: {
    today: string;
    total: number;
    needsDecision: number;
    overdue: number;
    dueToday: number;
    thisWeek: number;
    snoozed: number;
    snoozedOverdue: number;
  };
  byUrgency: QueueGroup[];
  byWaitingOn: QueueGroup[];
  ticker: { lastSuccessAt: string | null; stale: boolean; hoursSince: number | null };
}

export interface Session {
  user: { id: string; email: string; name: string };
  council: { councilId: string; role: string };
}

export interface CaseListRow {
  id: string;
  register_sl_no: number;
  case_number: string;
  case_kind: string;
  state: string;
  waiting_on: string;
  on_hold: boolean;
  summary: string;
  intake_source: string;
  days_waiting: number | null;
  closed_at: string | null;
  closure_reason: string | null;
  is_backfilled: boolean;
  complainant_name: string | null;
}

export interface CaseParty {
  role: string;
  full_name: string;
  mobile: string | null;
  email: string | null;
  age_years: number | null;
  sex: string | null;
}

export interface CaseRespondent {
  id: string;
  full_name: string;
  notice_state: string;
  notice_count: number;
  ex_parte_eligible: boolean;
  ex_parte_at: string | null;
  dropped_at: string | null;
  registration_no: string | null;
  clinic_name: string | null;
  last_notice_at: string | null;
  replied_at: string | null;
}

export interface CaseMilestone {
  milestone: string;
  occurred_at: string;
  date_source: string;
  note: string | null;
}

export interface CaseHistoryEntry {
  event: string;
  from_state: string | null;
  to_state: string;
  reason: string | null;
  occurred_at: string;
  is_system: boolean;
}

export interface CaseLetter {
  id: string;
  kind: string;
  direction: 'in' | 'out';
  subject: string;
  to_name: string | null;
  from_email: string | null;
  sent_at: string | null;
  received_at: string | null;
  despatch_no: string | null;
  despatch_date: string | null;
  created_at: string;
}

export interface CaseDocument {
  id: string;
  title: string;
  documentClass: string;
  status: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  versionNo: number;
  physicalOriginalHeld: boolean;
  physicalReturnedAt: string | null;
  mayBeSummarised: boolean;
}

export interface AvailableEvent {
  event: string;
  to: string;
  scope: 'case' | 'respondent' | 'hold';
  requiresReason: boolean;
  description: string;
}

export interface CaseDetail {
  case: {
    id: string;
    case_number: string;
    case_kind: string;
    state: string;
    waiting_on: string;
    waiting_since: string;
    on_hold: boolean;
    hold_reason: string | null;
    summary: string;
    remarks: string | null;
    intake_source: string;
    external_ref_no: string | null;
    external_authority_name: string | null;
    documents_complete_at: string | null;
    closed_at: string | null;
    closure_reason: string | null;
    is_backfilled: boolean;
    legacy_register_ref: string | null;
    register_sl_no: number;
    fiscal_year: string;
  } | null;
  parties: CaseParty[];
  respondents: CaseRespondent[];
  milestones: CaseMilestone[];
  history: CaseHistoryEntry[];
  letters: CaseLetter[];
  documents: CaseDocument[];
  followups: Array<{
    id: string;
    stage: string;
    status: string;
    dueOn: string;
    escalationLevel: number;
    snoozedUntil: string | null;
    title: string;
  }>;
  /** RTI applications asking about this case. Usually empty. */
  rtiRequests: Array<{
    id: string;
    rti_no: string;
    received_on: string;
    due_on: string;
    state: string;
    note: string | null;
  }>;
  availableEvents: AvailableEvent[];
}

export interface TemplateRow {
  kind: string;
  name: string;
  is_system: boolean;
  requires_registrar_signature: boolean;
  version_no: number;
  subject_tpl: string;
  body: string;
  published_at: string;
  availableFields: string[];
}

export type RegisterRow = Record<string, string | number | boolean | null>;

// ─── RTI ─────────────────────────────────────────────────────────────────────

export interface RtiClock {
  dueOn: string;
  daysRemaining: number;
  excludedDays: number;
  onFeeHold: boolean;
  deemedRefusal: boolean;
  penaltyExposureRupees: number;
  transferDueOn: string;
  thirdPartyNoticeDueOn: string | null;
  thirdPartyRepresentationDueOn: string | null;
  appealRunsFrom: string;
  warnings: string[];
}

export interface RtiRequest {
  id: string;
  rti_no: string;
  fiscal_year: string;
  register_sl_no: number;
  received_on: string;
  received_via: string;
  date_source: string;
  applicant_name: string;
  applicant_address_lines: string[];
  applicant_email: string | null;
  applicant_phone: string | null;
  is_bpl: boolean;
  request_text: string;
  external_ref_no: string | null;
  application_fee_received: boolean;
  further_fee_intimated_on: string | null;
  further_fee_amount: string | null;
  further_fee_paid_on: string | null;
  transferred_to: string | null;
  transferred_on: string | null;
  life_or_liberty: boolean;
  life_or_liberty_reason: string | null;
  intends_to_disclose_third_party_on: string | null;
  third_party_name: string | null;
  third_party_notice_sent_on: string | null;
  third_party_notice_received_on: string | null;
  third_party_representation_on: string | null;
  third_party_objected: boolean | null;
  third_party_representation_note: string | null;
  state: string;
  decision: string | null;
  decided_on: string | null;
  decision_reasons: string | null;
  reply_correspondence_id: string | null;
  reply_despatched_on: string | null;
  due_on: string;
  closed_at: string | null;
  closure_note: string | null;
}

export interface RtiOfficeHolder {
  fullName: string;
  designation: string | null;
}

export interface RtiFile {
  request: RtiRequest | null;
  clock: RtiClock;
  exemptions: Array<{ id: string; section: string; applies_to: string; reasoning: string }>;
  cases: Array<{ case_file_id: string; case_number: string; summary: string; note: string | null }>;
  letters: Array<{
    id: string;
    kind: string;
    subject: string;
    sent_at: string | null;
    despatch_no: string | null;
  }>;
  documents: Array<{ id: string; title: string; document_class: string; status: string }>;
  followups: Array<{ id: string; stage: string; status: string; due_on: string; title: string }>;
  officers: { pio: RtiOfficeHolder | null; firstAppellateAuthority: RtiOfficeHolder | null };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function forwardedCookies(): Promise<string> {
  const jar = await cookies();
  return jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

async function get<T>(path: string): Promise<T> {
  const cookie = await forwardedCookies();
  const res = await fetch(`${API_URL}/v1${path}`, {
    headers: cookie ? { cookie } : {},
    // The register changes as the officer works; never serve a stale queue.
    cache: 'no-store',
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body || res.statusText);
  }
  return res.json() as Promise<T>;
}

export function fetchToday(): Promise<TodayResponse> {
  return get<TodayResponse>('/queue');
}

export function fetchSession(): Promise<Session> {
  return get<Session>('/auth/me');
}

export function fetchCases(): Promise<{ cases: CaseListRow[] }> {
  return get<{ cases: CaseListRow[] }>('/cases');
}

export function fetchCase(id: string): Promise<CaseDetail> {
  return get<CaseDetail>(`/cases/${id}`);
}

export function fetchTemplates(): Promise<{ templates: TemplateRow[] }> {
  return get<{ templates: TemplateRow[] }>('/templates');
}

export function fetchRegister(fiscalYear?: string): Promise<{ rows: RegisterRow[] }> {
  const q = fiscalYear ? `?fiscalYear=${encodeURIComponent(fiscalYear)}` : '';
  return get<{ rows: RegisterRow[] }>(`/register${q}`);
}

export interface TrayCard {
  id: string;
  subject: string;
  snippet: string;
  envelope_from: string;
  envelope_from_name: string | null;
  envelope_date: string;
  ingested_at: string;
  forward_kind: string;
  original_from: string | null;
  original_from_name: string | null;
  original_subject: string | null;
  original_date_text: string | null;
  status: string;
  suggestion_note: string | null;
  suggested_case_file_id: string | null;
  suggested_case_number: string | null;
  attachment_count: number;
  skipped_count: number;
}

export interface TrayMessage {
  message: (TrayCard & {
    body_text: string | null;
    original_body: string | null;
    original_to: string | null;
    envelope_to: string | null;
    message_id: string | null;
    matched_rung: string | null;
    case_file_id: string | null;
    case_number: string | null;
    dismissed_reason: string | null;
  }) | null;
  attachments: Array<{
    id: string;
    filename: string;
    declared_type: string | null;
    size_bytes: number;
    sha256: string;
    document_id: string | null;
    skipped_reason: string | null;
  }>;
  candidates: Array<{
    caseFileId: string;
    caseNumber: string;
    summary: string;
    isClosed: boolean;
    onHold: boolean;
    because: string;
  }>;
}

export interface RespondentCandidate {
  partyId: string;
  fullName: string;
  registrationNo: string | null;
  clinicName: string | null;
  email: string | null;
  mobile: string | null;
  priorCases: number;
  /** WHICH cases — two dentists sharing a name are otherwise indistinguishable. */
  priorCaseNumbers: string[];
  registeredDentistId: string | null;
  because: string;
}

export function fetchTray(status = 'unfiled'): Promise<{ status: string; messages: TrayCard[] }> {
  return get<{ status: string; messages: TrayCard[] }>(`/intake?status=${status}`);
}

export function fetchTrayMessage(id: string): Promise<TrayMessage> {
  return get<TrayMessage>(`/intake/${id}`);
}

export function fetchRtiRegister(): Promise<{ requests: Array<RtiRequest & { clock: RtiClock }> }> {
  return get<{ requests: Array<RtiRequest & { clock: RtiClock }> }>('/rti');
}

export function fetchRtiFile(id: string): Promise<RtiFile> {
  return get<RtiFile>(`/rti/${id}`);
}

export function fetchRtiOfficers(): Promise<{
  pio: RtiOfficeHolder | null;
  firstAppellateAuthority: RtiOfficeHolder | null;
}> {
  return get<{ pio: RtiOfficeHolder | null; firstAppellateAuthority: RtiOfficeHolder | null }>(
    '/rti/officers',
  );
}

/** True when the failure is "sign in", rather than "something broke". */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}
