/**
 * A date the officer typed, as the moment the register records.
 *
 * One function for every form that asks "when did it go out": the "I have sent this" step
 * of the composer, and the "Issue a notice" form for a notice sent outside the software.
 * Two copies of this would drift, and then the same letter typed in on the same day would
 * start its deadline from two different moments depending on which button was pressed.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether the text is a bare calendar date (YYYY-MM-DD) rather than a full timestamp. */
export function isBareDate(value: string): boolean {
  return DATE_ONLY.test(value);
}

/**
 * Whether the text is a real day or moment. A bare date is checked as a calendar day, not
 * left to the Date parser: that rolls 30 February over into 2 March without complaint, and
 * a notice would then be recorded on a day nobody typed.
 */
export function isRealDate(value: string): boolean {
  if (isBareDate(value)) {
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }
  return value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

/**
 * The timestamp for a typed date. A bare date means "that day", read in the council's own
 * calendar rather than the browser's: an officer in Bengaluru confirming at 11pm meant
 * today, not tomorrow. 06:00 UTC is midday in Bengaluru, safely inside the day either way.
 * Anything else is taken as the timestamp it already is.
 */
export function timestampOfTypedDate(value: string): Date {
  return new Date(isBareDate(value) ? `${value}T06:00:00Z` : value);
}

/**
 * Whether a typed date has not come yet. A bare date is compared with today in the
 * council's calendar (YYYY-MM-DD), not with the 06:00 UTC moment it becomes - otherwise a
 * notice typed in at 9am in Bengaluru as sent today would be refused as in the future.
 */
export function isInTheFuture(value: string, today: string, now: Date = new Date()): boolean {
  return isBareDate(value) ? value > today : Date.parse(value) > now.getTime();
}
