import { z } from 'zod';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const despatchSchema = z.object({
  despatchNo: z.string().min(1),
  despatchDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  registerPage: z.string().nullish(),
});

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const input = despatchSchema.parse(await jsonBody(req));
  await services.correspondence.recordDespatch(tx, ctx, {
    correspondenceId: params.id,
    despatchNo: input.despatchNo,
    despatchDate: input.despatchDate,
    registerPage: input.registerPage ?? null,
  });
  return { recorded: true };
});
