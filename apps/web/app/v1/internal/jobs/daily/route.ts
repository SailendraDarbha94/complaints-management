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
    const outcome = await services.scheduler.run('daily', logicalDate, () =>
      services.scheduler.daily(now),
    );

    // A failed run must not answer 200.
    //
    // scheduler.run() catches its own error and RETURNS {status:'failed'} rather than
    // throwing, so that job_run is updated and the failure is logged. Handed straight back,
    // that became a perfectly ordinary JSON body with a 200 beside it - and a scheduler
    // records a success on a day the ladder did not move. Nobody is then told that nothing
    // was escalated and no digest went out, which is the precise failure this whole product
    // exists to prevent. packages/core/scripts/daily.ts already guards the command-line
    // path for exactly this reason ("A failed run must not exit 0"); this is the same guard
    // for the path a scheduler actually calls.
    if (outcome.status === 'failed') {
      return Response.json(outcome, { status: 500 });
    }
    return outcome;
  },
);
