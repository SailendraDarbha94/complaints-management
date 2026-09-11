import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Compose the reply.
 *
 * Always returns a draft, even a defective one, along with the list of what is wrong with
 * it. An officer who cannot get a letter out of the system writes it in Word instead, and
 * then none of the rest of this exists.
 */
export const POST = withAuth<{ id: string }>(async ({ params, tx, ctx, services }) => {
  return services.rti.composeReply(tx, ctx, { rtiRequestId: params.id });
});
