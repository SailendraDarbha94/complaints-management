import { z } from 'zod';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD.');

/**
 * "I have sent it." The click that stops the statutory clock.
 *
 * Refused while the letter is still defective, unless a written reason is given. That is
 * the one place this module stops the officer doing something they could physically do,
 * and it is there because an incomplete refusal is not a smaller failure than a late one:
 * it hands the applicant an appeal they win on the face of the document.
 */
const despatchSchema = z.object({
  despatchedOn: ISO_DATE,
  correspondenceId: z.string().uuid().nullish(),
  /** The office-wide outward number, typed in after the letter is stamped. Never minted. */
  despatchNo: z.string().trim().nullish(),
  forceReason: z.string().trim().min(10, 'Say why it is going out as it stands.').nullish(),
});

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const body = despatchSchema.parse(await jsonBody(req));
  return services.rti.recordReplyDespatched(tx, ctx, {
    rtiRequestId: params.id,
    despatchedOn: body.despatchedOn,
    correspondenceId: body.correspondenceId ?? null,
    despatchNo: body.despatchNo ?? null,
    force: body.forceReason ? { reason: body.forceReason } : null,
  });
});
