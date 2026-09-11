import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { council, appUser } from './platform.js';
import { caseFile } from './cases.js';
import { correspondence } from './correspondence.js';
import {
  dateSourceEnum,
  rtiChannelEnum,
  rtiDecisionEnum,
  rtiExemptionSectionEnum,
  rtiStateEnum,
} from './enums.js';

/**
 * The RTI register.
 *
 * A second book, next to the complaints register, not a row inside it. An RTI application
 * has its own statute, its own thirty-day clock, its own appeal route, and a penalty that
 * lands on a named officer's salary rather than on the council. It sometimes concerns a
 * complaint and sometimes concerns several; more often it concerns none of them.
 */

export const rtiRequest = pgTable(
  'rti_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),

    /** KSDC/RTI/2026-27/0007 — the RTI series of the same numbering machinery. */
    rtiNo: text('rti_no').notNull(),
    fiscalYear: text('fiscal_year').notNull(),
    registerSlNo: integer('register_sl_no').notNull(),

    /**
     * THE clock origin: the authority's own inward date. Not when it was typed in, and not
     * the date on the applicant's letter. Every period in the Act runs from this.
     */
    receivedOn: date('received_on').notNull(),
    receivedVia: rtiChannelEnum('received_via').notNull(),
    /** Anything but `recorded` is footnoted, exactly as it is on a case milestone. */
    dateSource: dateSourceEnum('date_source').notNull().default('recorded'),

    /**
     * The applicant. s.6(2) forbids asking why they want it, so there is nowhere to record
     * a reason: the absence of that column is the rule being enforced.
     */
    applicantName: text('applicant_name').notNull(),
    applicantAddressLines: jsonb('applicant_address_lines')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    applicantEmail: text('applicant_email'),
    applicantPhone: text('applicant_phone'),
    /** s.7(5) proviso: no fee at all from a person below the poverty line. */
    isBpl: boolean('is_bpl').notNull().default(false),

    /**
     * What they asked for, in their words, transcribed or pasted without paraphrase.
     *
     * The scope of the request is the thing every later argument turns on — whether the
     * reply was complete, whether a ground covers it, whether the Commission agrees. A
     * summary written by the officer would be the officer's account of the question they
     * then answered.
     */
    requestText: text('request_text').notNull(),
    /** Their own reference: a postal registration number, or a portal registration id. */
    externalRefNo: text('external_ref_no'),

    /** s.6(1): the ten-rupee application fee, where it came with the application. */
    applicationFeeReceived: boolean('application_fee_received').notNull().default(false),
    /**
     * s.7(3)(a): the only true stop-the-clock in the Act. The period between DESPATCH of
     * the intimation and PAYMENT is excluded, so both dates are needed or the deadline
     * cannot be computed at all.
     */
    furtherFeeIntimatedOn: date('further_fee_intimated_on'),
    furtherFeeAmount: numeric('further_fee_amount', { precision: 10, scale: 2 }),
    furtherFeePaidOn: date('further_fee_paid_on'),

    /** s.6(3). A transfer later than five days keeps this officer's personal exposure. */
    transferredTo: text('transferred_to'),
    transferredOn: date('transferred_on'),

    /**
     * s.7(1) proviso. Forty-eight hours, but only on demonstrably proven danger — so the
     * officer's reasoned decision on that claim is recorded next to the flag, because the
     * claim is made by the applicant and accepted or not by the council.
     */
    lifeOrLiberty: boolean('life_or_liberty').notNull().default(false),
    lifeOrLibertyReason: text('life_or_liberty_reason'),

    /**
     * s.11(1). The trigger is the officer's INTENTION TO DISCLOSE third-party information,
     * not the mere presence of a third party in the file — and on these files a third
     * party is present in every single one. Recording the intention as a dated decision is
     * what makes the forty-day period lawful rather than assumed.
     */
    intendsToDiscloseThirdPartyOn: date('intends_to_disclose_third_party_on'),
    thirdPartyName: text('third_party_name'),
    thirdPartyNoticeSentOn: date('third_party_notice_sent_on'),
    /** THEIR receipt. The ten days of s.11(2) runs from here, not from despatch. */
    thirdPartyNoticeReceivedOn: date('third_party_notice_received_on'),
    thirdPartyRepresentationOn: date('third_party_representation_on'),
    thirdPartyObjected: boolean('third_party_objected'),
    thirdPartyRepresentationNote: text('third_party_representation_note'),

    state: rtiStateEnum('state').notNull().default('received'),
    decision: rtiDecisionEnum('decision'),
    decidedOn: date('decided_on'),
    /** s.7(1) and s.7(8)(i): the reasons, in the officer's own words. */
    decisionReasons: text('decision_reasons'),

    replyCorrespondenceId: uuid('reply_correspondence_id').references(() => correspondence.id, {
      onDelete: 'set null',
    }),
    replyDespatchedOn: date('reply_despatched_on'),

    /**
     * The statutory date, derived in Postgres and never written by the application.
     *
     *   receipt + 30, or + 40 where s.11 applies, or + 2 for a life-or-liberty request,
     *   plus any period excluded because a further fee was outstanding.
     *
     * Generated rather than stored by the service for the same reason `waiting_on` is on
     * case_file: a deadline the application computes is a deadline that can drift from the
     * dates it was computed from, and this one carries a personal penalty.
     *
     * Two things it deliberately does NOT do:
     *
     *   - Forty-eight hours is rendered as two days. An exact timestamp would be correct
     *     and is not available in a date column; two days is never later than the true
     *     deadline, which is the safe direction, and at roughly one RTI a month this
     *     branch may never be used at all.
     *   - While a further fee is intimated and UNPAID the exclusion is zero, so the date
     *     shown is EARLIER than the true one. That is also deliberate: an officer who sees
     *     a nearer deadline acts sooner, and the alternative is a deadline that recedes
     *     indefinitely while an unpaid fee sits there.
     */
    dueOn: date('due_on').generatedAlwaysAs(
      sql`received_on
          + (CASE WHEN life_or_liberty THEN 2
                  WHEN intends_to_disclose_third_party_on IS NOT NULL THEN 40
                  ELSE 30 END)
          + COALESCE(further_fee_paid_on - further_fee_intimated_on, 0)`,
    ),

    closedAt: timestamp('closed_at', { withTimezone: true }),
    closureNote: text('closure_note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('rti_request_no_uq').on(t.councilId, t.rtiNo),
    uniqueIndex('rti_request_sl_uq').on(t.councilId, t.fiscalYear, t.registerSlNo),
    // The register view and the queue both read live requests by deadline.
    index('rti_request_due_ix')
      .on(t.councilId, t.dueOn)
      .where(sql`closed_at IS NULL`),
    // A fee intimation is meaningless without the date it was despatched, and the
    // exclusion cannot be computed from a payment with no intimation before it.
    check(
      'rti_fee_paid_needs_intimation',
      sql`(further_fee_paid_on IS NULL) OR (further_fee_intimated_on IS NOT NULL)`,
    ),
    check(
      'rti_fee_paid_not_before_intimation',
      sql`(further_fee_paid_on IS NULL) OR (further_fee_paid_on >= further_fee_intimated_on)`,
    ),
    // s.11 procedure cannot start without the decision that triggers it. This is the
    // statutory order of operations expressed as a constraint rather than as a convention.
    check(
      'rti_third_party_notice_needs_intent',
      sql`(third_party_notice_sent_on IS NULL) OR (intends_to_disclose_third_party_on IS NOT NULL)`,
    ),
    // A forty-eight-hour claim that nobody assessed is not a decision.
    check(
      'rti_life_or_liberty_needs_reason',
      sql`(life_or_liberty = false) OR (life_or_liberty_reason IS NOT NULL)`,
    ),
  ],
);

/**
 * Which cases, if any, an RTI application concerns.
 *
 * Many-to-many and entirely optional, because both directions really happen: one
 * application asking about four complaints, and one complaint attracting applications from
 * the complainant and from the dentist in turn. Most applications link to nothing.
 */
export const rtiCaseLink = pgTable(
  'rti_case_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    rtiRequestId: uuid('rti_request_id')
      .notNull()
      .references(() => rtiRequest.id, { onDelete: 'restrict' }),
    caseFileId: uuid('case_file_id')
      .notNull()
      .references(() => caseFile.id, { onDelete: 'restrict' }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('rti_case_link_uq').on(t.rtiRequestId, t.caseFileId),
    index('rti_case_link_case_ix').on(t.councilId, t.caseFileId),
  ],
);

/**
 * A ground relied on to withhold something, with the officer's reasoning.
 *
 * One row per section per part of the request, because a partial refusal genuinely cites
 * more than one: the treatment record under 8(1)(j), the expert's terms of engagement
 * under 8(1)(d). Each carries its own reasoning, because s.7(8)(i) requires reasons and a
 * bare citation is not a reason.
 *
 * The `section` column is an enum containing ONLY s.8(1)(a) to (j) and s.9. Section 11 is
 * not a value in it and must never become one: a refusal "under s.11" is defective and
 * appealable, and here it is not merely discouraged, it cannot be stored.
 */
export const rtiExemptionCited = pgTable(
  'rti_exemption_cited',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    councilId: uuid('council_id')
      .notNull()
      .references(() => council.id, { onDelete: 'restrict' }),
    rtiRequestId: uuid('rti_request_id')
      .notNull()
      .references(() => rtiRequest.id, { onDelete: 'restrict' }),
    section: rtiExemptionSectionEnum('section').notNull(),
    /** Which part of the request this ground answers. "Point 3" or "the treatment records". */
    appliesTo: text('applies_to').notNull(),
    /** Why, on these facts. Quoted into the reply verbatim. */
    reasoning: text('reasoning').notNull(),
    /**
     * Re-deciding before despatch withdraws the old grounds; it never deletes them. The
     * application role has no DELETE grant anywhere in this database, and on a
     * quasi-judicial record "what did this office rely on, and when did it stop" is a
     * question that has to have an answer.
     */
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
  },
  (t) => [index('rti_exemption_request_ix').on(t.councilId, t.rtiRequestId)],
);
