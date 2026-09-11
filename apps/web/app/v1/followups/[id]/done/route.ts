import { z } from 'zod';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  note: z.string().max(2000).optional(),
  contactEventId: z.string().uuid().optional(),
});

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const body = schema.parse(await jsonBody(req));
  await services.followups.satisfy(tx, ctx, {
    followUpId: params.id,
    contactEventId: body.contactEventId ?? null,
    note: body.note ?? null,
  });
  return { ok: true };
});
