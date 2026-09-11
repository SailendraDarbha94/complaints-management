import { todayIn } from '@ksdc/core';
import { withPublic } from '@/lib/route';
import { assertScheduler } from '@/lib/scheduler-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The daily tick: escalate the notice ladder, send the digest.
 *
 * Called by a scheduler, not by a person, so it carries a shared secret rather than a
 * session.
 */
export const POST = withPublic(
  'Called by the scheduler with a shared secret rather than a user session; the secret ' +
    'is verified in lib/scheduler-auth.ts.',
  async ({ req, services }) => {
    assertScheduler(req);
    const now = new Date();
    const logicalDate = todayIn('Asia/Kolkata', now);
    return services.scheduler.run('daily', logicalDate, () => services.scheduler.daily(now));
  },
);
