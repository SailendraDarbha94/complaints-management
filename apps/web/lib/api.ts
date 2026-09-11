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

/** True when the failure is "sign in", rather than "something broke". */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}
