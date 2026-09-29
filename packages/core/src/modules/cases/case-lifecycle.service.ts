import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import { caseFile, caseMilestone, caseRespondent, caseStateHistory, respondentNotice } from '@ksdc/db';
import type {
  CaseEvent,
  CaseState,
  ClosureReason,
  DateSource,
  FollowupStage,
  Milestone,
  ServiceMode,
  WaitingOn,
} from '@ksdc/contracts';
import { availableEvents, resolveTarget, transitionFor, waitingOnFor } from '@ksdc/contracts';
import type { EngineContext, FollowupService } from '../followups/followup.service.js';
import { ConflictError, DomainError, NotFoundError } from '../../common/domain-error.js';
import { CaseCancelledError } from './case-guard.js';
import { refileMailFromTray, returnMailToTray } from '../mail/cancelled-case.js';
import { todayIn } from '../../common/working-days.js';

/**
 * Applies case transitions.
 *
 * Every transition happens in ONE transaction and does five things together: writes the
 * state history, writes the milestones, supersedes the follow-ups the old state owned,
 * opens the ones the new state owns, and moves the case. The audit trigger appends to the
 * chain underneath. Either all of it lands or none of it does — a case cannot end up in a
 * state nobody is chasing.
 */

export class TransitionNotAllowedError extends ConflictError {
  constructor(
    readonly from: CaseState,
    readonly event: CaseEvent,
  ) {
    super(
      `A case in "${from}" cannot take the event ${event}. ` +
        `Available: ${availableEvents(from).map((t) => t.event).join(', ') || 'none'}.`,
    );
    this.name = 'TransitionNotAllowedError';
  }
}

export interface ApplyEventInput {
  caseFileId: string;
  event: CaseEvent;
  reason?: string | null;
  /** Required for respondent-scoped events. */
  caseRespondentId?: string | null;
  closureReason?: ClosureReason;
  /** Backfilled cases record where the date came from. Defaults to `recorded`. */
  dateSource?: DateSource;
  occurredAt?: Date;
  /** For ISSUE_RESPONDENT_NOTICE — the officer has confirmed this letter went out. */
  notice?: {
    serviceMode: ServiceMode;
    sentAt: Date;
    correspondenceId?: string | null;
    serviceProofDocumentId?: string | null;
  };
}

/**
 * Short enough to type in a hurry, long enough that "x" or "." is not a reason. A bare
 * "Test" is refused on purpose: "Test entry" is a few keystrokes more and reads as an
 * explanation in a register that a stranger may one day be reading line by line.
 */
export const CANCEL_REASON_MIN_LENGTH = 5;

/**
 * What a cancellation and a restoration write into case_state_history.
 *
 * Neither is a CaseEvent, because neither is a transition: the state does not move, which
 * is what lets a restore put the case back exactly where it stood. They are written to the
 * history anyway - from_state equal to to_state, as a hold toggle already is - because the
 * history is where the case page reads "what happened to this case", and a case that was
 * cancelled and then restored must not look as if neither had happened. The audit chain
 * has it regardless; the officer does not read the audit chain.
 */
export const CANCEL_EVENT = 'CANCEL_OPENED_IN_ERROR';
export const RESTORE_EVENT = 'RESTORE_CANCELLED_CASE';

/**
 * The note on every follow-up a cancellation stops. One function, because restore() finds
 * those follow-ups again by this exact text (see FollowupService.reopenAfterCancellation),
 * and two copies of a string that must match are two copies that will one day differ.
 */
function cancellationNote(reason: string): string {
  return `Case cancelled as opened in error: ${reason}`;
}

export interface CancelResult {
  caseFileId: string;
  caseNumber: string;
  cancelledAt: Date;
  /** Live follow-ups on the case that were stopped with it. */
  followupsCancelled: number;
  /** Messages that were filed on the case and are back in the tray. See mail/cancelled-case. */
  mailReturnedToTray: number;
}

export interface RestoreResult {
  caseFileId: string;
  caseNumber: string;
  /** Follow-ups the cancellation had stopped, brought back as new rows. */
  followupsReopened: number;
  /** Messages the cancellation sent back to the tray that were still there, filed again. */
  mailRefiled: number;
}

export interface ApplyEventResult {
  from: CaseState;
  to: CaseState;
  waitingOn: WaitingOn;
  milestones: Milestone[];
  followupsOpened: FollowupStage[];
  followupsSuperseded: number;
  /** True when the engine also raised ALL_RESPONDENTS_RESOLVED in the same transaction. */
  cascaded: boolean;
}

export class CaseLifecycleService {
  constructor(private readonly followups: FollowupService) {}

  async apply(tx: Tx, ctx: EngineContext, input: ApplyEventInput): Promise<ApplyEventResult> {
    const rule = transitionFor(input.event);
    if (rule.from === 'CREATE') {
      throw new Error(`${input.event} creates a case; use CaseIntakeService instead.`);
    }

    // Locked, for the reason assertCaseLive locks (see case-guard): the liveness check below
    // must still be true when the UPDATEs further down land. Without the lock, a cancel that
    // commits in between is not seen, and this transition opens its follow-ups on a case
    // cancel() has just finished stopping. With it, that cancel waits for this transaction
    // and then stops what it opened too.
    const [current] = await tx
      .select()
      .from(caseFile)
      .where(and(eq(caseFile.councilId, ctx.councilId), eq(caseFile.id, input.caseFileId)))
      .limit(1)
      .for('update');
    if (!current) throw new DomainError(`Case ${input.caseFileId} not found`);
    // Before the state check, so the officer is told the case was cancelled rather than
    // that its state does not allow the event - the state is where it was frozen, and
    // "cannot take this event" would send them looking for the wrong fix. See case-guard.
    if (current.deletedAt) throw new CaseCancelledError(current.caseNumber, current.deletionReason);

    if (!rule.from.includes(current.state)) {
      throw new TransitionNotAllowedError(current.state, input.event);
    }
    if (rule.phase > ctx.config.buildPhase) {
      throw new DomainError(
        `${input.event} arrives in Phase ${rule.phase}; this council is on Phase ${ctx.config.buildPhase}.`,
      );
    }
    if (rule.requiresReason && !input.reason?.trim()) {
      throw new DomainError(`${input.event} requires a reason. It becomes part of the record.`);
    }
    // ISSUE_RESPONDENT_NOTICE is scoped to the CASE, because issuing a notice moves the
    // whole case to awaiting_respondent_reply. But a notice is still served on a person,
    // and applyRespondentEffects silently returns when there is nobody to serve it on - so
    // without this line the transition landed, a `respondent_notice_despatched` milestone
    // was written against no respondent, and no respondent_notice row and no notice_count
    // increment happened at all. The register then said a notice had gone out to a dentist
    // it could not name, and notice_count - the number an ex parte finding against a named
    // dentist rests on - stayed at zero. Refusing is the only safe answer.
    const needsRespondent = rule.scope === 'respondent' || input.event === 'ISSUE_RESPONDENT_NOTICE';
    if (needsRespondent && !input.caseRespondentId) {
      throw new DomainError(
        `${input.event} is served on one respondent, so it needs to say which. ` +
          'Pick the dentist this notice went to.',
      );
    }

    const occurredAt = input.occurredAt ?? new Date();
    const dateSource: DateSource = input.dateSource ?? 'recorded';
    const target = resolveTarget(rule, current.state);

    // ── Respondent-scoped side effects ──────────────────────────────────────
    if (input.event === 'ISSUE_RESPONDENT_NOTICE' || rule.scope === 'respondent') {
      await this.applyRespondentEffects(tx, ctx, input, occurredAt);
    }

    // ── Hold toggle ─────────────────────────────────────────────────────────
    if (rule.scope === 'hold') {
      await tx
        .update(caseFile)
        .set(
          input.event === 'PUT_ON_HOLD'
            ? { onHold: true, holdReason: input.reason!, heldSince: occurredAt, updatedAt: new Date() }
            : { onHold: false, holdReason: null, heldSince: null, updatedAt: new Date() },
        )
        .where(eq(caseFile.id, input.caseFileId));
    }

    // ── Milestones ──────────────────────────────────────────────────────────
    const milestones: Milestone[] = [...(rule.milestones ?? [])];
    for (const milestone of milestones) {
      await tx.insert(caseMilestone).values({
        councilId: ctx.councilId,
        caseFileId: input.caseFileId,
        milestone,
        occurredAt,
        dateSource,
        caseRespondentId: input.caseRespondentId ?? null,
        recordedBy: ctx.userId ?? null,
        note: input.reason ?? null,
      });
    }

    // ── Follow-ups ──────────────────────────────────────────────────────────
    const superseded = await this.followups.supersede(tx, ctx, {
      caseFileId: input.caseFileId,
      stages: rule.supersedes ?? [],
    });

    // "Which doctor has not replied?" is one of the four questions the dashboard exists
    // to answer, so a respondent-scoped follow-up carries the dentist's party id and
    // their name. Two identical rows on a chain-clinic case are useless.
    let respondentPartyId: string | null = null;
    let respondentName: string | null = null;
    if (input.caseRespondentId) {
      const named = await tx.execute<{ party_id: string; full_name: string }>(sql`
        SELECT p.id AS party_id, p.full_name
        FROM case_respondent cr
        JOIN case_party cp ON cp.id = cr.case_party_id
        JOIN party p ON p.id = cp.party_id
        WHERE cr.id = ${input.caseRespondentId}::uuid
      `);
      respondentPartyId = named.rows[0]?.party_id ?? null;
      respondentName = named.rows[0]?.full_name ?? null;
    }

    const opened: FollowupStage[] = [];
    for (const stage of rule.opens ?? []) {
      // A follow-up opened by a transition waits on whoever the new state waits on, and
      // its clock runs from when the transition HAPPENED, not from when it was typed in.
      // Backfilling a case that has been sitting since August must produce a follow-up
      // that is honestly overdue today — not a fresh deadline that hides the delay.
      await this.followups.open(
        tx,
        ctx,
        {
          stage,
          caseFileId: input.caseFileId,
          caseRespondentId: input.caseRespondentId ?? null,
          waitingOnKind: waitingOnFor(target),
          waitingOnPartyId: respondentPartyId,
          ...(respondentName ? { title: `${respondentName} to send an explanation` } : {}),
        },
        occurredAt,
      );
      opened.push(stage);
    }

    // ── History and the move itself ─────────────────────────────────────────
    await tx.insert(caseStateHistory).values({
      councilId: ctx.councilId,
      caseFileId: input.caseFileId,
      fromState: current.state,
      toState: target,
      event: input.event,
      reason: input.reason ?? null,
      actorUserId: ctx.userId ?? null,
      isSystem: rule.system ?? false,
      occurredAt,
    });

    if (target !== current.state) {
      const patch: Record<string, unknown> = {
        state: target,
        // The clock for "days waiting" restarts whenever the case changes hands.
        waitingSince: occurredAt,
        updatedAt: new Date(),
      };
      if (target === 'closed') {
        patch.closedAt = occurredAt;
        patch.closureReason = this.closureReasonFor(input);
        patch.closureNote = input.reason ?? null;
      }
      if (current.state === 'closed' && target !== 'closed') {
        patch.closedAt = null;
        patch.closureReason = null;
      }
      if (input.event === 'DOCUMENTS_RECEIVED' || input.event === 'MARK_COMPLETE_ON_ARRIVAL') {
        // Every downstream deadline runs from here, not from receipt.
        patch.documentsCompleteAt = occurredAt;
      }
      await tx.update(caseFile).set(patch).where(eq(caseFile.id, input.caseFileId));
    }

    // ── Cascade: has the last respondent been settled? ──────────────────────
    let cascaded = false;
    if (rule.scope === 'respondent' && target === 'awaiting_respondent_reply') {
      cascaded = await this.maybeResolveAllRespondents(tx, ctx, input.caseFileId, occurredAt);
    }

    // Whatever happened, the case must not be left with nothing scheduled.
    await this.followups.sweepNoNextStep(tx, ctx, occurredAt);

    const finalState = cascaded ? 'ready_for_committee' : target;
    return {
      from: current.state,
      to: finalState,
      waitingOn: waitingOnFor(finalState),
      milestones,
      followupsOpened: opened,
      followupsSuperseded: superseded,
      cascaded,
    };
  }

  /**
   * The notice counter moves here and nowhere else, and only because the officer
   * confirmed a letter actually went out. No timer touches it: a timer-driven count would
   * become the legal basis for an ex parte finding against a named dentist, on a system
   * whose whole premise is that things get forgotten.
   */
  private async applyRespondentEffects(
    tx: Tx,
    ctx: EngineContext,
    input: ApplyEventInput,
    occurredAt: Date,
  ): Promise<void> {
    const respondentId = input.caseRespondentId;
    if (!respondentId) return;

    const [respondent] = await tx
      .select()
      .from(caseRespondent)
      .where(and(eq(caseRespondent.councilId, ctx.councilId), eq(caseRespondent.id, respondentId)))
      .limit(1);
    if (!respondent) throw new DomainError(`Respondent ${respondentId} not found`);

    switch (input.event) {
      case 'ISSUE_RESPONDENT_NOTICE': {
        if (!input.notice) {
          throw new DomainError(
            'Issuing a notice requires confirmation that it was dispatched: the service ' +
              'mode and the date it went out. The counter never moves on a draft.',
          );
        }
        const seqNo = respondent.noticeCount + 1;

        await tx.insert(respondentNotice).values({
          councilId: ctx.councilId,
          caseRespondentId: respondentId,
          seqNo,
          correspondenceId: input.notice.correspondenceId ?? null,
          sentAt: input.notice.sentAt,
          serviceMode: input.notice.serviceMode,
          serviceProofDocumentId: input.notice.serviceProofDocumentId ?? null,
        });

        await tx
          .update(caseRespondent)
          .set({
            noticeCount: seqNo,
            noticeState: 'awaiting_reply',
            // Eligibility is computed from real despatched notices, never from a
            // reminder counter. It is a warning to the officer, not a guard.
            exParteEligible: seqNo >= ctx.config.respondents.noticesBeforeExParte,
          })
          .where(eq(caseRespondent.id, respondentId));
        break;
      }

      case 'RECORD_RESPONDENT_REPLY':
        await tx
          .update(caseRespondent)
          .set({
            noticeState: 'replied',
            firstReplyAt: respondent.firstReplyAt ?? occurredAt,
          })
          .where(eq(caseRespondent.id, respondentId));
        // Stop chasing this one. The case may still wait on a co-respondent.
        await this.followups.closeForRespondent(tx, ctx, {
          caseRespondentId: respondentId,
          stages: ['await_respondent_explanation', 'propose_ex_parte'],
          outcome: 'satisfied',
          note: 'Explanation received',
        });
        await tx
          .update(respondentNotice)
          .set({ replyReceivedAt: occurredAt })
          .where(
            and(
              eq(respondentNotice.caseRespondentId, respondentId),
              eq(respondentNotice.seqNo, Math.max(1, respondent.noticeCount)),
            ),
          );
        break;

      case 'DECLARE_RESPONDENT_EX_PARTE':
        await tx
          .update(caseRespondent)
          .set({
            noticeState: 'ex_parte',
            exParteAt: occurredAt,
            exParteReason: input.reason!,
          })
          .where(eq(caseRespondent.id, respondentId));
        await this.followups.closeForRespondent(tx, ctx, {
          caseRespondentId: respondentId,
          stages: ['await_respondent_explanation', 'propose_ex_parte'],
          outcome: 'superseded',
          note: 'Declared ex parte',
        });
        break;

      case 'DROP_RESPONDENT':
        await tx
          .update(caseRespondent)
          .set({ noticeState: 'dropped', droppedAt: occurredAt, droppedReason: input.reason! })
          .where(eq(caseRespondent.id, respondentId));
        await this.followups.closeForRespondent(tx, ctx, {
          caseRespondentId: respondentId,
          stages: ['await_respondent_explanation', 'propose_ex_parte'],
          outcome: 'superseded',
          note: 'Respondent dropped from the case',
        });
        break;

      default:
        break;
    }
  }

  /**
   * Raised by the engine, never offered as a button: when every respondent has replied,
   * gone ex parte or been dropped, the case is ready for the committee.
   */
  private async maybeResolveAllRespondents(
    tx: Tx,
    ctx: EngineContext,
    caseFileId: string,
    occurredAt: Date,
  ): Promise<boolean> {
    const outstanding = await tx
      .select({ id: caseRespondent.id })
      .from(caseRespondent)
      .where(
        and(
          eq(caseRespondent.councilId, ctx.councilId),
          eq(caseRespondent.caseFileId, caseFileId),
          inArray(caseRespondent.noticeState, ['not_issued', 'awaiting_reply']),
        ),
      );
    if (outstanding.length > 0) return false;

    const rule = transitionFor('ALL_RESPONDENTS_RESOLVED');
    await this.followups.supersede(tx, ctx, { caseFileId, stages: rule.supersedes ?? [] });

    await tx.insert(caseStateHistory).values({
      councilId: ctx.councilId,
      caseFileId,
      fromState: 'awaiting_respondent_reply',
      toState: 'ready_for_committee',
      event: 'ALL_RESPONDENTS_RESOLVED',
      reason: 'Every respondent has replied, gone ex parte, or been dropped.',
      actorUserId: null,
      isSystem: true,
      occurredAt,
    });

    await tx
      .update(caseFile)
      .set({ state: 'ready_for_committee', waitingSince: occurredAt, updatedAt: new Date() })
      .where(eq(caseFile.id, caseFileId));

    return true;
  }

  private closureReasonFor(input: ApplyEventInput): ClosureReason {
    if (input.closureReason) return input.closureReason;
    switch (input.event) {
      case 'DESPATCH_ORDER':
        return 'decided_by_committee';
      case 'REPORT_SETTLEMENT':
        return 'amicable_settlement';
      case 'MARK_COMPLAINANT_UNRESPONSIVE':
        return 'complainant_unresponsive';
      default:
        throw new DomainError(
          `Closing a case with ${input.event} requires an explicit closureReason. ` +
            'The register never records a bare closure.',
        );
    }
  }

  // ── Cancelled: opened in error ───────────────────────────────────────────

  /**
   * Cancel a case that should never have been opened: a duplicate, a message that was not
   * a complaint, a test.
   *
   * This is what the officer's "delete" became. Nothing is deleted - app_rw cannot - and
   * the case keeps its number, because the number is a serial in a legal register and a
   * number that vanished is a gap somebody will one day have to explain. Instead the case
   * is marked - deleted_at, deleted_by and deletion_reason, set together here and cleared
   * together by restore(), with a CHECK from 0016 making sure no cancellation lacks its
   * reason - and every query that feeds a working list leaves it out, while the register
   * goes on listing it as cancelled, with the reason.
   *
   * The state is left exactly as it was, so restore() can put the case back where it
   * stood. The live chase stops with it, in the same transaction: a cancelled case with
   * an open reminder would be chased by nobody on no list, and that reminder would still
   * be escalated every night by a tick that does not know the case is gone. And the mail
   * filed on it goes back to the tray, so that it can reach the right case.
   */
  async cancel(
    tx: Tx,
    ctx: EngineContext,
    input: { caseFileId: string; reason: string },
  ): Promise<CancelResult> {
    const reason = (input.reason ?? '').trim();
    if (reason.length < CANCEL_REASON_MIN_LENGTH) {
      throw new DomainError(
        'Say in a few words why this case was opened in error - for example "Duplicate of ' +
          '0008" or "Not a complaint". The reason is printed in the register beside the ' +
          'case number, where it is the only explanation of why that number leads nowhere.',
      );
    }

    const current = await this.findForCancellation(tx, ctx, input.caseFileId);
    if (current.deletedAt) {
      throw new ConflictError(
        `${current.caseNumber} is already cancelled` +
          (current.deletionReason ? ` (${current.deletionReason})` : '') +
          '. Nothing has changed.',
      );
    }

    // One instant for the case and for every follow-up stopped with it: restore() finds
    // exactly the follow-ups this cancellation stopped by that equality.
    const at = new Date();

    // Guarded on deleted_at IS NULL as well as checked above. Two tabs cancelling at once
    // both pass the check; the second UPDATE then waits on the first's row lock, finds the
    // row no longer matches, and changes nothing - rather than overwriting the first
    // reason, time and name with its own.
    const updated = await tx
      .update(caseFile)
      .set({ deletedAt: at, deletionReason: reason, deletedBy: ctx.userId ?? null, updatedAt: at })
      .where(
        and(
          eq(caseFile.councilId, ctx.councilId),
          eq(caseFile.id, input.caseFileId),
          isNull(caseFile.deletedAt),
        ),
      )
      .returning({ id: caseFile.id });
    if (updated.length === 0) {
      throw new ConflictError(`${current.caseNumber} was cancelled a moment ago by someone else.`);
    }

    const followupsCancelled = await this.followups.cancelForCase(tx, ctx, {
      caseFileId: input.caseFileId,
      note: cancellationNote(reason),
      at,
    });

    // The mail filed on it goes back to the tray, where it can be added to the case it
    // duplicates or marked not a complaint - left here, it could be neither, and a
    // duplicate's complaint text and evidence would never reach the real case. Its letter
    // and documents stay on this case as the record of what it held. See mail/cancelled-case.
    const mailReturnedToTray = await returnMailToTray(tx, ctx, input.caseFileId);

    await tx.insert(caseStateHistory).values({
      councilId: ctx.councilId,
      caseFileId: input.caseFileId,
      fromState: current.state,
      toState: current.state,
      event: CANCEL_EVENT,
      reason,
      actorUserId: ctx.userId ?? null,
      isSystem: false,
      occurredAt: at,
    });

    return {
      caseFileId: input.caseFileId,
      caseNumber: current.caseNumber,
      cancelledAt: at,
      followupsCancelled,
      mailReturnedToTray,
    };
  }

  /**
   * Undo a cancellation. The safety net the officer asked for: taking a case off every
   * list must never be one careless click that cannot be taken back.
   *
   * Clears the three columns together, so the case is on every list again, in the state it
   * was cancelled in, with its original waiting_since - the days it spent cancelled count
   * as days waiting, because they were.
   *
   * The chase comes back too. There is no "plan the next reminder from the state" in the
   * follow-up engine - reminders are opened by the transitions that create the obligation,
   * not derived from where a case stands - so the follow-ups the cancellation stopped are
   * reopened instead (see FollowupService.reopenAfterCancellation), then the no-next-step
   * sweep runs at once rather than waiting for the night: if nothing was live when the case
   * was cancelled, it is flagged on Today straight away as having no next step, which is
   * the truth about it. The mail the cancellation sent back to the tray comes back too,
   * unless the officer has already put it somewhere else.
   */
  async restore(
    tx: Tx,
    ctx: EngineContext,
    input: { caseFileId: string },
    now?: Date,
  ): Promise<RestoreResult> {
    const current = await this.findForCancellation(tx, ctx, input.caseFileId);
    if (!current.deletedAt) {
      throw new ConflictError(`${current.caseNumber} is not cancelled, so there is nothing to restore.`);
    }
    const cancelledAt = current.deletedAt;

    const updated = await tx
      .update(caseFile)
      .set({ deletedAt: null, deletionReason: null, deletedBy: null, updatedAt: new Date() })
      .where(
        and(
          eq(caseFile.councilId, ctx.councilId),
          eq(caseFile.id, input.caseFileId),
          isNotNull(caseFile.deletedAt),
        ),
      )
      .returning({ id: caseFile.id });
    if (updated.length === 0) {
      throw new ConflictError(`${current.caseNumber} was restored a moment ago by someone else.`);
    }

    // The reason column is what the case page's chronology prints, so the restore says
    // what it undid. Without it the timeline would show a cancellation and then silence.
    const cancelledOn = todayIn(ctx.config.calendar.timezone, cancelledAt);
    await tx.insert(caseStateHistory).values({
      councilId: ctx.councilId,
      caseFileId: input.caseFileId,
      fromState: current.state,
      toState: current.state,
      event: RESTORE_EVENT,
      reason:
        `Restored. It had been cancelled on ${cancelledOn} as opened in error` +
        (current.deletionReason ? `: ${current.deletionReason}` : '.'),
      actorUserId: ctx.userId ?? null,
      isSystem: false,
      occurredAt: now ?? new Date(),
    });

    const followupsReopened = await this.followups.reopenAfterCancellation(
      tx,
      ctx,
      {
        caseFileId: input.caseFileId,
        cancelledAt,
        // deletion_reason is NOT NULL whenever deleted_at is set (the CHECK from 0016).
        note: cancellationNote(current.deletionReason ?? ''),
      },
      now,
    );
    await this.followups.sweepNoNextStep(tx, ctx, now);

    // And the mail the cancellation sent back to the tray, where nobody has touched it
    // since. See mail/cancelled-case for why a message dealt with in the meantime stays put.
    const mailRefiled = await refileMailFromTray(tx, ctx, input.caseFileId);

    return {
      caseFileId: input.caseFileId,
      caseNumber: current.caseNumber,
      followupsReopened,
      mailRefiled,
    };
  }

  private async findForCancellation(tx: Tx, ctx: EngineContext, caseFileId: string) {
    const [row] = await tx
      .select({
        caseNumber: caseFile.caseNumber,
        state: caseFile.state,
        deletedAt: caseFile.deletedAt,
        deletionReason: caseFile.deletionReason,
      })
      .from(caseFile)
      .where(and(eq(caseFile.councilId, ctx.councilId), eq(caseFile.id, caseFileId)))
      .limit(1);
    if (!row) throw new NotFoundError('That case is not in the register.');
    return row;
  }

  /** Drives every button on every client, so no UI re-implements a guard. */
  availableFor(state: CaseState, ctx: EngineContext) {
    return availableEvents(state, { phase: ctx.config.buildPhase }).map((t) => ({
      event: t.event,
      to: t.to,
      scope: t.scope,
      requiresReason: t.requiresReason ?? false,
      description: t.description,
    }));
  }
}
