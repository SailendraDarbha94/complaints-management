import { z } from 'zod';
import {
  CASE_OUTCOMES,
  CLOSURE_REASONS,
  FOLLOWUP_STAGES,
  type FollowupStage,
} from '@ksdc/contracts';

/**
 * Per-council configuration is ONE validated JSONB document plus a checked-in seed file —
 * not fifteen tables with fifteen CRUD screens for a single tenant with a single set of
 * values (build plan D8). Onboarding council #2 is a second seed file.
 *
 * There are no settings screens in v1. Changing a value is a pull request, which for a
 * legal register is a feature.
 */

/** Monday = 1 … Sunday = 7, matching ISO-8601 and Postgres `isodow`. */
export const workingWeekdaysSchema = z
  .array(z.number().int().min(1).max(7))
  .min(1)
  .max(7)
  .describe('ISO weekday numbers the council office is open');

export const followupRuleSchema = z.object({
  stage: z.enum(FOLLOWUP_STAGES),
  /** Days allowed before the follow-up falls due. */
  dueInDays: z.number().int().min(0).max(365),
  /** Working days skip weekends and holidays; statutory clocks must not. */
  basis: z.enum(['working_days', 'calendar_days']),
  /** How many times this follow-up escalates before it stops and asks the officer. */
  maxEscalations: z.number().int().min(0).max(10),
  /** Gap between escalations, in the same basis. */
  escalationGapDays: z.number().int().min(1).max(365),
  /**
   * What the engine does after the last escalation. It never decides anything adverse:
   * it opens a proposal for the officer, or simply stops.
   */
  terminalAction: z.enum(['propose_ex_parte', 'propose_closure', 'none']),
  /** Statutory clocks cannot be snoozed past their due date. */
  isStatutory: z.boolean().default(false),
  label: z.string().min(3),
});
export type FollowupRule = z.infer<typeof followupRuleSchema>;

export const councilConfigSchema = z.object({
  schemaVersion: z.literal(1),

  /**
   * Highest build phase enabled. Gates Phase 3+ events out of the UI.
   * A literal union rather than a bare number, so it satisfies BuildPhase in
   * @ksdc/contracts without a cast at every call site.
   */
  buildPhase: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)])
    .default(1),

  numbering: z.object({
    /** Prefix in every case number: KSDC/COMP/2026-27/0042. */
    councilCode: z.string().regex(/^[A-Z]{2,8}$/),
    /** Month the financial year starts. 4 = April, everywhere in India. */
    fiscalYearStartMonth: z.literal(4),
    serialPadding: z.number().int().min(3).max(6).default(4),
    /**
     * The software NEVER generates the office-wide outward despatch number — that book
     * is shared with certificates and circulars issued by people who will never touch
     * this system (build plan D2). It records what the office stamped.
     */
    despatchNumberIsExternal: z.literal(true),
  }),

  calendar: z.object({
    timezone: z.literal('Asia/Kolkata'),
    workingWeekdays: workingWeekdaysSchema,
    /** ISO dates the office is shut. Government holidays; add each year. */
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
    /** When the daily digest is sent, in council-local time. */
    digestHourLocal: z.number().int().min(0).max(23).default(9),
  }),

  followupRules: z.array(followupRuleSchema).min(1),

  respondents: z.object({
    /**
     * How many notices before ex parte becomes *eligible*. This is a warning with a
     * typed-reason override, never a hard block (build plan D3) — it came from one
     * sentence in an interview, not from a statute anyone has checked.
     */
    noticesBeforeExParte: z.number().int().min(1).max(10),
    /** Whether the final notice should be flagged for registered post with A/D. */
    finalNoticeRequiresProofOfService: z.boolean().default(true),
  }),

  closureReasons: z.array(z.enum(CLOSURE_REASONS)).min(1),
  outcomes: z.array(z.enum(CASE_OUTCOMES)).min(1),

  expertBody: z.object({
    name: z.string().min(3),
    addresseeTitle: z.string().min(3),
    addressLines: z.array(z.string()).min(1),
    /** The two fixed questions the referral letter asks. Editing these changes the
     * terms of reference, so the template is flagged and warns on publish. */
    referralQuestions: z.array(z.string().min(10)).min(1),
  }),

  /**
   * AI ships disabled with no API key provisioned (build plan D10). The gate to turn it
   * on is a signed one-page disclosure to the Registrar stating what leaves India.
   */
  aiEnabled: z.literal(false).or(z.boolean()).default(false),

  /**
   * The user's explicit requirement (Q26): members see all complaints. Kept as a setting
   * so it can be narrowed after a word with the Registrar rather than argued about now.
   */
  memberSeesAllCases: z.boolean().default(true),

  retention: z.object({
    /** Nothing is deleted in v1. This is what the Registrar signs off in Phase 5. */
    caseRecordsYears: z.number().int().min(1).nullable(),
    backupYears: z.number().int().min(1),
  }),
});

export type CouncilConfig = z.infer<typeof councilConfigSchema>;

export function parseCouncilConfig(input: unknown): CouncilConfig {
  return councilConfigSchema.parse(input);
}

export function followupRuleFor(config: CouncilConfig, stage: FollowupStage): FollowupRule {
  const rule = config.followupRules.find((r) => r.stage === stage);
  if (!rule) throw new Error(`No follow-up rule configured for stage "${stage}"`);
  return rule;
}
