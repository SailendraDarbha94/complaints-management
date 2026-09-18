import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Put a dismissed message back in the tray. Setting something aside is not final. */
export const POST = withAuth<{ id: string }>(async ({ params, tx, ctx, services }) => {
  await services.mail.restore(tx, ctx, { mailMessageId: params.id });
  return { restored: true };
});
