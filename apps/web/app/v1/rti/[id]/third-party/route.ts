import { z } from 'zod';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD.');

/**
 * The three steps of s.11, in the order the Act puts them.
 *
 * `intend` is the statutory trigger and has to come first: s.11(1) is engaged by an
 * intention to disclose third-party information, not by a third party appearing in the
 * file. The service refuses a notice without it, so the order is enforced rather than
 * merely suggested by the shape of the screen.
 */
const thirdPartySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('intend'),
    thirdPartyName: z.string().trim().min(1, 'Who the third party is.'),
    decidedOn: ISO_DATE,
  }),
  z.object({
    action: z.literal('notice'),
    sentOn: ISO_DATE,
    /** THEIR receipt, from the acknowledgement card. The ten days runs from here. */
    receivedOn: ISO_DATE.nullish(),
  }),
  z.object({
    action: z.literal('representation'),
    receivedOn: ISO_DATE,
    objected: z.boolean(),
    note: z.string().trim().nullish(),
  }),
]);

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const body = thirdPartySchema.parse(await jsonBody(req));
  const rtiRequestId = params.id;

  if (body.action === 'intend') {
    return services.rti.intendToDiscloseThirdParty(tx, ctx, {
      rtiRequestId,
      thirdPartyName: body.thirdPartyName,
      decidedOn: body.decidedOn,
    });
  }
  if (body.action === 'notice') {
    return services.rti.recordThirdPartyNotice(tx, ctx, {
      rtiRequestId,
      sentOn: body.sentOn,
      receivedOn: body.receivedOn ?? null,
    });
  }
  return services.rti.recordThirdPartyRepresentation(tx, ctx, {
    rtiRequestId,
    receivedOn: body.receivedOn,
    objected: body.objected,
    note: body.note ?? null,
  });
});
