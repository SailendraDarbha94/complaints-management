import { sql } from 'drizzle-orm';
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

export const POST = withAuth(async ({ req, tx, ctx, services }) => {
  const body = (await jsonBody(req)) as IntakeInput;
  // JSON carries no date type, so the arrival timestamp comes over the wire as a string
  // and is turned back into a Date here rather than inside the service.
  return services.intake.create(tx, ctx, { ...body, receivedAt: new Date(body.receivedAt) });
});
