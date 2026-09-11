import { Logger } from '../../common/logger.js';
import { sql } from 'drizzle-orm';
import { getDb, withCouncil, type Tx } from '@ksdc/db';
import { parseCouncilConfig } from '@ksdc/config';
import { FollowupService } from '../followups/followup.service.js';
import { DigestService } from '../notifications/digest.service.js';
import { todayIn } from '../../common/working-days.js';

/**
 * The reminder ticker.
 *
 * There is no in-process cron: Cloud Run scales to zero and throttles CPU between
 * requests, so a setInterval would fire unpredictably or not at all. Cloud Scheduler
 * calls an authenticated endpoint instead, and every job goes through `run()`, which owns
 * the job_run row, the idempotency guard and the structured log line.
 *
 * A job cannot be added without that bookkeeping, which is deliberate: a silently dead
 * ticker recreates the exact pain this product exists to remove.
 */
export class SchedulerService {
  private readonly log = new Logger('scheduler');

  constructor(
    private readonly followups: FollowupService,
    private readonly digest: DigestService,
  ) {}

  /**
   * `(job_name, logical_date)` is unique, so a retried Cloud Scheduler delivery cannot
   * double-fire. The logical date is the council-local date the run is FOR, not the
   * wall-clock moment it happened to execute.
   */
  async run<T>(
    jobName: string,
    logicalDate: string,
    fn: () => Promise<T>,
  ): Promise<{ status: 'ok' | 'skipped' | 'failed'; result?: T; error?: string }> {
    const db = getDb();

    // Claim the day, but let a FAILED run be re-claimed.
    //
    // A plain DO NOTHING would make a failed job unretryable: the row already holds the
    // day, and the application role has no DELETE grant anywhere, so nothing can release
    // it. A day whose escalations silently never happened, and cannot be made to happen,
    // is precisely the failure this system exists to prevent.
    const claimed = await db.execute<{ id: string }>(sql`
      INSERT INTO job_run (job_name, logical_date, status, started_at)
      VALUES (${jobName}, ${logicalDate}::date, 'running', now())
      ON CONFLICT (job_name, logical_date) DO UPDATE
        SET status = 'running', started_at = now(), error = NULL
        WHERE job_run.status = 'failed'
      RETURNING id
    `);

    if (claimed.rows.length === 0) {
      this.log.log(JSON.stringify({ job: jobName, logicalDate, status: 'skipped' }));
      return { status: 'skipped' };
    }

    const runId = claimed.rows[0]!.id;
    try {
      const result = await fn();
      await db.execute(sql`
        UPDATE job_run SET status = 'ok', finished_at = now(), stats = ${JSON.stringify(result)}::jsonb
        WHERE id = ${runId}::uuid
      `);
      // The shape Cloud Monitoring's metric-absence alert watches for.
      this.log.log(JSON.stringify({ job: jobName, logicalDate, status: 'ok', ...result }));
      return { status: 'ok', result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.execute(sql`
        UPDATE job_run SET status = 'failed', finished_at = now(), error = ${message}
        WHERE id = ${runId}::uuid
      `);
      this.log.error(JSON.stringify({ job: jobName, logicalDate, status: 'failed', error: message }));
      return { status: 'failed', error: message };
    }
  }

  /**
   * Every council with a configuration row. One today; the loop costs nothing.
   *
   * This is the one place the scheduler reads across councils, and it must: choosing a
   * council scope is what the query is for. `app.scheduler_scan` unlocks an additive
   * SELECT policy on council_config and nothing else (migration 0004), set
   * transaction-locally so a pooled connection cannot carry it anywhere.
   *
   * Without it this returned zero rows and the whole daily job did nothing while
   * reporting success -- see the migration for the full account.
   */
  private async councils(): Promise<Array<{ id: string; config: ReturnType<typeof parseCouncilConfig> }>> {
    const db = getDb();
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.scheduler_scan', 'on', true)`);
      return tx.execute<{ council_id: string; config: unknown }>(
        sql`SELECT council_id, config FROM council_config`,
      );
    });

    if (rows.rows.length === 0) {
      // Silence here would mean silence everywhere. Say so loudly rather than returning
      // a cheerful zero.
      this.log.error(
        'No councils found to process. Either none is configured, or the scheduler scan ' +
          'policy is missing (migration 0004).',
      );
    }
    return rows.rows.map((r) => ({ id: r.council_id, config: parseCouncilConfig(r.config) }));
  }

  /**
   * The daily tick: wake expired snoozes, escalate what is overdue, and flag any open
   * case that nobody is chasing.
   */
  async daily(now: Date = new Date()): Promise<Record<string, number>> {
    const totals = {
      woken: 0,
      escalated: 0,
      proposals: 0,
      flagged: 0,
      cleared: 0,
      digestsSent: 0,
      digestsSkipped: 0,
      digestsFailed: 0,
    };

    for (const council of await this.councils()) {
      const logicalDate = todayIn(council.config.calendar.timezone, now);

      await withCouncil({ councilId: council.id }, async (tx: Tx) => {
        const ctx = { councilId: council.id, userId: null, config: council.config };

        // Order matters: escalate and sweep first, so the digest reports the queue as it
        // stands after the engine has run, not as it stood yesterday evening.
        const tick = await this.followups.tick(tx, ctx, now);
        const sweep = await this.followups.sweepNoNextStep(tx, ctx, now);
        totals.woken += tick.woken;
        totals.escalated += tick.escalated;
        totals.proposals += tick.proposals;
        totals.flagged += sweep.flagged;
        totals.cleared += sweep.cleared;

        // A send failure is recorded against the recipient and counted, not thrown: one
        // officer's bouncing address must not roll back another council's escalations.
        // `digestsFailed` reaching the structured log line is what the alert watches.
        const digest = await this.digest.sendDaily(tx, ctx, logicalDate);
        totals.digestsSent += digest.sent;
        totals.digestsSkipped += digest.skipped;
        totals.digestsFailed += digest.failed;
      });
    }

    return totals;
  }
}
