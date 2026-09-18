import { z } from 'zod';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** File a message onto a case that already exists. Attachments go on with it. */
const schema = z.object({ caseFileId: z.string().uuid() });

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const { caseFileId } = schema.parse(await jsonBody(req));
  return services.mail.fileOnCase(tx, ctx, { mailMessageId: params.id, caseFileId });
});
