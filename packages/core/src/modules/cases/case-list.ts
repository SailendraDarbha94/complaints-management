import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import type { EngineContext } from '../followups/followup.service.js';

/**
 * The cases list: the officer's working list, and what the tray's "Add to a case" picker
 * offers.
 *
 * This lived inline in the GET /v1/cases route handler until cancelling a case gave it a
 * rule worth testing - a case cancelled as opened in error is on neither list - and a rule
 * that only exists in a route handler is a rule no test reaches. The query is unchanged
 * apart from saying its council explicitly, as every service query here does, rather than
 * leaving that to row-level security alone.
 *
 * Cancelled cases are left out. Closed ones stay in, as before: they are finished, not
 * mistakes, and the officer still looks them up. The register is the list that keeps both.
 */

// A type rather than an interface: tx.execute<T> wants a Record, and only a type alias has
// the implicit index signature that satisfies it.
export type CaseListRow = {
  register_sl_no: number;
  case_number: string;
  case_kind: string;
  state: string;
  waiting_on: string;
  on_hold: boolean;
  summary: string;
  intake_source: string;
  days_waiting: number;
  closed_at: Date | null;
  closure_reason: string | null;
  is_backfilled: boolean;
  id: string;
  complainant_name: string | null;
};

export async function workingCaseList(tx: Tx, ctx: EngineContext): Promise<CaseListRow[]> {
  const rows = await tx.execute<CaseListRow>(sql`
    SELECT c.register_sl_no, c.case_number, c.case_kind, c.state, c.waiting_on,
           c.on_hold, c.summary, c.intake_source,
           (now()::date - c.waiting_since::date) AS days_waiting,
           c.closed_at, c.closure_reason, c.is_backfilled, c.id,
           (SELECT p.full_name FROM case_party cp
              JOIN party p ON p.id = cp.party_id
             WHERE cp.case_file_id = c.id AND cp.role = 'complainant'
             LIMIT 1) AS complainant_name
    FROM case_file c
    WHERE c.council_id = ${ctx.councilId}::uuid
      AND c.deleted_at IS NULL
    ORDER BY c.register_sl_no DESC
  `);
  return rows.rows;
}
