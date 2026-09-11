import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import { followUp } from '@ksdc/db';
import type { CouncilConfig } from '@ksdc/config';
import { followupRuleFor } from '@ksdc/config';
import type { FollowupStage, WaitingOn } from '@ksdc/contracts';
import {
  addDaysByBasis,
  daysOverdue,
  isBefore,
  todayIn,
  type Calendar,
  type IsoDate,
} from '../../common/working-days.js';
import { DomainError } from '../../common/domain-error.js';

/**
 * The follow-up engine.
 *
 * One invariant runs through all of it: **every open case owns at least one open
 * follow-up, or it is flagged as having no next step.** Forgetting to chase almost always
 * means nothing was ever scheduled, and a case with no timer is invisible to a
 * timer-based system — which is exactly how a case goes quiet for thirty-four days.
 *
 * Three rules the engine will not break, each with a reason written next to it:
 *   - Escalation creates a NEW row. Nothing is mutated in place, so notice 1 -> 2 -> 3 is
 *     provable as three obligations with three dates.
 *   - Snoozing never touches `due_on`. Snoozing can never launder an overdue case into a
 *     clean one.
 *   - The engine never decides anything adverse. After the last escalation it opens a
 *     proposal for the officer. It does not close cases, does not declare anyone ex parte,
 *     and does not touch the respondent notice counter.
 */

export interface EngineContext {
  councilId: string;
  userId?: string | null;
  config: CouncilConfig;
}

export interface OpenFollowupInput {
  stage: FollowupStage;
  caseFileId?: string | null;
  caseRespondentId?: string | null;
  waitingOnKind: WaitingOn;
  waitingOnPartyId?: string | null;
  assigneeUserId?: string | null;
  title?: string;
  detail?: string | null;
  /** Overrides the rule's due days. Used when a referring authority imposes a date. */
  dueOn?: IsoDate;
  /** Distinguishes several live ad-hoc tasks on one case. */
  dedupeSuffix?: string;
}

export interface FollowupRow {
  id: string;
  stage: FollowupStage;
  status: string;
  dueOn: IsoDate;
  escalationLevel: number;
  snoozedUntil: IsoDate | null;
  caseFileId: string | null;
  caseRespondentId: string | null;
  title: string;
}

/** Live means it still demands something: open, or open-but-snoozed. */
const LIVE = ['open', 'snoozed'] as const;

export class FollowupService {
  calendarOf(config: CouncilConfig): Calendar {
    return {
      workingWeekdays: config.calendar.workingWeekdays,
      holidays: config.calendar.holidays,
    };
  }

  today(config: CouncilConfig, now?: Date): IsoDate {
    return todayIn(config.calendar.timezone, now);
  }

  /**
   * Only one live follow-up per (stage, case, respondent). The escalated row is marked
   * `escalated` before its replacement is inserted, so the replacement may reuse the key.
   */
  dedupeKey(input: {
    stage: FollowupStage;
    caseFileId?: string | null;
    caseRespondentId?: string | null;
    dedupeSuffix?: string;
  }): string {
    return [
      input.stage,
      input.caseFileId ?? '-',
      input.caseRespondentId ?? '-',
      input.dedupeSuffix ?? '',
    ].join(':');
  }

  /**
   * Open a follow-up. Idempotent: if a live one already exists for the same key it is
   * returned unchanged, so a retried scheduler delivery or a repeated transition cannot
   * create a second identical obligation.
   */
  async open(tx: Tx, ctx: EngineContext, input: OpenFollowupInput, now?: Date): Promise<FollowupRow> {
    const rule = followupRuleFor(ctx.config, input.stage);
    const today = this.today(ctx.config, now);
    const key = this.dedupeKey(input);

    const existing = await tx
      .select()
      .from(followUp)
      .where(
        and(
          eq(followUp.councilId, ctx.councilId),
          eq(followUp.dedupeKey, key),
          inArray(followUp.status, [...LIVE]),
        ),
      )
      .limit(1);

    if (existing[0]) return this.toRow(existing[0]);

    const dueOn =
      input.dueOn ??
      addDaysByBasis(today, rule.dueInDays, rule.basis, this.calendarOf(ctx.config));

    const [row] = await tx
      .insert(followUp)
      .values({
        councilId: ctx.councilId,
        caseFileId: input.caseFileId ?? null,
        caseRespondentId: input.caseRespondentId ?? null,
        stage: input.stage,
        waitingOnKind: input.waitingOnKind,
        waitingOnPartyId: input.waitingOnPartyId ?? null,
        assigneeUserId: input.assigneeUserId ?? ctx.userId ?? null,
        title: input.title ?? rule.label,
        detail: input.detail ?? null,
        openedOn: today,
        dueOn,
        isStatutory: rule.isStatutory,
        status: 'open',
        escalationLevel: 0,
        dedupeKey: key,
        createdBy: ctx.userId ?? null,
      })
      .returning();

    return this.toRow(row!);
  }

  /**
   * Mark live follow-ups on a case as superseded — the case moved on, so the obligation
   * no longer applies. Distinct from `satisfy`: nobody did the thing, it stopped mattering.
   */
  async supersede(
    tx: Tx,
    ctx: EngineContext,
    args: { caseFileId: string; stages: readonly FollowupStage[] },
  ): Promise<number> {
    if (args.stages.length === 0) return 0;
    const rows = await tx
      .update(followUp)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(followUp.councilId, ctx.councilId),
          eq(followUp.caseFileId, args.caseFileId),
          inArray(followUp.stage, [...args.stages]),
          inArray(followUp.status, [...LIVE]),
        ),
      )
      .returning({ id: followUp.id });
    return rows.length;
  }

  /**
   * Retire the live follow-ups belonging to ONE respondent on a case.
   *
   * Without this, a dentist who replies is still chased every week while the case waits
   * on their co-respondent — which teaches the officer that the list lies, and a list
   * that lies stops being read.
   */
  async closeForRespondent(
    tx: Tx,
    ctx: EngineContext,
    args: {
      caseRespondentId: string;
      stages: readonly FollowupStage[];
      outcome: 'satisfied' | 'superseded';
      note?: string;
    },
  ): Promise<number> {
    if (args.stages.length === 0) return 0;
    const rows = await tx
      .update(followUp)
      .set({
        status: args.outcome,
        satisfiedAt: args.outcome === 'satisfied' ? new Date() : null,
        satisfiedBy: args.outcome === 'satisfied' ? (ctx.userId ?? null) : null,
        resolutionNote: args.note ?? null,
      })
      .where(
        and(
          eq(followUp.councilId, ctx.councilId),
          eq(followUp.caseRespondentId, args.caseRespondentId),
          inArray(followUp.stage, [...args.stages]),
          inArray(followUp.status, [...LIVE]),
        ),
      )
      .returning({ id: followUp.id });
    return rows.length;
  }

  /**
   * The waiting party did the thing. Normally driven by an inbound contact event, which
   * is why the contact event id is recorded — "how do we know?" has an answer.
   */
  async satisfy(
    tx: Tx,
    ctx: EngineContext,
    args: { followUpId: string; contactEventId?: string | null; note?: string | null },
  ): Promise<void> {
    await tx
      .update(followUp)
      .set({
        status: 'satisfied',
        satisfiedAt: new Date(),
        satisfiedBy: ctx.userId ?? null,
        satisfiedByContactEventId: args.contactEventId ?? null,
        resolutionNote: args.note ?? null,
      })
      .where(and(eq(followUp.councilId, ctx.councilId), eq(followUp.id, args.followUpId)));
  }

  /**
   * Snooze sets `snoozed_until` and NEVER touches `due_on`, so a snoozed case that was
   * already late still counts as late. The Today screen shows "snoozed (2 - 1 overdue)"
   * permanently rather than letting the number quietly disappear.
   *
   * A statutory follow-up cannot be snoozed past its due date: missing the RTI thirty
   * days is a personal penalty on a named officer, not a scheduling preference.
   */
  async snooze(
    tx: Tx,
    ctx: EngineContext,
    args: { followUpId: string; until: IsoDate },
  ): Promise<void> {
    const [row] = await tx
      .select()
      .from(followUp)
      .where(and(eq(followUp.councilId, ctx.councilId), eq(followUp.id, args.followUpId)))
      .limit(1);

    if (!row) throw new DomainError(`Follow-up ${args.followUpId} not found`);
    if (row.isStatutory && isBefore(row.dueOn, args.until)) {
      throw new DomainError(
        `This is a statutory deadline (due ${row.dueOn}). It cannot be snoozed past its due date.`,
      );
    }

    await tx
      .update(followUp)
      .set({
        status: 'snoozed',
        snoozedUntil: args.until,
        snoozeCount: sql`${followUp.snoozeCount} + 1`,
      })
      .where(and(eq(followUp.councilId, ctx.councilId), eq(followUp.id, args.followUpId)));
  }

  /** Manual dismissal. The reason is mandatory — a follow-up cannot vanish silently. */
  async dismiss(
    tx: Tx,
    ctx: EngineContext,
    args: { followUpId: string; reason: string },
  ): Promise<void> {
    if (!args.reason?.trim()) {
      throw new DomainError('Dismissing a follow-up requires a reason.');
    }
    await tx
      .update(followUp)
      .set({
        status: 'cancelled',
        satisfiedAt: new Date(),
        satisfiedBy: ctx.userId ?? null,
        resolutionNote: args.reason,
      })
      .where(and(eq(followUp.councilId, ctx.councilId), eq(followUp.id, args.followUpId)));
  }

  /**
   * The daily tick.
   *
   * Wakes snoozed rows whose snooze has expired, then escalates anything overdue. It
   * creates rows and nothing else: no state transition, no notice counter, no closure.
   */
  async tick(
    tx: Tx,
    ctx: EngineContext,
    now?: Date,
  ): Promise<{ woken: number; escalated: number; proposals: number }> {
    const today = this.today(ctx.config, now);
    const cal = this.calendarOf(ctx.config);

    // 1. Snoozes that have run out come back into the queue.
    const woken = await tx
      .update(followUp)
      .set({ status: 'open', snoozedUntil: null })
      .where(
        and(
          eq(followUp.councilId, ctx.councilId),
          eq(followUp.status, 'snoozed'),
          sql`${followUp.snoozedUntil} <= ${today}::date`,
        ),
      )
      .returning({ id: followUp.id });

    // 2. Overdue and open. Snoozed rows are left alone until they wake.
    const overdue = await tx
      .select()
      .from(followUp)
      .where(
        and(
          eq(followUp.councilId, ctx.councilId),
          eq(followUp.status, 'open'),
          sql`${followUp.dueOn} < ${today}::date`,
        ),
      );

    let escalated = 0;
    let proposals = 0;

    for (const row of overdue) {
      const rule = followupRuleFor(ctx.config, row.stage);

      // A proposal is already the end of the line; it waits for the officer, not a timer.
      if (rule.maxEscalations === 0) continue;

      // One grace gap after the row fell due, so a party who is a day late is not
      // chased the next morning, and a reply sitting unlogged in the mailbox has time
      // to be filed.
      //
      // The rule is uniform across levels because an escalated row is created due
      // TODAY (see below). Setting the escalated row's due date a gap into the future
      // and then waiting another gap here would silently run the ladder at half speed:
      // three notices would take twelve weeks instead of six.
      const nextEscalationDue = addDaysByBasis(row.dueOn, rule.escalationGapDays, rule.basis, cal);
      if (isBefore(today, nextEscalationDue)) continue;

      if (row.escalationLevel >= rule.maxEscalations) {
        // The ladder is exhausted. The engine stops and hands the case to a person.
        if (rule.terminalAction === 'none') continue;

        const stage: FollowupStage =
          rule.terminalAction === 'propose_ex_parte' ? 'propose_ex_parte' : 'propose_closure';

        const proposal = await this.open(
          tx,
          ctx,
          {
            stage,
            caseFileId: row.caseFileId,
            caseRespondentId: row.caseRespondentId,
            // A proposal is a decision for the officer, so the case now waits on us.
            waitingOnKind: 'council_officer',
            detail:
              `Opened automatically after ${row.escalationLevel + 1} reminders on ` +
              `"${row.title}" with no reply logged. The software has not decided anything.`,
          },
          now,
        );

        // Retire the exhausted rung and link it to the proposal that replaced it, so the
        // ladder reads notice 1 -> 2 -> 3 -> proposal. Without this the row stays open and
        // overdue forever, and every subsequent tick reconsiders it: harmless in the
        // database because open() is idempotent, but it reports a fresh proposal every
        // single day and buries the real ones.
        await tx
          .update(followUp)
          .set({ status: 'escalated' })
          .where(eq(followUp.id, row.id));

        // Count the proposal only the first time, when it is genuinely new.
        if (proposal.id !== row.id) proposals++;
        continue;
      }

      // 3. Escalate: mark the old row escalated, insert a new one linked to it.
      await tx
        .update(followUp)
        .set({ status: 'escalated' })
        .where(eq(followUp.id, row.id));

      await tx.insert(followUp).values({
        councilId: ctx.councilId,
        caseFileId: row.caseFileId,
        caseRespondentId: row.caseRespondentId,
        // Carried, or an escalated RTI reminder would lose the application it belongs to
        // and appear on the Today screen attached to nothing at all.
        rtiRequestId: row.rtiRequestId,
        stage: row.stage,
        waitingOnKind: row.waitingOnKind,
        waitingOnPartyId: row.waitingOnPartyId,
        assigneeUserId: row.assigneeUserId,
        // Never "did not respond" — in Phase 1 the officer logs inbound mail by hand, so
        // the software genuinely cannot tell silence from an unlogged reply.
        title: `${row.title} - no reply logged, check the mailbox`,
        detail: row.detail,
        openedOn: today,
        // Due today: this reminder is owed now. The gap to the next one is applied by
        // the escalation check above, once, rather than here and there.
        dueOn: today,
        isStatutory: row.isStatutory,
        status: 'open',
        escalationLevel: row.escalationLevel + 1,
        escalatedFromId: row.id,
        dedupeKey: row.dedupeKey,
        createdBy: null,
      });
      escalated++;
    }

    return { woken: woken.length, escalated, proposals };
  }

  /**
   * The invariant sweep: any open case with no live follow-up gets a `no_next_step` flag,
   * and any case that has since acquired one has the flag cleared.
   *
   * This is the difference between a reminder system and a system that notices silence.
   */
  async sweepNoNextStep(tx: Tx, ctx: EngineContext, now?: Date): Promise<{ flagged: number; cleared: number }> {
    const today = this.today(ctx.config, now);

    const flagged = await tx.execute<{ id: string }>(sql`
      INSERT INTO follow_up (
        council_id, case_file_id, stage, waiting_on_kind, title, detail,
        opened_on, due_on, status, escalation_level, dedupe_key
      )
      SELECT c.council_id, c.id, 'no_next_step', 'council_officer',
             'This case has no next step scheduled',
             'Quiet since ' || to_char(c.waiting_since, 'DD Mon YYYY') ||
             '. Schedule something, transition the case, or close it.',
             ${today}::date, ${today}::date, 'open', 0,
             'no_next_step:' || c.id::text || ':-:'
      FROM case_file c
      WHERE c.council_id = ${ctx.councilId}::uuid
        AND c.state <> 'closed'
        AND c.on_hold = false
        AND c.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM follow_up f
          WHERE f.case_file_id = c.id
            AND f.status IN ('open','snoozed')
        )
      ON CONFLICT DO NOTHING
      RETURNING id
    `);

    // A case that has since acquired a real next step no longer needs the flag.
    const cleared = await tx.execute<{ id: string }>(sql`
      UPDATE follow_up f
      SET status = 'superseded'
      WHERE f.council_id = ${ctx.councilId}::uuid
        AND f.stage = 'no_next_step'
        AND f.status IN ('open','snoozed')
        AND EXISTS (
          SELECT 1 FROM follow_up other
          WHERE other.case_file_id = f.case_file_id
            AND other.stage <> 'no_next_step'
            AND other.status IN ('open','snoozed')
        )
      RETURNING f.id
    `);

    return { flagged: flagged.rows.length, cleared: cleared.rows.length };
  }

  async liveForCase(tx: Tx, ctx: EngineContext, caseFileId: string): Promise<FollowupRow[]> {
    const rows = await tx
      .select()
      .from(followUp)
      .where(
        and(
          eq(followUp.councilId, ctx.councilId),
          eq(followUp.caseFileId, caseFileId),
          inArray(followUp.status, [...LIVE]),
        ),
      );
    return rows.map((r) => this.toRow(r));
  }

  private toRow(r: typeof followUp.$inferSelect): FollowupRow {
    return {
      id: r.id,
      stage: r.stage,
      status: r.status,
      dueOn: r.dueOn,
      escalationLevel: r.escalationLevel,
      snoozedUntil: r.snoozedUntil,
      caseFileId: r.caseFileId,
      caseRespondentId: r.caseRespondentId,
      title: r.title,
    };
  }
}

export { daysOverdue, isNull };
