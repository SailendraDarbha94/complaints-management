import { todayIn } from '@ksdc/core';
import { caseEventInput } from '@/lib/case-event';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Record something on a case: a button on the case page's "Record what happened".
 *
 * The body is checked against what the engine takes (lib/case-event.ts) before anything is
 * written, so a bad date or a missing service mode is a sentence for the officer rather
 * than "Invalid Date" on its way to the database. "Today" is the council's own day, so a
 * notice typed in as sent today is not refused as in the future by a server in UTC.
 */
export const POST = withAuth<{ id: string; event: string }>(
  async ({ req, params, tx, ctx, services }) => {
    const now = new Date();
    const input = caseEventInput(
      params.event,
      await jsonBody(req),
      todayIn(ctx.config.calendar.timezone, now),
      now,
    );
    return services.lifecycle.apply(tx, ctx, { ...input, caseFileId: params.id });
  },
);
