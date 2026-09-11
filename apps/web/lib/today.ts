/**
 * Today, in the council's own calendar.
 *
 * Every date a form defaults to is a council-local date, not the browser's. An officer in
 * Bengaluru at half past midnight and a server running in UTC must agree about what day it
 * is, because these dates start statutory periods.
 */
export const today: string = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
