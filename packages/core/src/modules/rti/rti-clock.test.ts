import { describe, expect, it } from 'vitest';
import { predictDueOn, rtiClock, statutoryPeriodDays } from './rti-clock.js';

/**
 * The clock, on its own, with no database.
 *
 * These are the sums that decide whether a named officer loses Rs 250 a day out of their
 * salary, so they are tested against the section numbers rather than against what the code
 * currently does.
 */

const base = {
  receivedOn: '2026-04-01',
  dueOn: '2026-05-01', // 1 April + 30 days
};

describe('the statutory period', () => {
  it('is thirty days on an ordinary application (s.7(1))', () => {
    expect(statutoryPeriodDays({})).toBe(30);
    expect(predictDueOn({ receivedOn: '2026-04-01' })).toBe('2026-05-01');
  });

  it('is forty days once an intention to disclose third-party information is recorded', () => {
    // s.11(3). A net gain of ten days only - and the third party may use ten of them.
    expect(statutoryPeriodDays({ intendsToDiscloseThirdPartyOn: '2026-04-03' })).toBe(40);
    expect(
      predictDueOn({ receivedOn: '2026-04-01', intendsToDiscloseThirdPartyOn: '2026-04-03' }),
    ).toBe('2026-05-11');
  });

  it('is two days where life or liberty is accepted, and that beats the forty', () => {
    expect(
      statutoryPeriodDays({ lifeOrLiberty: true, intendsToDiscloseThirdPartyOn: '2026-04-03' }),
    ).toBe(2);
  });

  it('excludes the period a further fee was outstanding, and nothing else (s.7(3)(a))', () => {
    expect(
      predictDueOn({
        receivedOn: '2026-04-01',
        furtherFeeIntimatedOn: '2026-04-05',
        furtherFeePaidOn: '2026-04-12',
      }),
    ).toBe('2026-05-08'); // 30 + the seven days it was outstanding
  });

  it('excludes nothing while the fee is intimated and unpaid', () => {
    // Deliberate, and stated in the migration: the date shown is EARLIER than the true
    // one. An officer who sees a nearer deadline acts sooner, and the alternative is a
    // deadline that recedes indefinitely while an unpaid fee sits there.
    expect(predictDueOn({ receivedOn: '2026-04-01', furtherFeeIntimatedOn: '2026-04-05' })).toBe(
      '2026-05-01',
    );
  });
});

describe('where the file stands today', () => {
  it('counts the days left', () => {
    expect(rtiClock(base, '2026-04-20').daysRemaining).toBe(11);
    expect(rtiClock(base, '2026-05-01').daysRemaining).toBe(0);
  });

  it('is not a deemed refusal on the due date itself', () => {
    const c = rtiClock(base, '2026-05-01');
    expect(c.deemedRefusal).toBe(false);
    expect(c.penaltyExposureRupees).toBe(0);
  });

  it('becomes a deemed refusal the day after, and starts counting the penalty', () => {
    const c = rtiClock(base, '2026-05-02');
    expect(c.deemedRefusal).toBe(true);
    expect(c.penaltyExposureRupees).toBe(250);
    expect(c.warnings[0]).toMatch(/deemed refusal/i);
    expect(c.warnings[0]).toMatch(/free of any further charge|free/i);
  });

  it('caps the penalty at Rs 25,000, which arrives at a hundred days', () => {
    expect(rtiClock(base, '2026-08-09').penaltyExposureRupees).toBe(25_000); // 99 days
    expect(rtiClock(base, '2026-08-10').penaltyExposureRupees).toBe(25_000); // 100
    expect(rtiClock(base, '2027-08-10').penaltyExposureRupees).toBe(25_000); // a year on
  });

  it('measures lateness by the DESPATCH, not by the day the decision was taken', () => {
    // A reply decided on the 29th and posted on the 6th is five days late. The Commission
    // asks for the despatch particulars, not for the file note.
    const c = rtiClock({ ...base, replyDespatchedOn: '2026-05-06' }, '2026-06-01');
    expect(c.deemedRefusal).toBe(false);
    expect(c.penaltyExposureRupees).toBe(5 * 250);
  });

  it('has no exposure at all where the reply went out in time', () => {
    const c = rtiClock({ ...base, replyDespatchedOn: '2026-04-28' }, '2026-06-01');
    expect(c.penaltyExposureRupees).toBe(0);
    expect(c.deemedRefusal).toBe(false);
  });
});

describe('the two clocks colliding', () => {
  // The trap. The forty days runs from the council's receipt of the APPLICATION; the third
  // party's ten days runs from THEIR receipt of the NOTICE, which the council does not
  // control and does not learn until the acknowledgement card comes back.
  const withS11 = {
    receivedOn: '2026-04-01',
    dueOn: '2026-05-11',
    intendsToDiscloseThirdPartyOn: '2026-04-03',
    thirdPartyNoticeSentOn: '2026-04-04',
  };

  it('says nothing while the windows do not overlap', () => {
    const c = rtiClock({ ...withS11, thirdPartyNoticeReceivedOn: '2026-04-08' }, '2026-04-09');
    // Their window closes 18 April, three weeks before the deadline.
    expect(c.thirdPartyRepresentationDueOn).toBe('2026-04-18');
    expect(c.warnings.join(' ')).not.toMatch(/representation window/i);
  });

  it('warns when their window closes within three days of the deadline', () => {
    const c = rtiClock({ ...withS11, thirdPartyNoticeReceivedOn: '2026-04-29' }, '2026-04-30');
    expect(c.thirdPartyRepresentationDueOn).toBe('2026-05-09');
    expect(c.warnings.join(' ')).toMatch(/leaving 2 days to decide and despatch/i);
  });

  it('raises the alarm when their window closes AFTER the statutory deadline', () => {
    const c = rtiClock({ ...withS11, thirdPartyNoticeReceivedOn: '2026-05-04' }, '2026-05-05');
    expect(c.thirdPartyRepresentationDueOn).toBe('2026-05-14'); // after 11 May
    const said = c.warnings.join(' ');
    expect(said).toMatch(/AFTER the statutory deadline/);
    expect(said).toMatch(/cannot be shortened/);
    expect(said).toMatch(/Registrar/);
  });

  it('chases the s.11 notice itself while it has not gone out', () => {
    const c = rtiClock(
      {
        receivedOn: '2026-04-01',
        dueOn: '2026-05-11',
        intendsToDiscloseThirdPartyOn: '2026-04-03',
      },
      '2026-04-04',
    );
    expect(c.thirdPartyNoticeDueOn).toBe('2026-04-06');
    expect(c.warnings.join(' ')).toMatch(/s\.11\(1\) notice/);
  });
});

describe('the fee', () => {
  it('says the deadline shown is earlier than the true one while the fee is unpaid', () => {
    const c = rtiClock({ ...base, furtherFeeIntimatedOn: '2026-04-10' }, '2026-04-20');
    expect(c.onFeeHold).toBe(true);
    expect(c.warnings.join(' ')).toMatch(/excluded under s\.7\(3\)\(a\)/);
    expect(c.warnings.join(' ')).toMatch(/void under s\.7\(6\)/);
  });

  it('reports the excluded days once it is paid', () => {
    const c = rtiClock(
      {
        receivedOn: '2026-04-01',
        dueOn: '2026-05-08',
        furtherFeeIntimatedOn: '2026-04-05',
        furtherFeePaidOn: '2026-04-12',
      },
      '2026-04-20',
    );
    expect(c.excludedDays).toBe(7);
    expect(c.onFeeHold).toBe(false);
  });
});
