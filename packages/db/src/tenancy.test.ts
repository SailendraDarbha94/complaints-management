import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CASE_STATES, WAITING_ON_BY_STATE } from '@ksdc/contracts';
import { closeDb, getDb, initDb, withCouncil, type Db } from './client.js';

/**
 * The required CI isolation check (build plan §11).
 *
 * Tenant isolation is enforced by Postgres, not by remembering a WHERE clause. These
 * tests connect as `app_rw` — the role the API actually uses — so they exercise the real
 * policies and the real grants.
 */

let db: Db;
const councilA = '11111111-1111-4111-8111-111111111111';
const councilB = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });

  for (const [id, code, name] of [
    [councilA, 'KSDC', 'Karnataka State Dental Council'],
    [councilB, 'TNDC', 'Tamil Nadu Dental Council'],
  ] as const) {
    await withCouncil({ councilId: id }, async (tx) => {
      await tx.execute(sql`
        INSERT INTO council (id, code, name, address_lines, official_email, registrar_name, is_synthetic)
        VALUES (${id}::uuid, ${code}, ${name}, '[]'::jsonb, ${`registrar@${code.toLowerCase()}.in`},
                'Test Registrar', true)
        ON CONFLICT (id) DO NOTHING
      `);
    });
  }
});

afterAll(async () => {
  await closeDb();
});

describe('row-level security', () => {
  it('every public table carrying council_id has RLS enabled, forced, and a policy', async () => {
    // This is the check that matters. A new table added without a policy would be
    // readable across councils; the build must fail rather than the data leak.
    const res = await db.execute<{
      table_name: string;
      rls_enabled: boolean;
      rls_forced: boolean;
      policies: number;
    }>(sql`
      SELECT c.relname            AS table_name,
             c.relrowsecurity     AS rls_enabled,
             c.relforcerowsecurity AS rls_forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND (
          EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'council_id' AND NOT a.attisdropped)
          OR c.relname = 'council'
        )
      ORDER BY c.relname
    `);

    expect(res.rows.length).toBeGreaterThan(15);
    const bad = res.rows.filter((r) => !r.rls_enabled || !r.rls_forced || r.policies < 1);
    expect(
      bad.map((b) => b.table_name),
      'tables carrying council_id without enabled+forced RLS and a policy',
    ).toEqual([]);
  });

  it('shows council B exactly zero rows of council A', async () => {
    const caseId = crypto.randomUUID();

    await withCouncil({ councilId: councilA }, async (tx) => {
      await tx.execute(sql`
        INSERT INTO case_file (id, council_id, case_number, fiscal_year, register_sl_no, summary)
        VALUES (${caseId}::uuid, ${councilA}::uuid, 'KSDC/COMP/2026-27/0001', '2026-27', 1,
                'Council A case')
      `);
    });

    const fromA = await withCouncil({ councilId: councilA }, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM case_file`),
    );
    expect(fromA.rows[0]!.n).toBe(1);

    const fromB = await withCouncil({ councilId: councilB }, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM case_file`),
    );
    expect(fromB.rows[0]!.n).toBe(0);

    // And not by direct id, either — the policy is not a filter the caller can dodge.
    const byId = await withCouncil({ councilId: councilB }, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM case_file WHERE id = ${caseId}::uuid`,
      ),
    );
    expect(byId.rows[0]!.n).toBe(0);
  });

  it('returns zero rows — never another council’s data — when the scope is unset', async () => {
    const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM case_file`);
    expect(res.rows[0]!.n).toBe(0);
  });

  it('refuses to write a row belonging to another council', async () => {
    await expect(
      withCouncil({ councilId: councilB }, async (tx) => {
        await tx.execute(sql`
          INSERT INTO case_file (council_id, case_number, fiscal_year, register_sl_no, summary)
          VALUES (${councilA}::uuid, 'KSDC/COMP/2026-27/0099', '2026-27', 99, 'smuggled')
        `);
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('does not let the application role delete anything', async () => {
    await expect(
      withCouncil({ councilId: councilA }, async (tx) => {
        await tx.execute(sql`DELETE FROM case_file`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('scopes the setting to the transaction, so a pooled connection cannot leak it', async () => {
    await withCouncil({ councilId: councilA }, async (tx) => {
      const r = await tx.execute<{ v: string | null }>(
        sql`SELECT current_setting('app.council_id', true) AS v`,
      );
      expect(r.rows[0]!.v).toBe(councilA);
    });
    const after = await db.execute<{ v: string | null }>(
      sql`SELECT nullif(current_setting('app.council_id', true), '') AS v`,
    );
    expect(after.rows[0]!.v).toBeNull();
  });
});

describe('the generated waiting_on column', () => {
  it('agrees with WAITING_ON_BY_STATE for every state', async () => {
    // The Postgres CASE expression and the TypeScript mirror must never drift — the
    // dashboard reads one and the tests read the other.
    await withCouncil({ councilId: councilA }, async (tx) => {
      for (const [i, state] of CASE_STATES.entries()) {
        const id = crypto.randomUUID();
        const closedCols =
          state === 'closed' ? sql`, closed_at, closure_reason` : sql``;
        const closedVals =
          state === 'closed' ? sql`, now(), 'withdrawn'::closure_reason` : sql``;

        await tx.execute(sql`
          INSERT INTO case_file (id, council_id, case_number, fiscal_year, register_sl_no, state, summary${closedCols})
          VALUES (${id}::uuid, ${councilA}::uuid, ${`KSDC/COMP/2026-27/${String(500 + i).padStart(4, '0')}`},
                  '2026-27', ${500 + i}, ${state}::case_state, 'waiting_on probe'${closedVals})
        `);

        const r = await tx.execute<{ waiting_on: string }>(
          sql`SELECT waiting_on FROM case_file WHERE id = ${id}::uuid`,
        );
        expect(r.rows[0]!.waiting_on, `state ${state}`).toBe(WAITING_ON_BY_STATE[state]);
      }
    });
  });

  it('cannot be written by the application', async () => {
    await expect(
      withCouncil({ councilId: councilA }, async (tx) => {
        await tx.execute(sql`UPDATE case_file SET waiting_on = 'nobody'`);
      }),
    ).rejects.toThrow(/can only be updated to DEFAULT/i);
  });
});

describe('the check constraints that protect the register', () => {
  it('refuses to close a case without a reason', async () => {
    await expect(
      withCouncil({ councilId: councilA }, async (tx) => {
        await tx.execute(sql`
          INSERT INTO case_file (council_id, case_number, fiscal_year, register_sl_no, state, summary)
          VALUES (${councilA}::uuid, 'KSDC/COMP/2026-27/0900', '2026-27', 900,
                  'closed'::case_state, 'no reason given')
        `);
      }),
    ).rejects.toThrow(/case_file_closed_needs_reason/);
  });

  it('refuses to hold a case without a reason', async () => {
    await expect(
      withCouncil({ councilId: councilA }, async (tx) => {
        await tx.execute(sql`
          INSERT INTO case_file (council_id, case_number, fiscal_year, register_sl_no, summary, on_hold)
          VALUES (${councilA}::uuid, 'KSDC/COMP/2026-27/0901', '2026-27', 901, 'held', true)
        `);
      }),
    ).rejects.toThrow(/case_file_hold_needs_reason/);
  });

  it('refuses a despatch number with no despatch date', async () => {
    await expect(
      withCouncil({ councilId: councilA }, async (tx) => {
        await tx.execute(sql`
          INSERT INTO correspondence (council_id, kind, direction, subject, body, despatch_no)
          VALUES (${councilA}::uuid, 'request_docs'::correspondence_kind, 'out'::contact_direction,
                  'Subject', 'Body', 'KSDC/297/2026-27')
        `);
      }),
    ).rejects.toThrow(/correspondence_despatch_needs_date/);
  });

  it('refuses two letters claiming the same despatch number', async () => {
    await withCouncil({ councilId: councilA }, async (tx) => {
      await tx.execute(sql`
        INSERT INTO correspondence (council_id, kind, direction, subject, body, despatch_no, despatch_date)
        VALUES (${councilA}::uuid, 'request_docs'::correspondence_kind, 'out'::contact_direction,
                'First', 'Body', 'KSDC/297/2026-27', '2026-08-13')
      `);
    });

    await expect(
      withCouncil({ councilId: councilA }, async (tx) => {
        await tx.execute(sql`
          INSERT INTO correspondence (council_id, kind, direction, subject, body, despatch_no, despatch_date)
          VALUES (${councilA}::uuid, 'request_docs'::correspondence_kind, 'out'::contact_direction,
                  'Second', 'Body', 'KSDC/297/2026-27', '2026-08-14')
        `);
      }),
    ).rejects.toThrow(/correspondence_despatch_uq/);
  });
});
