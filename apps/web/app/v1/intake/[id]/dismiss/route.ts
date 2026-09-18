import { z } from 'zod';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Not a complaint.
 *
 * The message stays; only its status changes. A reason is required because the tray is the
 * record of what the Council received, and a message that could vanish from it without a
 * trace would make the tray evidence of nothing.
 */
const schema = z.object({
  reason: z.string().trim().min(3, 'Say why this is not a complaint.'),
});

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const { reason } = schema.parse(await jsonBody(req));
  await services.mail.dismiss(tx, ctx, { mailMessageId: params.id, reason });
  return { dismissed: true };
});
