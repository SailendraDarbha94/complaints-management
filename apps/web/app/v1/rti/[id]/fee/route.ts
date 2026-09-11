import { z } from 'zod';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD.');

/**
 * The further fee: the only lawful way to stop the clock (s.7(3)(a)).
 *
 * Two acts on one endpoint because they are two halves of one thing - the excluded period
 * has no meaning until both dates exist, and the deadline cannot be computed from one of
 * them alone.
 */
const feeSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('intimate'),
    amount: z.number().positive('The amount demanded, in rupees.'),
    intimatedOn: ISO_DATE,
  }),
  z.object({ action: z.literal('paid'), paidOn: ISO_DATE }),
]);

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const body = feeSchema.parse(await jsonBody(req));
  return body.action === 'intimate'
    ? services.rti.intimateFurtherFee(tx, ctx, {
        rtiRequestId: params.id,
        amount: body.amount,
        intimatedOn: body.intimatedOn,
      })
    : services.rti.recordFeePaid(tx, ctx, { rtiRequestId: params.id, paidOn: body.paidOn });
});
