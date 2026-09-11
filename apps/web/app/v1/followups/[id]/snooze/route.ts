import { z } from 'zod';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date, as YYYY-MM-DD.'),
});

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const { until } = schema.parse(await jsonBody(req));
  await services.followups.snooze(tx, ctx, { followUpId: params.id, until });
  return { ok: true };
});
