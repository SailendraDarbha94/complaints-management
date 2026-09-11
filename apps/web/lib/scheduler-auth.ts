import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { ForbiddenError, isProduction } from '@ksdc/core';

/**
 * Who is allowed to run the council's daily job.
 *
 * This previously accepted ANY header beginning with "Bearer ", on the reasoning that
 * Cloud Run would have verified an OIDC token before the request arrived. Two things were
 * wrong with that. The check was presented in its own comment as verifying the token, so
 * nobody reading it would look closer. And it is only true on one deployment: run the same
 * code anywhere that does not terminate OIDC - a laptop, a preview, a different host, or
 * Cloud Run with authentication not required - and `Authorization: Bearer x` from anyone
 * on the internet runs the job. Confirmed against the running app: 403 with no header,
 * 200 with "Bearer totally-made-up".
 *
 * The job is not catastrophic to trigger - it is idempotent, claims the day, and skips if
 * already run - but it sends the officer's digest and moves the escalation ladder, so a
 * stranger should not be able to fire it, and certainly not repeatedly.
 *
 * A shared secret compared in constant time, then. It does not depend on the deployment
 * terminating anything, it is verifiable from a test, and its absence in production is a
 * refusal rather than an open door.
 */
export function assertScheduler(req: NextRequest): void {
  const expected = process.env.SCHEDULER_SECRET;

  if (expected) {
    const offered = req.headers.get('x-scheduler-secret') ?? bearer(req);
    if (offered && constantTimeEquals(offered, expected)) return;
    throw new ForbiddenError('This endpoint is called by the scheduler, not by a person.');
  }

  // No secret configured. That is a misconfiguration in production and must never be a
  // pass; in development it lets the tick be fired by hand.
  if (isProduction()) {
    throw new ForbiddenError(
      'SCHEDULER_SECRET is not set, so the daily job cannot be authenticated and will ' +
        'not run. Set it on the service and on whatever calls it.',
    );
  }
  if (req.headers.get('x-dev-scheduler') === '1') return;

  throw new ForbiddenError('This endpoint is called by the scheduler, not by a person.');
}

function bearer(req: NextRequest): string | null {
  const auth = req.headers.get('authorization');
  return auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() || null : null;
}

/** Length is not secret; the bytes are. Compare padded so the length does not leak either. */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  const width = Math.max(ab.length, bb.length);
  const pa = Buffer.alloc(width);
  const pb = Buffer.alloc(width);
  ab.copy(pa);
  bb.copy(pb);
  return timingSafeEqual(pa, pb) && ab.length === bb.length;
}
