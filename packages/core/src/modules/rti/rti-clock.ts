import { RTI_DAYS, RTI_PENALTY } from '@ksdc/contracts';
import { addCalendarDays, daysBetween, type IsoDate } from '../../common/working-days.js';

/**
 * The RTI clock, and every alarm that hangs off it.
 *
 * Two things here are worth understanding before changing anything.
 *
 * FIRST: the deadline is NOT computed here. `dueOn` comes in from the database, where it
 * is a generated column on rti_request. This module derives everything ELSE from it — how
 * many days are left, whether the reply is already deemed refused, what the officer's
 * personal exposure is today, and whether the two clocks are about to collide. Deriving
 * the deadline in two places is how a deadline ends up meaning two different things, and
 * this one is enforced against a named person's salary.
 *
 * `predictDueOn` exists only so that arithmetic can be asserted against the database in a
 * test. Nothing in production reads it.
 *
 * SECOND: calendar days, never working days. s.7(1) says thirty days and the Commission
 * counts thirty days. A register that quietly added the Dasara holidays to an RTI deadline
 * would be telling the officer a comfortable lie about the one clock that costs them money
 * personally.
 */

export interface RtiClockRow {
  receivedOn: IsoDate;
  /** The generated column. The authority on when the reply is due. */
  dueOn: IsoDate;
  lifeOrLiberty?: boolean;
  intendsToDiscloseThirdPartyOn?: IsoDate | null;
  furtherFeeIntimatedOn?: IsoDate | null;
  furtherFeePaidOn?: IsoDate | null;
  thirdPartyNoticeSentOn?: IsoDate | null;
  thirdPartyNoticeReceivedOn?: IsoDate | null;
  thirdPartyRepresentationOn?: IsoDate | null;
  transferredOn?: IsoDate | null;
  replyDespatchedOn?: IsoDate | null;
}

export interface RtiClock {
  dueOn: IsoDate;
  /** Positive: days in hand. Negative: days past the statutory date. Zero: today. */
  daysRemaining: number;
  /** Days excluded under s.7(3)(a) because a further fee was outstanding. */
  excludedDays: number;
  /**
   * The clock is stopped: a further fee has been intimated and not paid. The date in
   * `dueOn` is therefore EARLIER than the true deadline, which is the safe direction.
   */
  onFeeHold: boolean;
  /**
   * s.7(2): the period has run out with nothing despatched, so the request is deemed to
   * have been refused. s.7(6) then makes the information free of any further charge.
   */
  deemedRefusal: boolean;
  /** s.20(1), as at today. Rs 250 a day, capped at Rs 25,000, out of the officer's salary. */
  penaltyExposureRupees: number;
  /** s.6(3). A transfer after this date keeps this officer's exposure for the overshoot. */
  transferDueOn: IsoDate;
  /** s.11(1), five days from receipt of the application. Null until s.11 is triggered. */
  thirdPartyNoticeDueOn: IsoDate | null;
  /** s.11(2), ten days from THEIR receipt of the notice. Null until that date is known. */
  thirdPartyRepresentationDueOn: IsoDate | null;
  /** s.19(1). Runs from the decision, or from the expiry where nothing was decided. */
  appealRunsFrom: IsoDate;
  /** Things the officer must be told now, in the order they matter. */
  warnings: string[];
}

/**
 * How many days the statutory period is, before any exclusion.
 *
 * Mirrors the CASE expression in the generated column in migration 0011, and is asserted
 * against it in rti.service.test.ts. Forty-eight hours is rendered as two days: an exact
 * timestamp would be correct and a date column cannot hold one, and two days is never
 * later than the true deadline.
 */
export function statutoryPeriodDays(row: {
  lifeOrLiberty?: boolean;
  intendsToDiscloseThirdPartyOn?: IsoDate | null;
}): number {
  if (row.lifeOrLiberty) return 2;
  if (row.intendsToDiscloseThirdPartyOn) return RTI_DAYS.replyWithThirdParty;
  return RTI_DAYS.reply;
}

/** The TypeScript mirror of the generated column. Test-only — production reads the column. */
export function predictDueOn(row: {
  receivedOn: IsoDate;
  lifeOrLiberty?: boolean;
  intendsToDiscloseThirdPartyOn?: IsoDate | null;
  furtherFeeIntimatedOn?: IsoDate | null;
  furtherFeePaidOn?: IsoDate | null;
}): IsoDate {
  const excluded =
    row.furtherFeePaidOn && row.furtherFeeIntimatedOn
      ? daysBetween(row.furtherFeeIntimatedOn, row.furtherFeePaidOn)
      : 0;
  return addCalendarDays(row.receivedOn, statutoryPeriodDays(row) + excluded);
}

export function rtiClock(row: RtiClockRow, today: IsoDate): RtiClock {
  const excludedDays =
    row.furtherFeePaidOn && row.furtherFeeIntimatedOn
      ? daysBetween(row.furtherFeeIntimatedOn, row.furtherFeePaidOn)
      : 0;

  const onFeeHold = Boolean(row.furtherFeeIntimatedOn) && !row.furtherFeePaidOn;
  const daysRemaining = daysBetween(today, row.dueOn);

  // Whether the deadline was met is decided by the DESPATCH, not by the decision being
  // recorded. A reply decided on the 29th and posted on the 34th is five days late, and
  // the Commission asks for the despatch particulars, not for the file note.
  const despatched = row.replyDespatchedOn ?? null;
  const answered = Boolean(despatched) || Boolean(row.transferredOn);
  const deemedRefusal = !answered && daysRemaining < 0;

  const daysLate = despatched
    ? Math.max(0, daysBetween(row.dueOn, despatched))
    : Math.max(0, -daysRemaining);
  const penaltyExposureRupees = answered && daysLate === 0
    ? 0
    : Math.min(daysLate * RTI_PENALTY.rupeesPerDay, RTI_PENALTY.capRupees);

  const transferDueOn = addCalendarDays(row.receivedOn, RTI_DAYS.transfer);

  const thirdPartyNoticeDueOn = row.intendsToDiscloseThirdPartyOn
    ? addCalendarDays(row.receivedOn, RTI_DAYS.thirdPartyNotice)
    : null;

  const thirdPartyRepresentationDueOn = row.thirdPartyNoticeReceivedOn
    ? addCalendarDays(row.thirdPartyNoticeReceivedOn, RTI_DAYS.thirdPartyRepresentation)
    : null;

  const appealRunsFrom = despatched ?? row.dueOn;

  return {
    dueOn: row.dueOn,
    daysRemaining,
    excludedDays,
    onFeeHold,
    deemedRefusal,
    penaltyExposureRupees,
    transferDueOn,
    thirdPartyNoticeDueOn,
    thirdPartyRepresentationDueOn,
    appealRunsFrom,
    warnings: warningsFor(row, today, {
      daysRemaining,
      deemedRefusal,
      onFeeHold,
      thirdPartyRepresentationDueOn,
      transferDueOn,
    }),
  };
}

/**
 * The alarms, most urgent first.
 *
 * The third one is the reason this function exists. The forty-day limit runs from the
 * council's receipt of the APPLICATION; the third party's ten days runs from THEIR receipt
 * of the NOTICE — a date the council does not control and does not learn until the
 * acknowledgement card comes back. Left alone, the officer discovers on day thirty-eight
 * that a dentist still has six days in which to object, and there is no lawful way to
 * shorten either period. It has to be said the day the card is logged.
 */
function warningsFor(
  row: RtiClockRow,
  today: IsoDate,
  derived: {
    daysRemaining: number;
    deemedRefusal: boolean;
    onFeeHold: boolean;
    thirdPartyRepresentationDueOn: IsoDate | null;
    transferDueOn: IsoDate;
  },
): string[] {
  const out: string[] = [];
  const answered = Boolean(row.replyDespatchedOn) || Boolean(row.transferredOn);

  if (derived.deemedRefusal) {
    const late = -derived.daysRemaining;
    out.push(
      `The statutory period expired on ${row.dueOn}, ${late} ${late === 1 ? 'day' : 'days'} ago. ` +
        'Under s.7(2) this is now a deemed refusal, and under s.7(6) the information must be ' +
        'supplied free of any further charge. Exposure under s.20(1) is Rs ' +
        `${Math.min(late * RTI_PENALTY.rupeesPerDay, RTI_PENALTY.capRupees).toLocaleString('en-IN')} ` +
        'so far, recovered from the officer personally.',
    );
  } else if (!answered && derived.daysRemaining <= 7) {
    out.push(
      `${derived.daysRemaining} ${derived.daysRemaining === 1 ? 'day' : 'days'} left: the reply ` +
        `must be despatched by ${row.dueOn}.`,
    );
  }

  // The collision. Checked whenever the representation window is known, answered or not,
  // because it is what decides whether the forty days was ever achievable.
  if (derived.thirdPartyRepresentationDueOn) {
    const slack = daysBetween(derived.thirdPartyRepresentationDueOn, row.dueOn);
    if (slack < 0) {
      out.push(
        `The third party's representation window closes on ${derived.thirdPartyRepresentationDueOn}, ` +
          `which is AFTER the statutory deadline of ${row.dueOn}. Section 11(2) gives them ten ` +
          'days from their own receipt of the notice and that period cannot be shortened. ' +
          'The decision cannot lawfully wait for it and cannot lawfully pre-empt it: take ' +
          "the Registrar's view now and record what was done and why.",
      );
    } else if (slack <= 3) {
      out.push(
        `The third party may reply up to ${derived.thirdPartyRepresentationDueOn}, leaving ` +
          `${slack} ${slack === 1 ? 'day' : 'days'} to decide and despatch by ${row.dueOn}. ` +
          'Draft both outcomes now rather than waiting to see which arrives.',
      );
    }
  }

  if (row.intendsToDiscloseThirdPartyOn && !row.thirdPartyNoticeSentOn) {
    const noticeDue = addCalendarDays(row.receivedOn, RTI_DAYS.thirdPartyNotice);
    const left = daysBetween(today, noticeDue);
    out.push(
      left < 0
        ? `The s.11(1) notice to the third party was due by ${noticeDue} and has not been sent.`
        : `The s.11(1) notice to the third party is due by ${noticeDue}.`,
    );
  }

  if (derived.onFeeHold) {
    out.push(
      `A further fee was intimated on ${row.furtherFeeIntimatedOn} and no payment is recorded. ` +
        'The clock is excluded under s.7(3)(a) until they pay, so the deadline shown here is ' +
        'earlier than the true one. A fee demanded after the period has already expired is ' +
        'void under s.7(6) and is itself a ground of complaint.',
    );
  }

  // NOT here: a warning that the five-day window for a s.6(3) transfer has closed.
  //
  // It was here, and it was wrong. Nothing about an application says whether a transfer is
  // contemplated, so the condition could only ever be "open, and more than five days old" -
  // which is true of almost every application for almost all of its life. On a file with
  // nothing whatever the matter with it, that was the ONLY line shown, and a healthy file
  // that displays a warning teaches the officer that warnings mean nothing. The same
  // sentence, with the real overshoot in days, is returned by RtiService.transfer() at the
  // moment a transfer is actually being recorded, which is the only moment it can change
  // what anybody does.

  return out;
}
