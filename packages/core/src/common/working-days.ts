/**
 * Council-local date arithmetic.
 *
 * Deadlines are DATES, not timestamps. The domain speaks in days — "give them seven
 * days" — and a plain date makes working-day arithmetic and overdue counts correct with
 * no DST reasoning anywhere. Every function here takes and returns an ISO date string
 * (`YYYY-MM-DD`) in the council's own calendar.
 *
 * Dates are manipulated through UTC internally so the host machine's timezone can never
 * shift a due date. A server in Mumbai and a laptop in London must compute the same
 * deadline for the same case.
 */

export type IsoDate = string; // 'YYYY-MM-DD'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(d: string): asserts d is IsoDate {
  if (!DATE_RE.test(d)) throw new Error(`Expected a YYYY-MM-DD date, got "${d}"`);
}

function toUtc(d: IsoDate): Date {
  assertIsoDate(d);
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, day));
}

function fromUtc(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

/** ISO weekday: Monday = 1 … Sunday = 7, matching Postgres `isodow`. */
export function isoWeekday(d: IsoDate): number {
  const day = toUtc(d).getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

/** Today in a given IANA timezone, as the council would write it on a file. */
export function todayIn(timezone: string, now: Date = new Date()): IsoDate {
  // 'en-CA' formats as YYYY-MM-DD, which is exactly the shape we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addCalendarDays(from: IsoDate, days: number): IsoDate {
  const d = toUtc(from);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

export interface Calendar {
  /** ISO weekday numbers the office is open. KSDC: Monday to Saturday. */
  workingWeekdays: readonly number[];
  /** Government holidays as ISO dates. */
  holidays: readonly string[];
}

export function isWorkingDay(date: IsoDate, cal: Calendar): boolean {
  if (cal.holidays.includes(date)) return false;
  return cal.workingWeekdays.includes(isoWeekday(date));
}

/**
 * Add `days` working days. Zero returns the next working day on or after `from` — a
 * follow-up raised on a Sunday is due on Monday, not on Sunday.
 */
export function addWorkingDays(from: IsoDate, days: number, cal: Calendar): IsoDate {
  if (days < 0) throw new Error('addWorkingDays does not go backwards');
  if (cal.workingWeekdays.length === 0) {
    throw new Error('Calendar has no working weekdays; every deadline would be unreachable');
  }

  let cursor = from;
  let remaining = days;

  while (!isWorkingDay(cursor, cal)) cursor = addCalendarDays(cursor, 1);
  while (remaining > 0) {
    cursor = addCalendarDays(cursor, 1);
    if (isWorkingDay(cursor, cal)) remaining--;
  }
  return cursor;
}

export function addDaysByBasis(
  from: IsoDate,
  days: number,
  basis: 'working_days' | 'calendar_days',
  cal: Calendar,
): IsoDate {
  return basis === 'working_days' ? addWorkingDays(from, days, cal) : addCalendarDays(from, days);
}

/** Whole days between two dates. Negative when `b` is before `a`. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

/**
 * How overdue something is, in days. Zero on the due date, positive after it.
 * Never negative — "3 days early" is not a thing the dashboard needs to say.
 */
export function daysOverdue(dueOn: IsoDate, today: IsoDate): number {
  return Math.max(0, daysBetween(dueOn, today));
}

export function isBefore(a: IsoDate, b: IsoDate): boolean {
  assertIsoDate(a);
  assertIsoDate(b);
  return a < b; // ISO dates sort lexicographically
}
