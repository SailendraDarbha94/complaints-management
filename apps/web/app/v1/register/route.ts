import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth(async ({ req, tx, ctx, services }) => {
  const fiscalYear = req.nextUrl.searchParams.get('fiscalYear') ?? undefined;
  const includeClosed = req.nextUrl.searchParams.get('includeClosed');
  return {
    rows: await services.register.rows(tx, ctx, {
      fiscalYear,
      includeClosed: includeClosed !== 'false',
    }),
  };
});
