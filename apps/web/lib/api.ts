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

export const API_URL = process.env.API_URL ?? 'http://localhost:8080';

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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const jar = await cookies();
  const forwarded = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const res = await fetch(`${API_URL}/v1${path}`, {
    headers: forwarded ? { cookie: forwarded } : {},
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

/** True when the failure is "sign in", rather than "something broke". */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}
