import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth<{ id: string }>(async ({ params, tx, ctx, services }) => ({
  documents: await services.documents.listForCase(tx, ctx, params.id),
}));
