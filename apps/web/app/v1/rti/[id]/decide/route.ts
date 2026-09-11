import { z } from 'zod';
import { RTI_DECISIONS, RTI_EXEMPTION_SECTIONS } from '@ksdc/contracts';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD.');

/**
 * The decision and the grounds, together, in one transaction.
 *
 * `section` is constrained to the enum, which contains s.8(1)(a) to (j) and s.9 and
 * nothing else. There is no code here rejecting section 11: it is not a value that exists,
 * so a refusal under it cannot be expressed at all.
 */
const decideSchema = z.object({
  decision: z.enum(RTI_DECISIONS),
  decidedOn: ISO_DATE,
  reasons: z.string().trim().nullish(),
  exemptions: z
    .array(
      z.object({
        section: z.enum(RTI_EXEMPTION_SECTIONS),
        appliesTo: z.string().trim().min(1, 'Which part of the request this answers.'),
        reasoning: z.string().trim().min(1, 'Why, on these facts. s.7(8)(i) asks for reasons.'),
      }),
    )
    .optional(),
});

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const body = decideSchema.parse(await jsonBody(req));
  return services.rti.decide(tx, ctx, { rtiRequestId: params.id, ...body });
});
