import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One application, and everything hanging off it: the clock, the grounds cited, the cases
 * it concerns, its letters, its documents and its live timers.
 *
 * One call feeds the whole screen. A detail screen that fires six requests is six chances
 * to render half a file, and this is the screen the officer reads before deciding whether
 * to refuse a statutory request.
 */
export const GET = withAuth<{ id: string }>(async ({ params, tx, ctx, services }) => {
  const file = await services.rti.get(tx, ctx, params.id);
  return file ?? { request: null };
});
