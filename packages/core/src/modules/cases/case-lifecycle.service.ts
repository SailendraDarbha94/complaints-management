import { and, eq, inArray, sql } from 'drizzle-orm';
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
import { ConflictError, DomainError } from '../../common/domain-error.js';

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

    const [current] = await tx
      .select()
      .from(caseFile)
      .where(and(eq(caseFile.councilId, ctx.councilId), eq(caseFile.id, input.caseFileId)))
      .limit(1);
    if (!current) throw new DomainError(`Case ${input.caseFileId} not found`);

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
            'Issuing a notice requires confirmation that it was despatched: the service ' +
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
