import { z } from 'zod';
import { ForbiddenError } from '@ksdc/core';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Reject the mail assistant's suggestion. Nothing in the register changes: the message
 * stays in the tray for the officer to deal with by hand.
 *
 * The note is optional and is the most useful thing the officer can leave - "this is a
 * reply on 0012, not a new complaint" is what shows why the assistant was wrong when the
 * month's disagreements are read back.
 */
const schema = z.object({
  note: z.string().trim().max(1000, 'Keep the note to a sentence or two.').optional(),
});

export const POST = withAuth<{ id: string }>(
  async ({ req, params, tx, ctx, identity, services }) => {
    if (identity.role !== 'officer') {
      throw new ForbiddenError('Only the dental officer can act on a suggestion.');
    }
    const { note } = schema.parse(await jsonBody(req));
    return services.assistant.reject(tx, ctx, params.id, note ?? null);
  },
);
