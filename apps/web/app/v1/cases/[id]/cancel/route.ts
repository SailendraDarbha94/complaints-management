import { z } from 'zod';
import { ForbiddenError } from '@ksdc/core';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cancel a case opened in error - what the officer's "delete" became.
 *
 * Nothing is deleted. The case keeps its number, drops off every working list, and stays
 * in the register marked cancelled with the reason given here; POST ../restore undoes it.
 *
 * The reason is only type-checked here, not required: a missing or two-letter reason is a
 * domain rule rather than a malformed request, and the service refuses it with a sentence
 * the officer can act on instead of "reason: Required".
 */
const schema = z.object({
  reason: z
    .string()
    .max(1000, 'Keep the reason to a sentence or two. It is printed in the register.')
    .optional(),
});

export const POST = withAuth<{ id: string }>(
  async ({ req, params, tx, ctx, identity, services }) => {
    // Officer only, said here rather than left to the screens. A committee member is
    // read-only everywhere, and taking a numbered case off every list is the last thing
    // that should be reachable with a member's token and a curl command.
    if (identity.role !== 'officer') {
      throw new ForbiddenError('Only the dental officer can cancel a case.');
    }
    const body = schema.parse(await jsonBody(req));
    return services.lifecycle.cancel(tx, ctx, {
      caseFileId: params.id,
      reason: body.reason ?? '',
    });
  },
);
