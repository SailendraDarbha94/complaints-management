import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  addWorkingDays,
  daysBetween,
  daysOverdue,
  isWorkingDay,
  isoWeekday,
  todayIn,
  type Calendar,
} from './working-days.js';

// KSDC: Monday to Saturday, per the seed. Sunday is the only weekly closure.
const ksdc: Calendar = { workingWeekdays: [1, 2, 3, 4, 5, 6], holidays: [] };
const monToFri: Calendar = { workingWeekdays: [1, 2, 3, 4, 5], holidays: [] };

describe('isoWeekday', () => {
  it('numbers Monday to Sunday as 1 to 7, like Postgres isodow', () => {
    expect(isoWeekday('2026-09-07')).toBe(1); // Monday
    expect(isoWeekday('2026-09-12')).toBe(6); // Saturday
    expect(isoWeekday('2026-09-13')).toBe(7); // Sunday
  });
});

describe('addWorkingDays', () => {
  it('gives a complainant seven working days, skipping Sunday', () => {
    // Thursday 10 Sep 2026 + 7 working days (Mon-Sat) -> Friday 18 Sep.
    // Only Sunday the 13th is skipped.
    expect(addWorkingDays('2026-09-10', 7, ksdc)).toBe('2026-09-18');
  });

  it('skips both weekend days for a Monday-to-Friday council', () => {
    // The same seven days for a council that closes on Saturday too.
    expect(addWorkingDays('2026-09-10', 7, monToFri)).toBe('2026-09-21');
  });

  it('rolls a follow-up raised on a closed day forward to the next open one', () => {
    // Zero days from a Sunday is Monday, not Sunday — a deadline never falls on a day
    // the office is shut.
    expect(addWorkingDays('2026-09-13', 0, ksdc)).toBe('2026-09-14');
    expect(addWorkingDays('2026-09-13', 1, ksdc)).toBe('2026-09-15');
  });

  it('skips declared holidays', () => {
    // Gandhi Jayanti, Friday 2 October 2026.
    const withHoliday: Calendar = { ...ksdc, holidays: ['2026-10-02'] };
    expect(addWorkingDays('2026-10-01', 1, ksdc)).toBe('2026-10-02');
    expect(addWorkingDays('2026-10-01', 1, withHoliday)).toBe('2026-10-03');
  });

  it('skips a run of consecutive holidays', () => {
    // Sunday 8 Nov, with Mon-Wed 9-11 declared holidays. Zero working days lands on the
    // first open day, Thursday the 12th; one working day on from there is Friday the 13th.
    const diwali: Calendar = { ...ksdc, holidays: ['2026-11-09', '2026-11-10', '2026-11-11'] };
    expect(addWorkingDays('2026-11-08', 0, diwali)).toBe('2026-11-12');
    expect(addWorkingDays('2026-11-08', 1, diwali)).toBe('2026-11-13');
  });

  it('refuses to run backwards, and refuses a calendar with no open days', () => {
    expect(() => addWorkingDays('2026-09-10', -1, ksdc)).toThrow(/backwards/);
    expect(() => addWorkingDays('2026-09-10', 1, { workingWeekdays: [], holidays: [] })).toThrow(
      /no working weekdays/,
    );
  });

  it('crosses a month and a year boundary', () => {
    expect(addWorkingDays('2026-12-30', 3, ksdc)).toBe('2027-01-02');
  });

  it('is unaffected by the host machine timezone', () => {
    // The council's deadline must not depend on where the server happens to run. Adding
    // one working day across a date the local calendar might shift.
    const before = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
      const east = addWorkingDays('2026-09-10', 1, ksdc);
      process.env.TZ = 'Pacific/Midway'; // UTC-11
      const west = addWorkingDays('2026-09-10', 1, ksdc);
      expect(east).toBe('2026-09-11');
      expect(west).toBe('2026-09-11');
    } finally {
      process.env.TZ = before;
    }
  });
});

describe('addCalendarDays', () => {
  it('does not skip anything — statutory clocks run on calendar days', () => {
    // An RTI reply is due 30 calendar days on, regardless of Sundays or Diwali.
    expect(addCalendarDays('2026-09-10', 30)).toBe('2026-10-10');
  });

  it('handles a leap year', () => {
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCalendarDays('2028-02-28', 2)).toBe('2028-03-01');
  });
});

describe('isWorkingDay', () => {
  it('is open on a Saturday for KSDC and shut for a Monday-to-Friday council', () => {
    expect(isWorkingDay('2026-09-12', ksdc)).toBe(true);
    expect(isWorkingDay('2026-09-12', monToFri)).toBe(false);
  });

  it('is shut on Sunday for both', () => {
    expect(isWorkingDay('2026-09-13', ksdc)).toBe(false);
    expect(isWorkingDay('2026-09-13', monToFri)).toBe(false);
  });
});

describe('overdue arithmetic', () => {
  it('counts days between dates in both directions', () => {
    expect(daysBetween('2026-09-10', '2026-09-18')).toBe(8);
    expect(daysBetween('2026-09-18', '2026-09-10')).toBe(-8);
  });

  it('reports zero on the due date and never reports being early', () => {
    expect(daysOverdue('2026-09-10', '2026-09-10')).toBe(0);
    expect(daysOverdue('2026-09-10', '2026-09-01')).toBe(0);
    expect(daysOverdue('2026-09-10', '2026-09-19')).toBe(9);
  });
});

describe('todayIn', () => {
  it('reads the date in the council’s own timezone, not the server’s', () => {
    // 2026-09-10 20:30 UTC is already 11 September in Kolkata (UTC+5:30).
    const t = new Date('2026-09-10T20:30:00Z');
    expect(todayIn('Asia/Kolkata', t)).toBe('2026-09-11');
    expect(todayIn('UTC', t)).toBe('2026-09-10');
  });

  it('does not roll over early in the day', () => {
    const t = new Date('2026-09-10T02:00:00Z'); // 07:30 IST
    expect(todayIn('Asia/Kolkata', t)).toBe('2026-09-10');
  });
});
