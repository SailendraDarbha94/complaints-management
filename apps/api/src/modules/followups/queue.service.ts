import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import type { FollowupStage, WaitingOn } from '@ksdc/contracts';
import { WAITING_ON_LABEL } from '@ksdc/contracts';
import { daysOverdue, type IsoDate } from '../../common/working-days.js';
import type { EngineContext } from './followup.service.js';

/**
 * The Today screen.
 *
 * One list, grouped by who you are chasing, sorted by how late they are. This is the
 * whole product in Phase 1 — the officer opens it and knows what to do today, which is
 * the thing the paper register could never tell them.
 *
 * Priority is derived in the query and never stored: a stored priority is a second thing
 * to keep in step with reality, and it would be wrong within a month.
 */

export type Urgency = 'needs_decision' | 'overdue' | 'due_today' | 'this_week' | 'later' | 'snoozed';

export interface QueueItem {
  followUpId: string;
  stage: FollowupStage;
  urgency: Urgency;
  title: string;
  detail: string | null;
  dueOn: IsoDate;
  daysOverdue: number;
  snoozedUntil: IsoDate | null;
  escalationLevel: number;
  waitingOnKind: WaitingOn;
  caseFileId: string | null;
  caseNumber: string | null;
  caseSummary: string | null;
  /** How long the case itself has been parked, which is not the same as this timer. */
  caseQuietDays: number | null;
  partyName: string | null;
  partyMobile: string | null;
  isStatutory: boolean;
}

export interface QueueGroup {
  key: Urgency | WaitingOn;
  label: string;
  count: number;
  overdueCount: number;
  items: QueueItem[];
}

export interface QueueSummary {
  today: IsoDate;
  total: number;
  needsDecision: number;
  overdue: number;
  dueToday: number;
  thisWeek: number;
  snoozed: number;
  snoozedOverdue: number;
}

export interface TodayQueue {
  summary: QueueSummary;
  /** By urgency: what must happen today. */
  byUrgency: QueueGroup[];
  /** By who you are chasing: the register's own question, answered. */
  byWaitingOn: QueueGroup[];
}

/** Proposals are decisions the engine refused to make; they head the list. */
const DECISION_STAGES: readonly FollowupStage[] = ['propose_ex_parte', 'propose_closure', 'no_next_step'];

const URGENCY_LABEL: Record<Urgency, string> = {
  needs_decision: 'Needs a decision',
  overdue: 'Overdue',
  due_today: 'Due today',
  this_week: 'This week',
  later: 'Later',
  snoozed: 'Snoozed',
};

export class QueueService {
  async today(tx: Tx, ctx: EngineContext, todayDate: IsoDate): Promise<TodayQueue> {
    const rows = await tx.execute<{
      follow_up_id: string;
      stage: FollowupStage;
      title: string;
      detail: string | null;
      due_on: string;
      snoozed_until: string | null;
      escalation_level: number;
      waiting_on_kind: WaitingOn;
      status: string;
      is_statutory: boolean;
      case_file_id: string | null;
      case_number: string | null;
      case_summary: string | null;
      case_quiet_days: number | null;
      party_name: string | null;
      party_mobile: string | null;
    }>(sql`
      SELECT f.id                AS follow_up_id,
             f.stage,
             f.title,
             f.detail,
             f.due_on::text      AS due_on,
             f.snoozed_until::text AS snoozed_until,
             f.escalation_level,
             f.waiting_on_kind,
             f.status,
             f.is_statutory,
             f.case_file_id,
             c.case_number,
             c.summary           AS case_summary,
             CASE WHEN c.id IS NULL THEN NULL
                  ELSE (${todayDate}::date - c.waiting_since::date) END AS case_quiet_days,
             p.full_name         AS party_name,
             p.mobile            AS party_mobile
      FROM follow_up f
      LEFT JOIN case_file c ON c.id = f.case_file_id
      LEFT JOIN party     p ON p.id = f.waiting_on_party_id
      WHERE f.council_id = ${ctx.councilId}::uuid
        AND f.status IN ('open', 'snoozed')
        -- A case on hold is suppressed, not chased: sub judice, or a party indisposed.
        AND (c.id IS NULL OR (c.on_hold = false AND c.deleted_at IS NULL))
      ORDER BY f.due_on ASC, f.escalation_level DESC
    `);

    const items: QueueItem[] = rows.rows.map((r) => ({
      followUpId: r.follow_up_id,
      stage: r.stage,
      urgency: this.urgencyOf(r.stage, r.status, r.due_on, r.snoozed_until, todayDate),
      title: r.title,
      detail: r.detail,
      dueOn: r.due_on,
      daysOverdue: daysOverdue(r.due_on, todayDate),
      snoozedUntil: r.snoozed_until,
      escalationLevel: r.escalation_level,
      waitingOnKind: r.waiting_on_kind,
      caseFileId: r.case_file_id,
      caseNumber: r.case_number,
      caseSummary: r.case_summary,
      caseQuietDays: r.case_quiet_days == null ? null : Number(r.case_quiet_days),
      partyName: r.party_name,
      partyMobile: r.party_mobile,
      isStatutory: r.is_statutory,
    }));

    const byUrgency = this.group<Urgency>(
      items,
      (i) => i.urgency,
      (k) => URGENCY_LABEL[k],
      ['needs_decision', 'overdue', 'due_today', 'this_week', 'later', 'snoozed'],
    );

    const byWaitingOn = this.group<WaitingOn>(
      // Snoozed rows are excluded here so "waiting on a dentist" means what it says.
      items.filter((i) => i.urgency !== 'snoozed'),
      (i) => i.waitingOnKind,
      (k) => WAITING_ON_LABEL[k],
      ['council_officer', 'respondent', 'complainant', 'expert_body', 'committee', 'nobody'],
    );

    const snoozed = items.filter((i) => i.urgency === 'snoozed');

    return {
      summary: {
        today: todayDate,
        total: items.length,
        needsDecision: items.filter((i) => i.urgency === 'needs_decision').length,
        overdue: items.filter((i) => i.urgency === 'overdue').length,
        dueToday: items.filter((i) => i.urgency === 'due_today').length,
        thisWeek: items.filter((i) => i.urgency === 'this_week').length,
        snoozed: snoozed.length,
        // Snoozing never moved the due date, so a snoozed case that was already late is
        // still counted as late. The number cannot be made to disappear.
        snoozedOverdue: snoozed.filter((i) => i.daysOverdue > 0).length,
      },
      byUrgency,
      byWaitingOn,
    };
  }

  private urgencyOf(
    stage: FollowupStage,
    status: string,
    dueOn: IsoDate,
    snoozedUntil: IsoDate | null,
    today: IsoDate,
  ): Urgency {
    // A proposal outranks everything: the engine stopped and is waiting for a person.
    if (DECISION_STAGES.includes(stage)) return 'needs_decision';
    if (status === 'snoozed' && snoozedUntil && snoozedUntil > today) return 'snoozed';
    if (dueOn < today) return 'overdue';
    if (dueOn === today) return 'due_today';

    const overdueIn = daysOverdue(today, dueOn);
    return overdueIn <= 7 ? 'this_week' : 'later';
  }

  private group<K extends Urgency | WaitingOn>(
    items: QueueItem[],
    keyOf: (i: QueueItem) => K,
    labelOf: (k: K) => string,
    order: readonly K[],
  ): QueueGroup[] {
    const buckets = new Map<K, QueueItem[]>();
    for (const item of items) {
      const k = keyOf(item);
      const list = buckets.get(k);
      if (list) list.push(item);
      else buckets.set(k, [item]);
    }
    return order
      .filter((k) => buckets.has(k))
      .map((k) => {
        const list = buckets.get(k)!;
        return {
          key: k,
          label: labelOf(k),
          count: list.length,
          overdueCount: list.filter((i) => i.daysOverdue > 0).length,
          items: list,
        };
      });
  }

  /**
   * The health banner on Today: "Reminders last ran 09:02 today", red past 26 hours.
   *
   * A silently dead ticker recreates the exact pain this product exists to remove, so the
   * person most harmed by it can see its status without depending on any alerting
   * infrastructure at all.
   */
  async tickerHealth(
    tx: Tx,
    jobName = 'daily',
  ): Promise<{ lastSuccessAt: Date | null; stale: boolean; hoursSince: number | null }> {
    const r = await tx.execute<{ finished_at: Date | null }>(sql`
      SELECT finished_at FROM job_run
      WHERE job_name = ${jobName} AND status = 'ok'
      ORDER BY finished_at DESC NULLS LAST
      LIMIT 1
    `);
    const last = r.rows[0]?.finished_at ?? null;
    if (!last) return { lastSuccessAt: null, stale: true, hoursSince: null };

    const hours = (Date.now() - new Date(last).getTime()) / 3_600_000;
    return { lastSuccessAt: new Date(last), stale: hours > 26, hoursSince: hours };
  }
}
