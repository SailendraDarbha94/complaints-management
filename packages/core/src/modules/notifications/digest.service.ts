import { Logger } from '../../common/logger.js';
import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import type { EngineContext } from '../followups/followup.service.js';
import { QueueService, type TodayQueue } from '../followups/queue.service.js';
import { isWorkingDay, type IsoDate } from '../../common/working-days.js';
import { MailerPort } from './mailer.js';

/**
 * The daily digest.
 *
 * One email, at 09:00 in the council's own time, to the officer's own address.
 *
 * Explicitly NOT to registrar@ksdc.in. That is where complaints arrive, and it is the
 * pile the officer is escaping; the mailer refuses to send there at all.
 *
 * It goes out on every working day, including days when there is nothing to do. An empty
 * digest is not noise — it is the daily proof that the reminder engine is alive. Sending
 * only when there is news makes silence ambiguous, and ambiguous silence is exactly the
 * failure this product exists to remove.
 */

export interface DigestResult {
  councilId: string;
  recipients: number;
  sent: number;
  skipped: number;
  failed: number;
}

export class DigestService {
  private readonly log = new Logger('digest');

  constructor(
    private readonly queue: QueueService,
    private readonly mailer: MailerPort,
  ) {}

  async sendDaily(tx: Tx, ctx: EngineContext, today: IsoDate): Promise<DigestResult> {
    const result: DigestResult = {
      councilId: ctx.councilId,
      recipients: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
    };

    const calendar = {
      workingWeekdays: ctx.config.calendar.workingWeekdays,
      holidays: ctx.config.calendar.holidays,
    };
    if (!isWorkingDay(today, calendar)) {
      this.log.log(`${today} is not a working day for this council — no digest`);
      return result;
    }

    // Officers only. A committee member does not want the officer's chase list, and
    // sending it to them would put every complainant's name in their inbox weekly.
    const officers = await tx.execute<{ id: string; email: string; full_name: string }>(sql`
      SELECT u.id, u.email, u.full_name
      FROM council_membership m
      JOIN app_user u ON u.id = m.app_user_id
      WHERE m.council_id = ${ctx.councilId}::uuid
        AND m.role = 'officer'
        AND u.is_active = true
        AND m.starts_on <= ${today}::date
        AND (m.ends_on IS NULL OR m.ends_on >= ${today}::date)
    `);
    result.recipients = officers.rows.length;
    if (result.recipients === 0) return result;

    const queue = await this.queue.today(tx, ctx, today);
    const councilRow = await tx.execute<{ name: string; code: string }>(
      sql`SELECT name, code FROM council WHERE id = ${ctx.councilId}::uuid`,
    );
    const council = councilRow.rows[0] ?? { name: 'the council', code: '' };

    for (const officer of officers.rows) {
      // The unique index on (app_user_id, kind, logical_date) makes a retried Cloud
      // Scheduler delivery harmless. The DO UPDATE guarded on `sent_at IS NULL` is what
      // makes a FAILED send retryable: a row that never actually went out can be
      // re-claimed, and one that did is left alone so nobody is told twice.
      const claim = await tx.execute<{ id: string }>(sql`
        INSERT INTO notification_log (council_id, app_user_id, kind, channel, logical_date)
        VALUES (${ctx.councilId}::uuid, ${officer.id}::uuid, 'daily_digest', 'email', ${today}::date)
        ON CONFLICT (app_user_id, kind, logical_date) DO UPDATE
          SET error = NULL
          WHERE notification_log.sent_at IS NULL
        RETURNING id
      `);
      if (claim.rows.length === 0) {
        result.skipped++;
        continue;
      }

      const logId = claim.rows[0]!.id;
      const subject = digestSubject(queue, council.code);
      const body = renderDigest(queue, { councilName: council.name, officerName: officer.full_name });

      try {
        await this.mailer.send({ to: officer.email, subject, text: body });
        await tx.execute(sql`
          UPDATE notification_log
          SET sent_at = now(), subject = ${subject}, item_count = ${queue.summary.total},
              payload = ${JSON.stringify(digestPayload(queue))}::jsonb
          WHERE id = ${logId}::uuid
        `);
        result.sent++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await tx.execute(sql`
          UPDATE notification_log SET error = ${message} WHERE id = ${logId}::uuid
        `);
        this.log.error(`digest to ${officer.email} failed: ${message}`);
        result.failed++;
      }
    }

    return result;
  }
}

/**
 * What the digest reported, stored alongside it. "Why did it not tell me about
 * KSDC/COMP/2026-27/0004?" then has an answer that does not need the queue re-derived as
 * it stood at 09:00 last Tuesday.
 */
function digestPayload(queue: TodayQueue) {
  return {
    summary: queue.summary,
    items: queue.byUrgency.flatMap((g) =>
      g.items.map((i) => ({
        urgency: g.key,
        caseNumber: i.caseNumber,
        stage: i.stage,
        daysOverdue: i.daysOverdue,
      })),
    ),
  };
}

export function digestSubject(queue: TodayQueue, councilCode: string): string {
  const prefix = councilCode ? `[${councilCode}] ` : '';
  const { needsDecision, overdue, dueToday } = queue.summary;

  if (needsDecision === 0 && overdue === 0 && dueToday === 0) {
    return `${prefix}Nothing needs you today`;
  }

  // The subject line is read on a phone, on a lock screen, one-handed. It carries the
  // counts, in the order they need acting on.
  const parts: string[] = [];
  if (needsDecision) parts.push(`${needsDecision} to decide`);
  if (overdue) parts.push(`${overdue} overdue`);
  if (dueToday) parts.push(`${dueToday} due today`);
  return `${prefix}${parts.join(', ')}`;
}

export function renderDigest(
  queue: TodayQueue,
  who: { councilName: string; officerName: string },
): string {
  const { summary } = queue;
  const webUrl = process.env.WEB_URL ?? 'http://localhost:3000';
  const lines: string[] = [];

  lines.push(`Good morning, ${who.officerName}.`);
  lines.push('');

  if (summary.total === 0) {
    lines.push('Every open case has a next step scheduled, and none of them is due yet.');
    lines.push('');
    lines.push('Nothing needs you today.');
  } else {
    for (const group of queue.byUrgency) {
      // 'later' is genuinely not today's problem; showing it would train the officer to
      // skim past the parts that are.
      if (group.key === 'later') continue;

      lines.push(`${group.label.toUpperCase()} (${group.count})`);
      for (const item of group.items) {
        const age =
          item.urgency === 'needs_decision'
            ? 'needs a decision'
            : item.daysOverdue > 0
              ? `${item.daysOverdue} day${item.daysOverdue === 1 ? '' : 's'} late`
              : item.urgency === 'due_today'
                ? 'due today'
                : `due ${item.dueOn}`;

        lines.push(`  - ${item.title} (${age})`);
        const context = [item.caseNumber, item.caseSummary].filter(Boolean).join(' - ');
        if (context) lines.push(`    ${truncate(context, 76)}`);
      }
      lines.push('');
    }
  }

  if (summary.snoozedOverdue > 0) {
    // Snoozing never moved the due date, so the count cannot be made to disappear by
    // pressing snooze. Saying so here is the point.
    lines.push(
      `${summary.snoozedOverdue} snoozed item${summary.snoozedOverdue === 1 ? ' is' : 's are'} ` +
        'already past its due date.',
    );
    lines.push('');
  }

  lines.push(`Open the queue: ${webUrl}/today`);
  lines.push('');
  lines.push('---');
  lines.push(`${who.councilName} complaints register.`);
  lines.push('This is an automatic reminder from the register, not council correspondence.');

  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}...`;
}
