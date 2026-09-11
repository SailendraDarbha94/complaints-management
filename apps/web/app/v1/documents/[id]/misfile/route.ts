import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  // No schema here, deliberately: a missing reason is a domain rule rather than a shape
  // error, and markMisfiled refuses a blank one with the message the officer should read.
  const body = (await jsonBody(req)) as { reason: string };
  await services.documents.markMisfiled(tx, ctx, { documentId: params.id, reason: body.reason });
  return { withdrawn: true };
});
