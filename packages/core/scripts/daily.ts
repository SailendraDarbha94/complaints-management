/**
 * The daily tick, as a process rather than an HTTP call.
 *
 *   pnpm --filter @ksdc/core daily
 *
 * The route handler at /v1/internal/jobs/daily does the same thing and is what Cloud
 * Scheduler calls today. This exists for three reasons: running it by hand needs no
 * server; a Cloud Run Job is a better home for it than a request that must finish inside
 * the request timeout; and if the database moves to a host whose scheduler cannot make an
 * authenticated HTTPS call, a scheduled container still can.
 *
 * The claim is taken inside scheduler.run(), so running this while the HTTP endpoint also
 * fires is safe: the second one finds the day already claimed and skips.
 */
import { closeDb } from '@ksdc/db';
import { todayIn } from '../src/common/working-days.js';
import { getServices } from '../src/services.js';
import { Logger } from '../src/common/logger.js';
import { isMainModule } from './is-main.js';

const log = new Logger('daily');

export async function daily(): Promise<void> {
  const { scheduler } = await getServices();
  const now = new Date();
  const logicalDate = todayIn('Asia/Kolkata', now);

  const outcome = await scheduler.run('daily', logicalDate, () => scheduler.daily(now));
  log.log(JSON.stringify({ logicalDate, ...outcome }));

  // A failed run must not exit 0, or the scheduler records a success and nobody is told
  // that the ladder did not move today.
  if (outcome.status === 'failed') process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  daily()
    .then(() => closeDb())
    .catch(async (err) => {
      log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      await closeDb();
      process.exit(1);
    });
}
