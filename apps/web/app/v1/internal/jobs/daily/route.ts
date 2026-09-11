import type { NextRequest } from 'next/server';
import { ForbiddenError, isProduction, todayIn } from '@ksdc/core';
import { withPublic } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cloud Scheduler calls this over authenticated HTTPS (OIDC). It is not part of the
 * public API surface and is never reachable from the browser app.
 */

// Called by Cloud Scheduler with an OIDC token, not by a signed-in person.
export const POST = withPublic(
  'Called by Cloud Scheduler with an OIDC token rather than a user session; the bearer ' +
    'token is the authority and is checked by assertScheduler below.',
  async ({ req, services }) => {
    assertScheduler(req);
    const now = new Date();
    const logicalDate = todayIn('Asia/Kolkata', now);
    return services.scheduler.run('daily', logicalDate, () => services.scheduler.daily(now));
  },
);

/**
 * Cloud Run verifies the OIDC token before the request reaches us when the service
 * requires authentication, so this is a second check rather than the only one. In
 * development it accepts a shared secret so the tick can be fired by hand.
 */
function assertScheduler(req: NextRequest): void {
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return;

  if (!isProduction() && req.headers.get('x-dev-scheduler') === '1') return;

  throw new ForbiddenError('This endpoint is called by Cloud Scheduler, not by a person.');
}
