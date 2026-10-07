import { ForbiddenError } from '@ksdc/core';
import { withAuthNoTransaction } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A model call with lookups takes seconds, sometimes tens of them. The engine stops a
// reading at RUN_DEADLINE_MS (150 s, engine.ts) whatever happens; this leaves room above
// that for the two short database scopes, so the reading ends - and its row says why -
// before the platform cuts the request off. (The row is written before the model is
// called, so even a request cut off here is counted against the daily limit.)
export const maxDuration = 180;

/**
 * Ask the mail assistant (again) about a message in the tray.
 *
 * Replaces the suggestion on the card; the old one is kept as superseded, because it cost
 * money and the month's cost has to add up. Refused, with a sentence the officer can act
 * on, when the assistant is switched off (409) or today's limit is spent (429) - and in
 * both cases before any model call, so a refusal costs nothing.
 *
 * NOT withAuth(): that would hold this request's transaction open for the whole model
 * call. The service reads in one short scope, calls the model with none open, and writes
 * in another. See withAuthNoTransaction().
 *
 * Officer only. Each press spends the Council's credits.
 */
export const POST = withAuthNoTransaction<{ id: string }>(
  async ({ params, ctx, identity, services }) => {
    if (identity.role !== 'officer') {
      throw new ForbiddenError('Only the dental officer can ask the assistant.');
    }
    const suggestion = await services.assistant.suggestFor(ctx, params.id);
    return { suggestion };
  },
);
