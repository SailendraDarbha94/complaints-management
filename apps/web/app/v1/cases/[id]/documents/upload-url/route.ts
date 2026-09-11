import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Step one. The browser then PUTs the bytes straight to storage, not through here. */
export const POST = withAuth<{ id: string }>(async ({ req, services }) => {
  // The content type is a query parameter, not a body field: the ticket is signed against
  // it, and the case the file is destined for is not decided until commit.
  const contentType = req.nextUrl.searchParams.get('contentType') ?? undefined;
  return services.documents.requestUpload(contentType ?? 'application/octet-stream');
});
