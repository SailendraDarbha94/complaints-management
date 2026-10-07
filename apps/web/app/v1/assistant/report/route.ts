import { z } from 'zod';
import { todayIn } from '@ksdc/core';
import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * How the mail assistant did in a month: how many suggestions, how often what the officer
 * did matched them, what it cost, and the latest cases where it was wrong.
 *
 * ?month=YYYY-MM, defaulting to the current month in the Council's own calendar. A read
 * like the tray itself, so open to anyone who can read the tray.
 */
const query = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month as YYYY-MM.')
  .optional();

export const GET = withAuth(async ({ req, tx, ctx, services }) => {
  const month =
    query.parse(new URL(req.url).searchParams.get('month') || undefined) ??
    todayIn(ctx.config.calendar.timezone).slice(0, 7);
  return services.assistant.report(tx, ctx, month);
});
