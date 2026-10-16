import { clientIp, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A short-lived link to one document on a case.
 *
 * Two callers, two answers. A script or the phone app asks for JSON ({ url, expiresAt,
 * filename }) and follows the link itself. A browser opening a paper from the case page
 * wants the file: given the JSON it showed a line of text, which is what the officer saw
 * when they pressed "Open". So a link the website renders adds `?open=1` (documentOpenHref
 * in lib/document-link.ts), and that answers with a redirect to the signed link instead.
 *
 * Either way the link is issued by downloadUrl(), which writes the access-log row before
 * anything is returned - the log is the only account of where a signed link went, and an
 * open from the case page is no less a link leaving our control than an API call.
 */
export const GET = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const link = await services.documents.downloadUrl(tx, ctx, {
    documentId: params.id,
    // Recorded on the access log, which is the only account of where a signed link went.
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent'),
  });

  if (new URL(req.url).searchParams.get('open') === '1') {
    return new Response(null, {
      status: 302,
      headers: {
        location: link.url,
        // The link expires in minutes and each one is logged as issued: a cached redirect
        // would hand out a dead link, or one that was never logged for this open.
        'cache-control': 'no-store',
        // The signed link carries its own authority; it should not travel on as a referrer.
        'referrer-policy': 'no-referrer',
      },
    });
  }
  return link;
});
