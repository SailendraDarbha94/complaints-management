import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The register as a file.
 *
 * This is what an RTI reply is assembled from, what a court is shown, and the artefact
 * that means the book survives this project ending. `no-store` because it is the whole
 * register of a quasi-judicial body and has no business sitting in a proxy cache.
 *
 * Returns a Response rather than a value, because it is not JSON and because the
 * content-disposition header is what makes the browser save it instead of rendering it.
 */
export const GET = withAuth(async ({ req, tx, ctx, services }) => {
  const fiscalYear = req.nextUrl.searchParams.get('fiscalYear') ?? undefined;
  const out = await services.register.csv(tx, ctx, { fiscalYear });

  return new Response(out.content, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${out.filename}"`,
      'cache-control': 'private, no-store',
    },
  });
});
