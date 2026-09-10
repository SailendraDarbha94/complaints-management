import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { getDb, withCouncil, type Tx } from '@ksdc/db';
import { parseCouncilConfig } from '@ksdc/config';
import { FollowupService } from '../followups/followup.service.js';
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
@Injectable()
export class SchedulerService {
  private readonly log = new Logger('scheduler');

  constructor(private readonly followups: FollowupService) {}

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

    const claimed = await db.execute<{ id: string }>(sql`
      INSERT INTO job_run (job_name, logical_date, status)
      VALUES (${jobName}, ${logicalDate}::date, 'running')
      ON CONFLICT (job_name, logical_date) DO NOTHING
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

  /** Every council with a configuration row. One today; the loop costs nothing. */
  private async councils(): Promise<Array<{ id: string; config: ReturnType<typeof parseCouncilConfig> }>> {
    const db = getDb();
    // Reads across councils deliberately, as the scheduler must. Row-level security is
    // re-applied per council inside the loop below.
    const rows = await db.execute<{ council_id: string; config: unknown }>(
      sql`SELECT council_id, config FROM council_config`,
    );
    return rows.rows.map((r) => ({ id: r.council_id, config: parseCouncilConfig(r.config) }));
  }

  /**
   * The daily tick: wake expired snoozes, escalate what is overdue, and flag any open
   * case that nobody is chasing.
   */
  async daily(now: Date = new Date()): Promise<Record<string, number>> {
    const totals = { woken: 0, escalated: 0, proposals: 0, flagged: 0, cleared: 0 };

    for (const council of await this.councils()) {
      const logicalDate = todayIn(council.config.calendar.timezone, now);
      await withCouncil({ councilId: council.id }, async (tx: Tx) => {
        const ctx = { councilId: council.id, userId: null, config: council.config };
        const tick = await this.followups.tick(tx, ctx, now);
        const sweep = await this.followups.sweepNoNextStep(tx, ctx, now);
        totals.woken += tick.woken;
        totals.escalated += tick.escalated;
        totals.proposals += tick.proposals;
        totals.flagged += sweep.flagged;
        totals.cleared += sweep.cleared;
      });
      void logicalDate;
    }

    return totals;
  }
}
