import { clientIp, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) =>
  services.documents.downloadUrl(tx, ctx, {
    documentId: params.id,
    // Recorded on the access log, which is the only account of where a signed link went.
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent'),
  }),
);
