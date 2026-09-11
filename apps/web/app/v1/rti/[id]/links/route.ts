import { z } from 'zod';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Which cases an application concerns. Optional, many-to-many, and usually none. */
const linkSchema = z.object({
  caseFileId: z.string().uuid(),
  note: z.string().trim().nullish(),
});

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const body = linkSchema.parse(await jsonBody(req));
  await services.rti.linkCase(tx, ctx, {
    rtiRequestId: params.id,
    caseFileId: body.caseFileId,
    note: body.note ?? null,
  });
  return { linked: true };
});
