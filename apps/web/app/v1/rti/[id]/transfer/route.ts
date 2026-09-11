import { z } from 'zod';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD.');

/** s.6(3). Recorded whatever the date; the warning says who carries the delay. */
const transferSchema = z.object({
  toAuthority: z.string().trim().min(1, 'The authority it is going to.'),
  transferredOn: ISO_DATE,
  note: z.string().trim().optional(),
});

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const body = transferSchema.parse(await jsonBody(req));
  return services.rti.transfer(tx, ctx, { rtiRequestId: params.id, ...body });
});
