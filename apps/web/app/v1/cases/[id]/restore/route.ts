import { ForbiddenError } from '@ksdc/core';
import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Undo a cancellation: the case goes back on every list, in the state it was cancelled
 * in, with the reminders the cancellation stopped. No body - there is nothing to choose.
 *
 * The same officer-only rule as ../cancel. Undoing is as much a change to the register as
 * doing, and a member who could restore a case could also bring back one the officer had
 * cancelled for good reason.
 */
export const POST = withAuth<{ id: string }>(async ({ params, tx, ctx, identity, services }) => {
  if (identity.role !== 'officer') {
    throw new ForbiddenError('Only the dental officer can restore a cancelled case.');
  }
  return services.lifecycle.restore(tx, ctx, { caseFileId: params.id });
});
