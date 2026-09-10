/**
 * The web app is a thin client over the Nest API (build plan D7/§12). It holds no
 * database credentials and does no data access of its own: one place enforces row-level
 * security, and it is not this one.
 */

const API_URL = process.env.API_URL ?? 'http://localhost:8080';

/**
 * Development identity. Passwordless email OTP is the next piece of Phase 1; until it
 * lands the API accepts these headers, and only when NODE_ENV is not production.
 */
const DEV_COUNCIL_ID = process.env.DEV_COUNCIL_ID ?? '';
const DEV_USER_ID = process.env.DEV_USER_ID ?? '';

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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}/v1${path}`, {
    headers: {
      'x-dev-council-id': DEV_COUNCIL_ID,
      'x-dev-user-id': DEV_USER_ID,
    },
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
