import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One message: what arrived, what was unwrapped from it, and which cases it might belong to. */
export const GET = withAuth<{ id: string }>(async ({ params, tx, ctx, services }) => {
  const found = await services.mail.get(tx, ctx, params.id);
  return found ?? { message: null };
});
