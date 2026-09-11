import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The Today screen's API. One endpoint the officer's morning depends on.
 */
export const GET = withAuth(async ({ tx, ctx, services }) => {
  const today = services.followups.today(ctx.config);
  const [queue, ticker] = await Promise.all([
    services.queue.today(tx, ctx, today),
    services.queue.tickerHealth(tx),
  ]);
  // The banner ships with the queue, not on a separate call: a dead ticker is the one
  // thing the officer must never have to go looking for.
  return { ...queue, ticker };
});
