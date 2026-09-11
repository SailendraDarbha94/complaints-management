import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import {
  RTI_DAYS,
  RTI_OFFICES,
  fiscalYearOf,
  formatCaseNumber,
  forbidsExemption,
  requiresExemption,
  type DateSource,
  type RtiChannel,
  type RtiDecision,
  type RtiExemptionSection,
  type RtiState,
} from '@ksdc/contracts';
import { ConflictError, DomainError } from '../../common/domain-error.js';
import { Logger } from '../../common/logger.js';
import { allocateSerial } from '../../common/serials.js';
import { addCalendarDays, daysBetween, todayIn, type IsoDate } from '../../common/working-days.js';
import type { EngineContext } from '../followups/followup.service.js';
import { rtiClock, type RtiClock } from './rti-clock.js';
import { composeRtiReply, type RtiOfficeHolder, type RtiReplyDraft } from './rti-reply.js';

/**
 * The RTI register.
 *
 * Receive, clock, decide, despatch. Four verbs, and between them the whole of what the Act
 * asks a Public Information Officer to do at a body of this size.
 *
 * WHAT THIS SERVICE REFUSES TO DO, and why each refusal is here:
 *
 *   - It will not let a s.11 third-party notice go out before the officer has recorded a
 *     decision to disclose. s.11(1) is triggered by the INTENTION to disclose, not by a
 *     third party appearing in the file - and on a dental council's files a third party
 *     appears in every single one. Without that gate, "s.11 applies" becomes a reflex, and
 *     with it the forty-day period becomes a habit the council cannot justify.
 *
 *   - It will not record a fee intimation after the reply period has already expired.
 *     s.7(6) makes the information free once the period runs out; a fee demanded after
 *     that is void and is itself a ground of complaint.
 *
 *   - It will not record a decision that withholds information without a section, or a
 *     section on a decision that withholds nothing.
 *
 * WHAT IT DOES NOT REFUSE, deliberately: a late transfer, a late reply, a missing fee. The
 * register records what happened. Refusing to record a late act does not make the act
 * un-happen; it makes the register wrong about it, which is the one thing it may never be.
 * Those get a warning, and the warning names the consequence.
 *
 * The first-appeal workflow is not built. At about one application a month an appeal is
 * rare, it is the Registrar's to decide rather than the officer's, and building a screen
 * for it would be guessing at a process nobody has run yet. The appeal ROUTE is on every
 * reply, which is the part the Act requires.
 */

/**
 * Every column the screens read, with every date rendered as text.
 *
 * Spelled out rather than SELECT *, because half of these are dates and a date returned as
 * a JavaScript Date is a timezone bug waiting for a deadline to fall on the wrong side of
 * midnight. `::text` gives back exactly the day Postgres holds.
 */
const RTI_COLUMNS = sql`
  id, rti_no, fiscal_year, register_sl_no,
  received_on::text AS received_on, received_via, date_source,
  applicant_name, applicant_address_lines, applicant_email, applicant_phone, is_bpl,
  request_text, external_ref_no, application_fee_received,
  further_fee_intimated_on::text AS further_fee_intimated_on,
  further_fee_amount,
  further_fee_paid_on::text AS further_fee_paid_on,
  transferred_to, transferred_on::text AS transferred_on,
  life_or_liberty, life_or_liberty_reason,
  intends_to_disclose_third_party_on::text AS intends_to_disclose_third_party_on,
  third_party_name,
  third_party_notice_sent_on::text AS third_party_notice_sent_on,
  third_party_notice_received_on::text AS third_party_notice_received_on,
  third_party_representation_on::text AS third_party_representation_on,
  third_party_objected, third_party_representation_note,
  state, decision, decided_on::text AS decided_on, decision_reasons,
  reply_correspondence_id, reply_despatched_on::text AS reply_despatched_on,
  due_on::text AS due_on, closed_at, closure_note
`;

const RTI_SERIES = 'RTI';

export interface ReceiveRtiInput {
  receivedOn: IsoDate;
  receivedVia: RtiChannel;
  applicantName: string;
  applicantAddressLines?: string[];
  applicantEmail?: string | null;
  applicantPhone?: string | null;
  requestText: string;
  externalRefNo?: string | null;
  applicationFeeReceived?: boolean;
  isBpl?: boolean;
  lifeOrLiberty?: boolean;
  lifeOrLibertyReason?: string | null;
  dateSource?: DateSource;
  /** Cases this application concerns, if any. Most concern none. */
  caseFileIds?: string[];
}

export type RtiRequestRow = {
  id: string;
  rti_no: string;
  fiscal_year: string;
  register_sl_no: number;
  received_on: IsoDate;
  received_via: RtiChannel;
  date_source: DateSource;
  applicant_name: string;
  applicant_address_lines: string[];
  applicant_email: string | null;
  applicant_phone: string | null;
  is_bpl: boolean;
  request_text: string;
  external_ref_no: string | null;
  application_fee_received: boolean;
  further_fee_intimated_on: IsoDate | null;
  further_fee_amount: string | null;
  further_fee_paid_on: IsoDate | null;
  transferred_to: string | null;
  transferred_on: IsoDate | null;
  life_or_liberty: boolean;
  life_or_liberty_reason: string | null;
  intends_to_disclose_third_party_on: IsoDate | null;
  third_party_name: string | null;
  third_party_notice_sent_on: IsoDate | null;
  third_party_notice_received_on: IsoDate | null;
  third_party_representation_on: IsoDate | null;
  third_party_objected: boolean | null;
  third_party_representation_note: string | null;
  state: RtiState;
  decision: RtiDecision | null;
  decided_on: IsoDate | null;
  decision_reasons: string | null;
  reply_correspondence_id: string | null;
  reply_despatched_on: IsoDate | null;
  due_on: IsoDate;
  closed_at: string | null;
  closure_note: string | null;
};

export type RtiExemptionRow = {
  id: string;
  section: RtiExemptionSection;
  applies_to: string;
  reasoning: string;
};

export interface RtiFile {
  request: RtiRequestRow;
  clock: RtiClock;
  exemptions: RtiExemptionRow[];
  cases: Array<{ case_file_id: string; case_number: string; summary: string; note: string | null }>;
  letters: Array<{ id: string; kind: string; subject: string; sent_at: string | null; despatch_no: string | null }>;
  documents: Array<{ id: string; title: string; document_class: string; status: string }>;
  followups: Array<{ id: string; stage: string; status: string; due_on: IsoDate; title: string }>;
  officers: { pio: RtiOfficeHolder | null; firstAppellateAuthority: RtiOfficeHolder | null };
}

export class RtiService {
  private readonly log = new Logger('rti');

  /**
   * No FollowupService dependency, and that is not an oversight.
   *
   * Its `open()` keys the dedupe on (stage, case, respondent) and inserts no
   * rti_request_id, so every RTI in the register would collide on one key and only the
   * first would ever get a timer. The rows written here are ordinary follow_up rows in
   * every other respect - the Today screen, the digest, the escalation ladder and the
   * statutory-snooze guard all operate on them without knowing what they are.
   */

  private today(ctx: EngineContext, now?: Date): IsoDate {
    return todayIn(ctx.config.calendar.timezone, now);
  }

  // ─── Receive ───────────────────────────────────────────────────────────────

  /**
   * Log an application. The clock starts here and nowhere else.
   *
   * Two follow-ups are opened, not one, and the split is the point. `rti_reply_due` falls
   * on the statutory date ITSELF, so the register never shows an RTI deadline that is not
   * the real one; it is statutory, so it cannot be snoozed past that date, and it does not
   * escalate because there is nothing after a wall. `rti_prepare_reply` is the working
   * task, due ten clear days earlier, and it escalates the ordinary way. Without the
   * second one the officer's first warning would arrive on the day the reply had to be in
   * the post.
   */
  async receive(
    tx: Tx,
    ctx: EngineContext,
    input: ReceiveRtiInput,
    now?: Date,
  ): Promise<{ rtiRequestId: string; rtiNo: string; dueOn: IsoDate; warnings: string[] }> {
    const [council] = (
      await tx.execute<{ code: string; production_authorised_at: Date | null; is_synthetic: boolean }>(
        sql`SELECT code, production_authorised_at, is_synthetic FROM council WHERE id = ${ctx.councilId}::uuid`,
      )
    ).rows;
    if (!council) throw new Error(`Council ${ctx.councilId} not found`);

    if (!council.production_authorised_at && !council.is_synthetic) {
      throw new DomainError(
        'This council is not authorised for production data yet. Four artefacts must be ' +
          'filed in docs/authorisation/ first.',
      );
    }

    if (!input.requestText?.trim()) {
      throw new DomainError(
        'The text of the application is required, in the applicant’s own words. What was ' +
          'asked for is what every later argument turns on - whether the reply was complete, ' +
          'whether a ground covers it, whether the Commission agrees.',
      );
    }
    if (input.lifeOrLiberty && !input.lifeOrLibertyReason?.trim()) {
      throw new DomainError(
        'A forty-eight-hour request under the proviso to s.7(1) needs the officer’s ' +
          'reasons for accepting that life or liberty is concerned. The claim is made by the ' +
          'applicant; accepting it is a decision of this office and has to be recorded as one.',
      );
    }

    const fiscalYear = fiscalYearOf(new Date(`${input.receivedOn}T00:00:00Z`));
    const serial = await allocateSerial(tx, ctx.councilId, RTI_SERIES, fiscalYear);
    const rtiNo = formatCaseNumber(council.code, 'RTI', fiscalYear, serial);

    const inserted = await tx.execute<{ id: string; due_on: IsoDate }>(sql`
      INSERT INTO rti_request (
        council_id, rti_no, fiscal_year, register_sl_no, received_on, received_via,
        date_source, applicant_name, applicant_address_lines, applicant_email,
        applicant_phone, is_bpl, request_text, external_ref_no, application_fee_received,
        life_or_liberty, life_or_liberty_reason, created_by
      ) VALUES (
        ${ctx.councilId}::uuid, ${rtiNo}, ${fiscalYear}, ${serial},
        ${input.receivedOn}::date, ${input.receivedVia}::rti_channel,
        ${input.dateSource ?? 'recorded'}::date_source, ${input.applicantName},
        ${JSON.stringify(input.applicantAddressLines ?? [])}::jsonb,
        ${input.applicantEmail ?? null}, ${input.applicantPhone ?? null},
        ${input.isBpl ?? false}, ${input.requestText}, ${input.externalRefNo ?? null},
        ${input.applicationFeeReceived ?? false}, ${input.lifeOrLiberty ?? false},
        ${input.lifeOrLibertyReason ?? null}, ${ctx.userId ?? null}
      )
      RETURNING id, due_on::text AS due_on
    `);
    const row = inserted.rows[0]!;

    await tx.execute(sql`
      INSERT INTO number_allocation (council_id, series, fiscal_year, value, formatted, allocated_by)
      VALUES (${ctx.councilId}::uuid, ${RTI_SERIES}, ${fiscalYear}, ${serial}, ${rtiNo},
              ${ctx.userId ?? null})
    `);

    for (const caseFileId of input.caseFileIds ?? []) {
      await this.linkCase(tx, ctx, { rtiRequestId: row.id, caseFileId });
    }

    await this.openClockFollowups(tx, ctx, row.id, rtiNo, row.due_on, input.receivedOn, now);

    const warnings: string[] = [];
    // Received late enough that the officer is already behind on the day they log it -
    // which is exactly what happens to a postal application that sat in a tray.
    const today = this.today(ctx, now);
    const alreadyElapsed = daysBetween(input.receivedOn, today);
    if (alreadyElapsed > 7) {
      warnings.push(
        `This application was received ${alreadyElapsed} days ago and is being entered today. ` +
          `The clock runs from ${input.receivedOn}, not from today, so ${Math.max(
            0,
            daysBetween(today, row.due_on),
          )} days remain of the thirty.`,
      );
    }
    if (!input.applicationFeeReceived && !input.isBpl) {
      warnings.push(
        'No application fee is recorded. The authority is contradictory on whether an ' +
          'application without the ten rupees is a valid application, so this register treats ' +
          'the clock as running either way - which is the safe reading. Do not treat the ' +
          'missing fee as a reason to do nothing.',
      );
    }

    this.log.log(`RTI ${rtiNo} received ${input.receivedOn}, due ${row.due_on}`);
    return { rtiRequestId: row.id, rtiNo, dueOn: row.due_on, warnings };
  }

  /**
   * Open, or re-open, the two clock follow-ups against the current statutory date.
   *
   * Called again whenever the deadline moves - a fee exclusion, or s.11 turning thirty days
   * into forty. The old rows are superseded rather than edited, because a follow-up that
   * silently changes its own due date is a follow-up that cannot be used to show what the
   * office believed and when.
   */
  private async openClockFollowups(
    tx: Tx,
    ctx: EngineContext,
    rtiRequestId: string,
    rtiNo: string,
    dueOn: IsoDate,
    receivedOn: IsoDate,
    now?: Date,
  ): Promise<void> {
    const prepareOn = addCalendarDays(dueOn, -10);
    const today = this.today(ctx, now);

    await this.openRtiFollowup(tx, ctx, {
      rtiRequestId,
      stage: 'rti_reply_due',
      dueOn,
      waitingOnKind: 'council_officer',
      title: `${rtiNo}: statutory deadline - the RTI reply must be despatched by ${dueOn}`,
      detail:
        `Received ${receivedOn}. Missing this is a deemed refusal under s.7(2), the ` +
        'information then becomes free under s.7(6), and s.20(1) exposes the Public ' +
        'Information Officer personally to Rs 250 for each day of delay up to Rs 25,000, ' +
        'recovered from salary. The burden of showing the officer acted reasonably and ' +
        'diligently is on the officer.',
    });

    await this.openRtiFollowup(tx, ctx, {
      rtiRequestId,
      stage: 'rti_prepare_reply',
      // A backlog entry can be logged with fewer than ten days left, or none. Never open a
      // preparation task dated before today: a row that is born overdue reads as a failure
      // rather than as a task.
      dueOn: prepareOn < today ? today : prepareOn,
      waitingOnKind: 'council_officer',
      title: `${rtiNo}: prepare the RTI reply`,
      detail: `The statutory deadline is ${dueOn}. This is the working date, ten days before it.`,
    });
  }

  private async openRtiFollowup(
    tx: Tx,
    ctx: EngineContext,
    args: {
      rtiRequestId: string;
      stage: 'rti_reply_due' | 'rti_prepare_reply' | 'rti_await_fee' | 'rti_await_third_party';
      dueOn: IsoDate;
      waitingOnKind: 'council_officer' | 'complainant' | 'respondent';
      title: string;
      detail: string;
    },
  ): Promise<void> {
    // The engine keys its dedupe on (stage, caseFileId, caseRespondentId, suffix) and an
    // RTI row has no case, so the request id goes in the suffix. Without it every RTI in
    // the register would collide on one key and only the first would ever have a timer.
    const existing = await tx.execute<{ id: string; due_on: IsoDate }>(sql`
      SELECT id, due_on::text AS due_on FROM follow_up
      WHERE council_id = ${ctx.councilId}::uuid
        AND rti_request_id = ${args.rtiRequestId}::uuid
        AND stage = ${args.stage}::followup_stage
        AND status IN ('open','snoozed')
    `);

    for (const row of existing.rows) {
      if (row.due_on === args.dueOn) return; // unchanged; leave it alone
      await tx.execute(sql`
        UPDATE follow_up SET status = 'superseded',
               resolution_note = ${`Deadline moved to ${args.dueOn}`}
        WHERE id = ${row.id}::uuid
      `);
    }

    const rule = ctx.config.followupRules.find((r) => r.stage === args.stage);
    await tx.execute(sql`
      INSERT INTO follow_up (
        council_id, rti_request_id, stage, waiting_on_kind, title, detail,
        opened_on, due_on, is_statutory, status, escalation_level, dedupe_key, created_by
      ) VALUES (
        ${ctx.councilId}::uuid, ${args.rtiRequestId}::uuid, ${args.stage}::followup_stage,
        ${args.waitingOnKind}::waiting_on, ${args.title}, ${args.detail},
        ${this.today(ctx)}::date, ${args.dueOn}::date, ${rule?.isStatutory ?? false},
        'open', 0, ${`${args.stage}:-:-:${args.rtiRequestId}`}, ${ctx.userId ?? null}
      )
      ON CONFLICT DO NOTHING
    `);
  }

  // ─── Links to cases ────────────────────────────────────────────────────────

  async linkCase(
    tx: Tx,
    ctx: EngineContext,
    args: { rtiRequestId: string; caseFileId: string; note?: string | null },
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO rti_case_link (council_id, rti_request_id, case_file_id, note, created_by)
      VALUES (${ctx.councilId}::uuid, ${args.rtiRequestId}::uuid, ${args.caseFileId}::uuid,
              ${args.note ?? null}, ${ctx.userId ?? null})
      ON CONFLICT (rti_request_id, case_file_id) DO NOTHING
    `);
  }

  // ─── The fee, which is the only lawful way to stop the clock ───────────────

  /**
   * s.7(3)(a). Intimating a further fee excludes the period until it is paid.
   *
   * Refused once the reply period has expired, because s.7(6) has already made the
   * information free at that point: a fee demanded afterwards is void, and sending one is
   * itself a ground of complaint to the Commission. This is the one place where refusing
   * to record something is right - the act would be unlawful, not merely late.
   */
  async intimateFurtherFee(
    tx: Tx,
    ctx: EngineContext,
    args: { rtiRequestId: string; amount: number; intimatedOn: IsoDate },
    now?: Date,
  ): Promise<{ dueOn: IsoDate }> {
    const row = await this.mustFind(tx, ctx, args.rtiRequestId);

    if (row.further_fee_intimated_on) {
      throw new ConflictError(
        `A further fee of ${row.further_fee_amount ?? ''} was already intimated on ` +
          `${row.further_fee_intimated_on}. The Act allows one intimation, not a series.`,
      );
    }
    if (daysBetween(args.intimatedOn, row.due_on) < 0) {
      throw new DomainError(
        `The period allowed by s.7(1) expired on ${row.due_on}. Under s.7(6) the information ` +
          'must now be supplied free of any further charge, so a fee cannot be demanded. ' +
          'A demand sent after expiry is void and is itself a ground of complaint.',
      );
    }
    if (row.is_bpl) {
      throw new DomainError(
        'No fee is payable: the applicant is recorded as below the poverty line, and the ' +
          'proviso to s.7(5) exempts them from any fee at all.',
      );
    }

    await tx.execute(sql`
      UPDATE rti_request
      SET further_fee_intimated_on = ${args.intimatedOn}::date,
          further_fee_amount = ${args.amount},
          state = 'fee_awaited'::rti_state
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.rtiRequestId}::uuid
    `);

    await this.openRtiFollowup(tx, ctx, {
      rtiRequestId: args.rtiRequestId,
      stage: 'rti_await_fee',
      dueOn: addCalendarDays(args.intimatedOn, 15),
      // The RTI applicant is the person who wrote in, which is what `complainant` means on
      // the Today screen. A separate enum value would have to be added to waiting_on, and
      // that column is generated on case_file; it is not worth an ALTER TYPE on a live
      // register to relabel one group heading.
      waitingOnKind: 'complainant',
      title: `${row.rti_no}: applicant to pay the further fee of Rs ${args.amount}`,
      detail:
        `Intimated on ${args.intimatedOn}. The clock is excluded under s.7(3)(a) until they ` +
        'pay. Nothing lapses if they never do; the application simply stays open.',
    });

    const after = await this.mustFind(tx, ctx, args.rtiRequestId);
    return { dueOn: after.due_on };
  }

  /** The applicant paid. The excluded period closes and the deadline moves out by exactly it. */
  async recordFeePaid(
    tx: Tx,
    ctx: EngineContext,
    args: { rtiRequestId: string; paidOn: IsoDate },
    now?: Date,
  ): Promise<{ dueOn: IsoDate; excludedDays: number }> {
    const row = await this.mustFind(tx, ctx, args.rtiRequestId);
    if (!row.further_fee_intimated_on) {
      throw new DomainError(
        'No further fee was intimated on this application, so there is no excluded period ' +
          'to close. Only the fee intimated under s.7(3) stops the clock.',
      );
    }
    if (daysBetween(row.further_fee_intimated_on, args.paidOn) < 0) {
      throw new DomainError(
        `The payment cannot be dated before the intimation of ${row.further_fee_intimated_on}.`,
      );
    }

    await tx.execute(sql`
      UPDATE rti_request
      SET further_fee_paid_on = ${args.paidOn}::date,
          state = CASE WHEN intends_to_disclose_third_party_on IS NOT NULL
                       THEN 'third_party_consultation'::rti_state
                       ELSE 'received'::rti_state END
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.rtiRequestId}::uuid
    `);

    const after = await this.mustFind(tx, ctx, args.rtiRequestId);
    await this.satisfyStage(tx, ctx, args.rtiRequestId, 'rti_await_fee', `Paid ${args.paidOn}`);
    await this.openClockFollowups(
      tx,
      ctx,
      after.id,
      after.rti_no,
      after.due_on,
      after.received_on,
      now,
    );

    return {
      dueOn: after.due_on,
      excludedDays: daysBetween(row.further_fee_intimated_on, args.paidOn),
    };
  }

  // ─── s.6(3) transfer ───────────────────────────────────────────────────────

  /**
   * Transfer to another public authority.
   *
   * Recorded whatever the date. A transfer after five days is still a lawful transfer; what
   * it stops doing is protecting this officer, because the delay up to the date of transfer
   * stays here. Refusing to record it would only make the register wrong about a thing that
   * happened.
   */
  async transfer(
    tx: Tx,
    ctx: EngineContext,
    args: { rtiRequestId: string; toAuthority: string; transferredOn: IsoDate; note?: string },
  ): Promise<{ warnings: string[] }> {
    const row = await this.mustFind(tx, ctx, args.rtiRequestId);
    if (!args.toAuthority?.trim()) {
      throw new DomainError('A transfer under s.6(3) has to name the authority it goes to.');
    }

    await tx.execute(sql`
      UPDATE rti_request
      SET transferred_to = ${args.toAuthority.trim()},
          transferred_on = ${args.transferredOn}::date,
          state = 'transferred'::rti_state,
          decision = 'transferred'::rti_decision,
          decided_on = ${args.transferredOn}::date,
          decision_reasons = COALESCE(decision_reasons, ${args.note ?? null})
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.rtiRequestId}::uuid
    `);

    await this.satisfyStage(
      tx,
      ctx,
      args.rtiRequestId,
      'rti_prepare_reply',
      `Transferred to ${args.toAuthority.trim()}`,
    );

    const warnings: string[] = [];
    const overshoot = daysBetween(
      addCalendarDays(row.received_on, RTI_DAYS.transfer),
      args.transferredOn,
    );
    if (overshoot > 0) {
      warnings.push(
        `s.6(3) allows five days for a transfer, which expired on ` +
          `${addCalendarDays(row.received_on, RTI_DAYS.transfer)}. This transfer is ` +
          `${overshoot} ${overshoot === 1 ? 'day' : 'days'} late, and the delay up to today ` +
          'remains the responsibility of this office rather than the receiving authority.',
      );
    }
    warnings.push(
      'The receiving authority gets thirty days from its own receipt. Tell the applicant ' +
        'where the application has gone - they are entitled to know and it is the difference ' +
        'between a transfer and a disappearance.',
    );
    return { warnings };
  }

  // ─── s.11: third-party consultation ────────────────────────────────────────

  /**
   * "I intend to disclose third-party information."
   *
   * THE statutory trigger, recorded as a dated decision of this office. Not a checkbox
   * meaning "a third party is mentioned in the file": a third party is mentioned in every
   * file this council holds, and if that were the trigger then every RTI would take forty
   * days on a ground the council could not defend.
   *
   * Recording it moves the deadline from thirty days to forty. That is the reason it has to
   * be a deliberate act with a date on it and an audit row behind it.
   */
  async intendToDiscloseThirdParty(
    tx: Tx,
    ctx: EngineContext,
    args: { rtiRequestId: string; thirdPartyName: string; decidedOn: IsoDate },
    now?: Date,
  ): Promise<{ dueOn: IsoDate; noticeDueOn: IsoDate; warnings: string[] }> {
    const row = await this.mustFind(tx, ctx, args.rtiRequestId);
    if (!args.thirdPartyName?.trim()) {
      throw new DomainError('Name the third party whose information you intend to disclose.');
    }
    if (row.intends_to_disclose_third_party_on) {
      throw new ConflictError(
        `That decision is already recorded, on ${row.intends_to_disclose_third_party_on}.`,
      );
    }
    if (row.reply_despatched_on) {
      throw new ConflictError(
        'The reply has already gone out. s.11 is a step before disclosure, not after it.',
      );
    }

    await tx.execute(sql`
      UPDATE rti_request
      SET intends_to_disclose_third_party_on = ${args.decidedOn}::date,
          third_party_name = ${args.thirdPartyName.trim()},
          state = 'third_party_consultation'::rti_state
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.rtiRequestId}::uuid
    `);

    const after = await this.mustFind(tx, ctx, args.rtiRequestId);
    const noticeDueOn = addCalendarDays(row.received_on, RTI_DAYS.thirdPartyNotice);
    await this.openClockFollowups(
      tx,
      ctx,
      after.id,
      after.rti_no,
      after.due_on,
      after.received_on,
      now,
    );

    const warnings: string[] = [];
    if (daysBetween(this.today(ctx, now), noticeDueOn) < 0) {
      warnings.push(
        `The s.11(1) notice was due within five days of receipt, by ${noticeDueOn}, and that ` +
          'date has passed. Send it now: the third party still gets their ten days from ' +
          'their own receipt, and that period will now very likely run past the forty-day ' +
          'deadline.',
      );
    } else {
      warnings.push(`The s.11(1) notice to ${args.thirdPartyName.trim()} is due by ${noticeDueOn}.`);
    }
    warnings.push(
      `The deadline is now ${after.due_on} - forty days from receipt rather than thirty. ` +
        'That is a net gain of ten days only, and the third party may use ten of them.',
    );
    return { dueOn: after.due_on, noticeDueOn, warnings };
  }

  /**
   * The notice went out, and later the acknowledgement card came back.
   *
   * `receivedOn` is the date the council learns from the card, and it is the one that
   * matters: s.11(2) gives the third party ten days from THEIR receipt. Recording it is
   * what makes the collision computable, and the collision is the trap this module exists
   * to see coming.
   */
  async recordThirdPartyNotice(
    tx: Tx,
    ctx: EngineContext,
    args: { rtiRequestId: string; sentOn: IsoDate; receivedOn?: IsoDate | null },
    now?: Date,
  ): Promise<{ representationDueOn: IsoDate | null; warnings: string[] }> {
    const row = await this.mustFind(tx, ctx, args.rtiRequestId);
    if (!row.intends_to_disclose_third_party_on) {
      throw new DomainError(
        'A s.11 notice cannot go out before the decision that triggers it. s.11(1) is ' +
          'engaged by an intention to disclose third-party information; record that ' +
          'decision first, with its date, because it is what makes the forty-day period ' +
          'available at all.',
      );
    }

    await tx.execute(sql`
      UPDATE rti_request
      SET third_party_notice_sent_on = ${args.sentOn}::date,
          third_party_notice_received_on = COALESCE(${args.receivedOn ?? null}::date,
                                                    third_party_notice_received_on)
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.rtiRequestId}::uuid
    `);

    const after = await this.mustFind(tx, ctx, args.rtiRequestId);
    const representationDueOn = after.third_party_notice_received_on
      ? addCalendarDays(after.third_party_notice_received_on, RTI_DAYS.thirdPartyRepresentation)
      : null;

    if (representationDueOn) {
      await this.openRtiFollowup(tx, ctx, {
        rtiRequestId: args.rtiRequestId,
        stage: 'rti_await_third_party',
        dueOn: representationDueOn,
        waitingOnKind: 'respondent',
        title: `${after.rti_no}: ${after.third_party_name ?? 'third party'} may object until ${representationDueOn}`,
        detail:
          `Notice served on ${after.third_party_notice_received_on}. s.11(2) gives them ten ` +
          `days from their own receipt. The statutory deadline for the reply is ${after.due_on}.`,
      });
    }

    const clock = rtiClock(this.clockRow(after), this.today(ctx, now));
    const warnings = [...clock.warnings];
    if (!after.third_party_notice_received_on) {
      warnings.push(
        'The date the third party actually received the notice is not recorded, so their ten ' +
          'days cannot be computed. Enter it as soon as the acknowledgement comes back - ' +
          'until then there is no way to know whether their window closes before or after ' +
          'the statutory deadline.',
      );
    }
    return { representationDueOn, warnings };
  }

  async recordThirdPartyRepresentation(
    tx: Tx,
    ctx: EngineContext,
    args: { rtiRequestId: string; receivedOn: IsoDate; objected: boolean; note?: string | null },
  ): Promise<{ warnings: string[] }> {
    const row = await this.mustFind(tx, ctx, args.rtiRequestId);
    if (!row.third_party_notice_sent_on) {
      throw new DomainError('No s.11 notice has been recorded as sent on this application.');
    }

    await tx.execute(sql`
      UPDATE rti_request
      SET third_party_representation_on = ${args.receivedOn}::date,
          third_party_objected = ${args.objected},
          third_party_representation_note = ${args.note ?? null}
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.rtiRequestId}::uuid
    `);
    await this.satisfyStage(
      tx,
      ctx,
      args.rtiRequestId,
      'rti_await_third_party',
      args.objected ? 'Objected' : 'No objection',
    );

    const warnings: string[] = [];
    if (args.objected) {
      warnings.push(
        'The third party has objected. Their objection does not decide the matter - s.11(1) ' +
          'says the submission is to be kept in view and the disclosure may still be made ' +
          'where the public interest in it outweighs any possible harm. But if you do ' +
          'disclose over the objection, s.11(4) means the material is NOT sent until their ' +
          `${RTI_DAYS.thirdPartyAppeal} days for an appeal have run out, or until an appeal ` +
          'they file is decided.',
      );
    }
    return { warnings };
  }

  // ─── The decision ──────────────────────────────────────────────────────────

  /**
   * Record the decision and the grounds together, in one transaction.
   *
   * Together, because a refusal and the section it rests on are one act. Recorded
   * separately, there is a window in which the register holds a refusal citing nothing,
   * and that is precisely the document an applicant would be entitled to complain about.
   *
   * The grounds are constrained to s.8(1) and s.9 by the column type. There is no code
   * here rejecting s.11, because s.11 is not a value that exists.
   */
  async decide(
    tx: Tx,
    ctx: EngineContext,
    args: {
      rtiRequestId: string;
      decision: RtiDecision;
      reasons?: string | null;
      decidedOn: IsoDate;
      exemptions?: Array<{ section: RtiExemptionSection; appliesTo: string; reasoning: string }>;
    },
    now?: Date,
  ): Promise<{ warnings: string[] }> {
    const row = await this.mustFind(tx, ctx, args.rtiRequestId);
    if (row.reply_despatched_on) {
      throw new ConflictError(
        `The reply on this application was despatched on ${row.reply_despatched_on}. A ` +
          'decision already communicated is not re-decided here - the applicant’s remedy ' +
          'is the first appeal under s.19(1), and the council’s is a fresh, dated letter.',
      );
    }

    const exemptions = args.exemptions ?? [];
    if (requiresExemption(args.decision) && exemptions.length === 0) {
      throw new DomainError(
        'Information may be withheld only under section 8(1) or section 9 of the Act, and a ' +
          'refusal that names no clause is defective on its face. Cite the ground, and say ' +
          'what it applies to and why.',
      );
    }
    if (forbidsExemption(args.decision) && exemptions.length > 0) {
      throw new DomainError(
        'This decision withholds nothing, so it cannot carry an exemption. Citing a section ' +
          'here tells the applicant the Council is holding something back, which is not what ' +
          'this decision says.',
      );
    }
    for (const e of exemptions) {
      if (!e.reasoning?.trim()) {
        throw new DomainError(
          `Section ${e.section} is cited with no reasons. s.7(8)(i) requires the reasons for ` +
            'the rejection; naming the clause is not a reason.',
        );
      }
      if (!e.appliesTo?.trim()) {
        throw new DomainError(
          `Say which part of the request ${e.section} answers. On a partial reply the ` +
            'applicant otherwise cannot tell what was withheld.',
        );
      }
    }

    await tx.execute(sql`
      UPDATE rti_request
      SET decision = ${args.decision}::rti_decision,
          decided_on = ${args.decidedOn}::date,
          decision_reasons = ${args.reasons ?? null}
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.rtiRequestId}::uuid
    `);

    // Withdraw the previous grounds rather than accumulating them. Not deleted: the
    // application role has no DELETE grant anywhere in this database, and "what did this
    // office rely on, and when did it stop relying on it" is a question a quasi-judicial
    // record has to be able to answer.
    await tx.execute(sql`
      UPDATE rti_exemption_cited SET withdrawn_at = now()
      WHERE council_id = ${ctx.councilId}::uuid
        AND rti_request_id = ${args.rtiRequestId}::uuid
        AND withdrawn_at IS NULL
    `);
    for (const e of exemptions) {
      await tx.execute(sql`
        INSERT INTO rti_exemption_cited (council_id, rti_request_id, section, applies_to,
                                         reasoning, created_by)
        VALUES (${ctx.councilId}::uuid, ${args.rtiRequestId}::uuid,
                ${e.section}::rti_exemption_section, ${e.appliesTo.trim()},
                ${e.reasoning.trim()}, ${ctx.userId ?? null})
      `);
    }

    const after = await this.mustFind(tx, ctx, args.rtiRequestId);
    const clock = rtiClock(this.clockRow(after), this.today(ctx, now));
    const warnings = [...clock.warnings];

    if (
      after.third_party_objected &&
      (args.decision === 'information_supplied' || args.decision === 'partly_supplied')
    ) {
      warnings.push(
        `${after.third_party_name ?? 'The third party'} objected to this disclosure. Under ` +
          's.11(4) the material must not actually be sent until their thirty days for an ' +
          'appeal have expired, or until an appeal they file is decided. Send the letter; ' +
          'hold the material.',
      );
    }
    if (
      exemptions.some((e) => e.section === 's8_1_j') &&
      after.intends_to_disclose_third_party_on
    ) {
      warnings.push(
        'This withholds personal information under s.8(1)(j) while also recording an ' +
          'intention to disclose third-party information. Both can be true of different ' +
          'parts of one application, but check that they are - the file should show which ' +
          'part is which.',
      );
    }
    return { warnings };
  }

  // ─── The reply ─────────────────────────────────────────────────────────────

  /**
   * Compose the reply, and say what is wrong with it.
   *
   * The letter is assembled in code rather than from a template, because the statutory
   * furniture in s.7(8) - the reasons, the appeal period and the appellate authority's
   * particulars - is not the council's to edit. See rti-reply.ts.
   *
   * A draft with defects is still returned. An officer who cannot get a letter out of the
   * system writes it in Word, and then none of this exists.
   */
  async composeReply(
    tx: Tx,
    ctx: EngineContext,
    args: { rtiRequestId: string },
    now?: Date,
  ): Promise<RtiReplyDraft & { correspondenceId: string }> {
    const row = await this.mustFind(tx, ctx, args.rtiRequestId);
    const today = this.today(ctx, now);

    const council = (
      await tx.execute<{
        name: string;
        address_lines: string[];
        official_email: string | null;
      }>(sql`SELECT name, address_lines, official_email FROM council WHERE id = ${ctx.councilId}::uuid`)
    ).rows[0]!;

    const exemptions = await this.exemptionsFor(tx, ctx, args.rtiRequestId);
    const officers = await this.officeHolders(tx, ctx, today);

    const draft = composeRtiReply({
      council: {
        name: council.name,
        addressLines: council.address_lines ?? [],
        officialEmail: council.official_email,
      },
      rti: {
        rtiNo: row.rti_no,
        receivedOn: row.received_on,
        applicantName: row.applicant_name,
        applicantAddressLines: row.applicant_address_lines ?? [],
        requestText: row.request_text,
        decision: row.decision,
        decisionReasons: row.decision_reasons,
        transferredTo: row.transferred_to,
        transferredOn: row.transferred_on,
        thirdPartyName: row.third_party_name,
        thirdPartyObjected: row.third_party_objected,
        thirdPartyRepresentationOn: row.third_party_representation_on,
        isBpl: row.is_bpl,
      },
      exemptions: exemptions.map((e) => ({
        section: e.section,
        appliesTo: e.applies_to,
        reasoning: e.reasoning,
      })),
      pio: officers.pio,
      firstAppellateAuthority: officers.firstAppellateAuthority,
      clock: rtiClock(this.clockRow(row), today),
      letterDate: today,
    });

    // Same rewrite-the-draft rule as the complaints composer: nothing has been sent, so
    // there is no record to preserve, and a letters list that fills with abandoned drafts
    // stops being readable within a week. A despatched row is never touched.
    const saved = await tx.execute<{ id: string }>(sql`
      WITH existing AS (
        SELECT id FROM correspondence
        WHERE council_id = ${ctx.councilId}::uuid
          AND rti_request_id = ${args.rtiRequestId}::uuid
          AND kind = 'rti_reply_cover'::correspondence_kind
          AND sent_at IS NULL
        ORDER BY created_at LIMIT 1
      ),
      rewritten AS (
        UPDATE correspondence SET
          subject = ${draft.subject}, body = ${draft.body},
          to_name = ${row.applicant_name}, to_email = ${row.applicant_email},
          merge_context = ${JSON.stringify({ defects: draft.defects, composedOn: today })}::jsonb,
          created_by = ${ctx.userId ?? null}, created_at = now()
        WHERE id IN (SELECT id FROM existing)
        RETURNING id
      ),
      created AS (
        INSERT INTO correspondence (council_id, rti_request_id, kind, direction, to_name,
                                    to_email, subject, body, merge_context, created_by)
        SELECT ${ctx.councilId}::uuid, ${args.rtiRequestId}::uuid,
               'rti_reply_cover'::correspondence_kind, 'out'::contact_direction,
               ${row.applicant_name}, ${row.applicant_email}, ${draft.subject}, ${draft.body},
               ${JSON.stringify({ defects: draft.defects, composedOn: today })}::jsonb,
               ${ctx.userId ?? null}
        WHERE NOT EXISTS (SELECT 1 FROM existing)
        RETURNING id
      )
      SELECT id FROM rewritten UNION ALL SELECT id FROM created
    `);

    return { ...draft, correspondenceId: saved.rows[0]!.id };
  }

  /**
   * "I have sent it." The click that stops the statutory clock.
   *
   * Refused while the letter is still defective. This is the one refusal in the module
   * that stops the officer doing something they could physically do, and it is here
   * because an incomplete refusal is not a smaller failure than a late one: it hands the
   * applicant an appeal they win on the face of the document, and the officer carries the
   * s.20 exposure for the whole period that follows.
   *
   * `force` exists for the case the Act does not cover: the Registrar says send it anyway.
   * It requires a written reason, which goes in the audit trail next to the letter.
   */
  async recordReplyDespatched(
    tx: Tx,
    ctx: EngineContext,
    args: {
      rtiRequestId: string;
      despatchedOn: IsoDate;
      correspondenceId?: string | null;
      despatchNo?: string | null;
      force?: { reason: string } | null;
    },
    now?: Date,
  ): Promise<{ warnings: string[] }> {
    const row = await this.mustFind(tx, ctx, args.rtiRequestId);
    if (row.reply_despatched_on) {
      throw new ConflictError(
        `This reply is already recorded as despatched on ${row.reply_despatched_on}.`,
      );
    }
    if (!row.decision) {
      throw new DomainError('Record the decision before recording that the reply went out.');
    }

    const draft = await this.composeReply(tx, ctx, { rtiRequestId: args.rtiRequestId }, now);
    if (draft.defects.length > 0 && !args.force?.reason?.trim()) {
      throw new DomainError(
        'This reply is defective as it stands and cannot be recorded as sent:\n\n' +
          draft.defects.map((d) => `  - ${d}`).join('\n\n') +
          '\n\nFix these, or record a written reason for sending it anyway.',
      );
    }

    const correspondenceId = args.correspondenceId ?? draft.correspondenceId;
    await tx.execute(sql`
      UPDATE correspondence
      SET sent_at = ${`${args.despatchedOn}T00:00:00Z`}::timestamptz,
          despatch_no = COALESCE(${args.despatchNo ?? null}, despatch_no),
          despatch_date = CASE WHEN ${args.despatchNo ?? null}::text IS NOT NULL
                               THEN ${args.despatchedOn}::date ELSE despatch_date END
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${correspondenceId}::uuid
    `);

    await tx.execute(sql`
      UPDATE rti_request
      SET reply_despatched_on = ${args.despatchedOn}::date,
          reply_correspondence_id = ${correspondenceId}::uuid,
          state = 'replied'::rti_state,
          closure_note = COALESCE(closure_note, ${args.force?.reason?.trim() ?? null})
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.rtiRequestId}::uuid
    `);

    for (const stage of ['rti_reply_due', 'rti_prepare_reply'] as const) {
      await this.satisfyStage(tx, ctx, args.rtiRequestId, stage, `Despatched ${args.despatchedOn}`);
    }

    const after = await this.mustFind(tx, ctx, args.rtiRequestId);
    const clock = rtiClock(this.clockRow(after), this.today(ctx, now));
    const warnings: string[] = [];
    if (clock.penaltyExposureRupees > 0) {
      const late = daysBetween(after.due_on, args.despatchedOn);
      warnings.push(
        `Despatched ${late} ${late === 1 ? 'day' : 'days'} after the statutory date of ` +
          `${after.due_on}. Exposure under s.20(1) is Rs ` +
          `${clock.penaltyExposureRupees.toLocaleString('en-IN')}, imposed only by the ` +
          'Commission and only after a hearing, at which the burden of showing the officer ' +
          'acted reasonably and diligently is on the officer. The dated record on this file ' +
          'is what discharges it.',
      );
    }
    if (args.force?.reason?.trim()) {
      warnings.push(
        'This reply was recorded as sent while still defective, on a written reason. That ' +
          'reason is on the file and in the audit trail.',
      );
    }
    return { warnings };
  }

  /** The file is finished. Kept separate from `replied`, because an appeal can reopen it. */
  async close(
    tx: Tx,
    ctx: EngineContext,
    args: { rtiRequestId: string; note: string },
  ): Promise<void> {
    if (!args.note?.trim()) {
      throw new DomainError('Closing an RTI file needs a note saying why it is finished.');
    }
    await tx.execute(sql`
      UPDATE rti_request
      SET state = 'closed'::rti_state, closed_at = now(), closure_note = ${args.note.trim()}
      WHERE council_id = ${ctx.councilId}::uuid AND id = ${args.rtiRequestId}::uuid
    `);
    await tx.execute(sql`
      UPDATE follow_up SET status = 'superseded', resolution_note = 'RTI file closed'
      WHERE council_id = ${ctx.councilId}::uuid
        AND rti_request_id = ${args.rtiRequestId}::uuid
        AND status IN ('open','snoozed')
    `);
  }

  // ─── Reading ───────────────────────────────────────────────────────────────

  /** The RTI register: every application, newest first, with its clock. */
  async list(tx: Tx, ctx: EngineContext, now?: Date): Promise<Array<RtiRequestRow & { clock: RtiClock }>> {
    const today = this.today(ctx, now);
    const rows = await tx.execute<RtiRequestRow>(sql`
      SELECT ${RTI_COLUMNS} FROM rti_request
      ORDER BY received_on DESC, register_sl_no DESC
    `);
    return rows.rows.map((r) => ({ ...r, clock: rtiClock(this.clockRow(r), today) }));
  }

  /** One application and everything hanging off it. One call feeds the whole screen. */
  async get(tx: Tx, ctx: EngineContext, id: string, now?: Date): Promise<RtiFile | null> {
    const row = await this.find(tx, ctx, id);
    if (!row) return null;
    const today = this.today(ctx, now);

    // Sequential, not Promise.all. These all run on ONE connection inside the caller's
    // transaction, so concurrency buys nothing - node-pg simply queues them and warns that
    // the pattern is going away. Five small reads in a row is what this actually is.
    const exemptions = await this.exemptionsFor(tx, ctx, id);
    const cases = await tx.execute<{
      case_file_id: string; case_number: string; summary: string; note: string | null;
    }>(sql`
      SELECT l.case_file_id, c.case_number, c.summary, l.note
      FROM rti_case_link l JOIN case_file c ON c.id = l.case_file_id
      WHERE l.rti_request_id = ${id}::uuid ORDER BY c.case_number
    `);
    const letters = await tx.execute<{
      id: string; kind: string; subject: string; sent_at: string | null; despatch_no: string | null;
    }>(sql`
      SELECT id, kind, subject, sent_at, despatch_no FROM correspondence
      WHERE rti_request_id = ${id}::uuid ORDER BY created_at
    `);
    const documents = await tx.execute<{
      id: string; title: string; document_class: string; status: string;
    }>(sql`
      SELECT id, title, document_class, status FROM document
      WHERE rti_request_id = ${id}::uuid ORDER BY created_at
    `);
    const followups = await tx.execute<{
      id: string; stage: string; status: string; due_on: IsoDate; title: string;
    }>(sql`
      SELECT id, stage, status, due_on::text AS due_on, title FROM follow_up
      WHERE rti_request_id = ${id}::uuid AND status IN ('open','snoozed')
      ORDER BY due_on
    `);
    const officers = await this.officeHolders(tx, ctx, today);

    return {
      request: row,
      clock: rtiClock(this.clockRow(row), today),
      exemptions,
      cases: cases.rows,
      letters: letters.rows,
      documents: documents.rows,
      followups: followups.rows,
      officers,
    };
  }

  /** Every RTI touching a case, for the case file screen. */
  async forCase(
    tx: Tx,
    ctx: EngineContext,
    caseFileId: string,
  ): Promise<Array<{ id: string; rti_no: string; received_on: IsoDate; due_on: IsoDate; state: RtiState; note: string | null }>> {
    const rows = await tx.execute<{
      id: string; rti_no: string; received_on: IsoDate; due_on: IsoDate; state: RtiState; note: string | null;
    }>(sql`
      SELECT r.id, r.rti_no, r.received_on::text AS received_on, r.due_on::text AS due_on,
             r.state, l.note
      FROM rti_case_link l JOIN rti_request r ON r.id = l.rti_request_id
      WHERE l.case_file_id = ${caseFileId}::uuid
      ORDER BY r.received_on DESC
    `);
    return rows.rows;
  }

  /**
   * Who holds the two offices the Act names.
   *
   * Read, never defaulted. The Act requires the appellate authority to be an officer
   * senior in rank to the Public Information Officer (s.19(1)), so the two cannot be the
   * same person, and nobody has yet confirmed which of the officer and the Registrar holds
   * which. Guessing would put a real name on a statutory document.
   */
  async officeHolders(
    tx: Tx,
    ctx: EngineContext,
    today: IsoDate,
  ): Promise<{ pio: RtiOfficeHolder | null; firstAppellateAuthority: RtiOfficeHolder | null }> {
    const rows = await tx.execute<{ office: string; full_name: string; designation: string | null }>(sql`
      SELECT office, full_name, designation FROM council_office_holder
      WHERE council_id = ${ctx.councilId}::uuid
        AND office IN (${RTI_OFFICES.pio}, ${RTI_OFFICES.firstAppellateAuthority})
        AND starts_on <= ${today}::date
        AND (ends_on IS NULL OR ends_on >= ${today}::date)
      ORDER BY starts_on DESC
    `);
    const pick = (office: string): RtiOfficeHolder | null => {
      const r = rows.rows.find((x) => x.office === office);
      return r ? { fullName: r.full_name, designation: r.designation } : null;
    };
    return {
      pio: pick(RTI_OFFICES.pio),
      firstAppellateAuthority: pick(RTI_OFFICES.firstAppellateAuthority),
    };
  }

  /** Record who holds one of the two offices. Ends any live holder of the same office first. */
  async recordOfficeHolder(
    tx: Tx,
    ctx: EngineContext,
    args: {
      office: 'pio' | 'firstAppellateAuthority';
      fullName: string;
      designation?: string | null;
      startsOn: IsoDate;
    },
  ): Promise<void> {
    if (!args.fullName?.trim()) throw new DomainError('A name is required.');
    const office = RTI_OFFICES[args.office];

    await tx.execute(sql`
      UPDATE council_office_holder
      SET ends_on = ${addCalendarDays(args.startsOn, -1)}::date
      WHERE council_id = ${ctx.councilId}::uuid AND office = ${office}
        AND (ends_on IS NULL OR ends_on >= ${args.startsOn}::date)
    `);
    await tx.execute(sql`
      INSERT INTO council_office_holder (council_id, office, full_name, designation, starts_on)
      VALUES (${ctx.councilId}::uuid, ${office}, ${args.fullName.trim()},
              ${args.designation?.trim() ?? null}, ${args.startsOn}::date)
    `);
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────────

  private async find(tx: Tx, ctx: EngineContext, id: string): Promise<RtiRequestRow | null> {
    const rows = await tx.execute<RtiRequestRow>(sql`
      SELECT ${RTI_COLUMNS} FROM rti_request WHERE id = ${id}::uuid
    `);
    return rows.rows[0] ?? null;
  }

  private async mustFind(tx: Tx, ctx: EngineContext, id: string): Promise<RtiRequestRow> {
    const row = await this.find(tx, ctx, id);
    if (!row) throw new DomainError('That RTI application is not in the register.');
    return row;
  }

  private async exemptionsFor(tx: Tx, ctx: EngineContext, id: string): Promise<RtiExemptionRow[]> {
    const rows = await tx.execute<RtiExemptionRow>(sql`
      SELECT id, section, applies_to, reasoning FROM rti_exemption_cited
      WHERE rti_request_id = ${id}::uuid AND withdrawn_at IS NULL
      ORDER BY created_at
    `);
    return rows.rows;
  }

  private async satisfyStage(
    tx: Tx,
    ctx: EngineContext,
    rtiRequestId: string,
    stage: string,
    note: string,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE follow_up
      SET status = 'satisfied', satisfied_at = now(), satisfied_by = ${ctx.userId ?? null},
          resolution_note = ${note}
      WHERE council_id = ${ctx.councilId}::uuid
        AND rti_request_id = ${rtiRequestId}::uuid
        AND stage = ${stage}::followup_stage
        AND status IN ('open','snoozed')
    `);
  }

  private clockRow(r: RtiRequestRow) {
    return {
      receivedOn: r.received_on,
      dueOn: r.due_on,
      lifeOrLiberty: r.life_or_liberty,
      intendsToDiscloseThirdPartyOn: r.intends_to_disclose_third_party_on,
      furtherFeeIntimatedOn: r.further_fee_intimated_on,
      furtherFeePaidOn: r.further_fee_paid_on,
      thirdPartyNoticeSentOn: r.third_party_notice_sent_on,
      thirdPartyNoticeReceivedOn: r.third_party_notice_received_on,
      thirdPartyRepresentationOn: r.third_party_representation_on,
      transferredOn: r.transferred_on,
      replyDespatchedOn: r.reply_despatched_on,
    };
  }
}
