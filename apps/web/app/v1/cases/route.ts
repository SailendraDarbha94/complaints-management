import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CASE_KINDS, DATE_SOURCES, INTAKE_SOURCES } from '@ksdc/contracts';
import type { IntakeInput } from '@ksdc/core';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The register view: one row per case, the columns proposed in the build plan. */
export const GET = withAuth(async ({ tx }) => {
  const rows = await tx.execute(sql`
    SELECT c.register_sl_no, c.case_number, c.case_kind, c.state, c.waiting_on,
           c.on_hold, c.summary, c.intake_source,
           (now()::date - c.waiting_since::date) AS days_waiting,
           c.closed_at, c.closure_reason, c.is_backfilled, c.id,
           (SELECT p.full_name FROM case_party cp
              JOIN party p ON p.id = cp.party_id
             WHERE cp.case_file_id = c.id AND cp.role = 'complainant'
             LIMIT 1) AS complainant_name
    FROM case_file c
    WHERE c.deleted_at IS NULL
    ORDER BY c.register_sl_no DESC
  `);
  return { cases: rows.rows };
});

/**
 * Opening a case.
 *
 * This endpoint writes the first row of a legal register, and it had no input validation
 * at all - the body was cast and handed to the service. A missing receivedAt therefore
 * became `new Date(undefined)`, an Invalid Date, and the case number formatter produced
 * "NaN-NaN" for the fiscal year. The officer saw "Something went wrong at our end" and had
 * no way to know they had simply left out the date.
 *
 * Every field the service accepts is declared here, so a malformed body is refused with a
 * message naming the field rather than a 500.
 */
const PARTY = z.object({
  fullName: z.string().trim().min(1, 'A name.'),
  mobile: z.string().trim().max(32).nullish(),
  email: z.string().email().nullish(),
});

const intakeSchema = z.object({
  summary: z.string().trim().min(1, 'A one-line summary of the grievance.'),
  // Accepts an ISO timestamp or a plain date; refuses anything that is not a real moment,
  // because this value decides the case number, the fiscal year and every deadline after.
  receivedAt: z.coerce
    .date()
    .refine((d) => !Number.isNaN(d.getTime()), 'When the complaint actually arrived.'),
  caseKind: z.enum(CASE_KINDS).optional(),
  intakeSource: z.enum(INTAKE_SOURCES).optional(),
  dateSource: z.enum(DATE_SOURCES).optional(),
  externalRefNo: z.string().trim().nullish(),
  externalAuthorityName: z.string().trim().nullish(),
  externalDueAt: z.string().trim().nullish(),
  legacyRegisterRef: z.string().trim().nullish(),
  isBackfilled: z.boolean().optional(),
  complainant: PARTY.optional(),
  patient: z
    .object({
      fullName: z.string().trim().min(1, 'A name.'),
      ageYears: z.number().int().min(0).max(130).nullish(),
      sex: z.string().trim().max(16).nullish(),
    })
    .optional(),
});

export const POST = withAuth(async ({ req, tx, ctx, services }) => {
  const input = intakeSchema.parse(await jsonBody(req));
  return services.intake.create(tx, ctx, input as IntakeInput);
});
