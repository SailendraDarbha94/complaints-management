import { z } from 'zod';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The reason is mandatory in the service; the API does not offer a way round it. A
// reminder that simply vanishes is the failure this whole system exists to prevent, so
// the queue records why it went.
const schema = z.object({
  reason: z.string().trim().min(1, 'Say why this reminder should go.').max(2000),
});

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const { reason } = schema.parse(await jsonBody(req));
  await services.followups.dismiss(tx, ctx, { followUpId: params.id, reason });
  return { ok: true };
});
