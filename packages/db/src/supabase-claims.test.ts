import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';

/**
 * The second enforcement path.
 *
 * The React Native app talks to Supabase directly, so its queries never pass through
 * withCouncil() and never set app.council_id. They arrive as the `authenticated` role with
 * a verified JWT, and are filtered by the policies migration 0006 adds. That is a whole
 * second security model over the same tables, and a policy nobody ever runs is how a
 * council's complaints end up on another council's screen.
 *
 * These run on plain PostgreSQL. Migration 0006 creates Supabase's three roles and an
 * auth.uid()/auth.jwt() shim whose bodies were copied from the live project, so setting
 * request.jwt.claims here exercises the same expression PostgREST triggers in Mumbai.
 *
 * Connects as the OWNER rather than app_rw, because these tests have to SET ROLE to
 * authenticated and to anon, and to grant and revoke while doing it.
 */

let db: Db;
let close: () => Promise<void>;

const councilA = '31111111-1111-4111-8111-111111111111';
const councilB = '32222222-2222-4222-8222-222222222222';
const sbUserA = '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sbUserStranger = '3bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let appUserA: string;

const claims = (o: Record<string, unknown>) =>
  JSON.stringify({ sub: sbUserA, role: 'authenticated', aud: 'authenticated', app_metadata: { app_user_id: appUserA, ...o } });

/** Everything a direct client does, inside one rolled-back transaction. */
async function asAuthenticated<T>(
  jwtClaims: string,
  body: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>,
): Promise<T | string> {
  try {
    return await db.transaction(async (tx) => {
      // A real direct client already holds SELECT; the grant is deliberately withheld in
      // 0006 until the mobile app exists, so it is granted here to test the POLICY rather
      // than the grant. Rolled back with the transaction.
      await tx.execute(sql`GRANT SELECT ON public.case_file TO authenticated`);
      await tx.execute(sql`SELECT set_config('request.jwt.claims', ${jwtClaims}, true)`);
      await tx.execute(sql`SET LOCAL ROLE authenticated`);
      const out = await body(tx);
      throw Object.assign(new Error('rollback'), { out });
    });
  } catch (e) {
    const wrapped = e as { out?: T; message?: string };
    if (wrapped.out !== undefined) return wrapped.out;
    return String(wrapped.message ?? e);
  }
}

beforeAll(async () => {
  const made = createDb({ connectionString: process.env.TEST_DATABASE_URL_SUPER! });
  db = made.db;
  close = made.close;

  for (const [id, code] of [
    [councilA, 'JWTA'],
    [councilB, 'JWTB'],
  ] as const) {
    await db.execute(sql`
      INSERT INTO council (id, code, name, address_lines, official_email, registrar_name, is_synthetic)
      VALUES (${id}::uuid, ${code}, ${code}, '[]'::jsonb, ${`r@${code.toLowerCase()}.in`}, 'R', true)
      ON CONFLICT (id) DO NOTHING
    `);
  }

  const u = await db.execute<{ id: string }>(sql`
    INSERT INTO app_user (email, full_name, supabase_user_id)
    VALUES ('jwt-officer@ksdc.in', 'JWT Officer', ${sbUserA}::uuid)
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  appUserA =
    u.rows[0]?.id ??
    (await db.execute<{ id: string }>(sql`SELECT id FROM app_user WHERE supabase_user_id = ${sbUserA}::uuid`))
      .rows[0]!.id;

  await db.execute(sql`
    INSERT INTO council_membership (council_id, app_user_id, role, starts_on)
    VALUES (${councilA}::uuid, ${appUserA}::uuid, 'officer', current_date - 30)
    ON CONFLICT DO NOTHING
  `);

  // One case in each council, so "sees only its own" is a real assertion.
  for (const [council, no] of [
    [councilA, 'JWTA/COMP/2026-27/0001'],
    [councilB, 'JWTB/COMP/2026-27/0001'],
  ] as const) {
    await db.execute(sql`
      INSERT INTO case_file (council_id, case_number, register_sl_no, fiscal_year, case_kind, summary)
      VALUES (${council}::uuid, ${no}, 1, '2026-27', 'patient_complaint', 'A complaint')
      ON CONFLICT DO NOTHING
    `);
  }
});

afterAll(async () => {
  await close();
});

describe('a direct client filtered by JWT claims', () => {
  it('sees its own council and no other', async () => {
    const rows = await asAuthenticated(claims({ council_id: councilA }), async (tx) => {
      const r = await tx.execute<{ council_id: string }>(sql`SELECT council_id FROM case_file`);
      return r.rows.map((x) => x.council_id);
    });
    expect(rows).toEqual([councilA]);
  });

  it('sees nothing when the council_id claim is forged', async () => {
    // The signature is checked before the query, so a forged claim means a council the
    // holder is not a member of - not a tampered token.
    const rows = await asAuthenticated(claims({ council_id: councilB }), async (tx) =>
      (await tx.execute(sql`SELECT 1 FROM case_file`)).rows.length,
    );
    expect(rows).toBe(0);
  });

  it('sees nothing with no claims at all', async () => {
    const rows = await asAuthenticated('{}', async (tx) =>
      (await tx.execute(sql`SELECT 1 FROM case_file`)).rows.length,
    );
    expect(rows).toBe(0);
  });

  it('stops seeing anything the day a membership ends, not when the token expires', async () => {
    // The claim is re-checked against a live membership on every row. An access token
    // lives an hour; a committee member whose term ended this morning must stop reading
    // complaints this morning.
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`GRANT SELECT ON public.case_file TO authenticated`);
      await tx.execute(sql`
        UPDATE council_membership SET ends_on = current_date - 1
        WHERE app_user_id = ${appUserA}::uuid AND council_id = ${councilA}::uuid
      `);
      await tx.execute(sql`SELECT set_config('request.jwt.claims', ${claims({ council_id: councilA })}, true)`);
      await tx.execute(sql`SET LOCAL ROLE authenticated`);
      const r = await tx.execute(sql`SELECT 1 FROM case_file`);
      await tx.execute(sql`SET LOCAL ROLE none`);
      await tx.rollback();
      return r.rows.length;
    }).catch(() => 0);
    expect(rows).toBe(0);
  });

  it('cannot write, because the policy is FOR SELECT only', async () => {
    const result = await asAuthenticated(claims({ council_id: councilA }), async (tx) => {
      await tx.execute(sql`UPDATE case_file SET summary = 'tampered'`);
      return 'ALLOWED';
    });
    expect(result).not.toBe('ALLOWED');
    expect(String(result)).toMatch(/permission denied/i);
  });
});

describe('what Supabase exposes by default', () => {
  /**
   * The finding this whole migration exists for. A Supabase project grants ALL privileges,
   * DELETE included, on every new public table to anon, authenticated and service_role.
   * Four of this schema's tables carry no row-level security by design, so under those
   * defaults they are readable and deletable over HTTPS by an unauthenticated caller.
   */
  it.each(['app_user', 'auth_otp', 'auth_session', 'job_run'])(
    'keeps %s unreachable by anon',
    async (table) => {
      const reachable = await db.execute<{ ok: boolean }>(sql`
        SELECT has_table_privilege('anon', ${`public.${table}`}, 'SELECT') AS ok
      `);
      expect(reachable.rows[0]!.ok).toBe(false);
    },
  );

  it('grants DELETE on nothing in public, to any role the application uses', async () => {
    const rows = await db.execute<{ relname: string; rolname: string }>(sql`
      SELECT c.relname, r.rolname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (SELECT unnest(ARRAY['anon','authenticated','service_role','app_rw']) AS rolname) r
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND has_table_privilege(r.rolname, c.oid, 'DELETE')
    `);
    expect(rows.rows).toEqual([]);
  });

  /**
   * The exact set a committee member's phone may read, and nothing else.
   *
   * This was "no table is granted to anyone" until migration 0010, which is what the grant
   * decision changed. It is a WHITELIST rather than a relaxation: a table added to the
   * schema, or granted in passing by a future migration, fails this test until somebody
   * writes it down here - which is the point, because the grant is what decides whether a
   * phone may ask at all.
   *
   * The test applied when choosing them was: would this have been in the photocopy the
   * member gets today?
   */
  const READABLE_BY_A_MEMBER = [
    'case_file',
    'case_milestone',
    'case_party',
    'case_respondent',
    'document',
    'document_version',
    'party',
    'registered_dentist',
  ];

  it('lets authenticated read exactly the case-file tables, and no others', async () => {
    const rows = await db.execute<{ relname: string }>(sql`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND has_table_privilege('authenticated', c.oid, 'SELECT')
      ORDER BY c.relname
    `);
    expect(rows.rows.map((r) => r.relname)).toEqual(READABLE_BY_A_MEMBER);
  });

  it.each(['follow_up', 'correspondence', 'contact_event', 'case_note', 'case_state_history'])(
    'keeps %s away from a committee member',
    async (table) => {
      // Each of these is deliberate. follow_up is the officer's chase list; correspondence
      // is every letter including unsent drafts; the rest are working notes and an audit
      // trail. follow_up and correspondence even carry a jwt_council_isolation policy - they
      // stay unreachable because no grant follows it, which is the layering working.
      const ok = await db.execute<{ ok: boolean }>(sql`
        SELECT has_table_privilege('authenticated', ${`public.${table}`}, 'SELECT') AS ok
      `);
      expect(ok.rows[0]!.ok).toBe(false);
    },
  );

  it('never lets anon read anything, and lets neither role write', async () => {
    const anon = await db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND has_table_privilege('anon', c.oid, 'SELECT')
    `);
    expect(Number(anon.rows[0]!.n)).toBe(0);

    const writes = await db.execute<{ n: string }>(sql`
      SELECT count(*) AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (SELECT unnest(ARRAY['anon','authenticated']) AS rolname) r
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND (has_table_privilege(r.rolname, c.oid, 'INSERT')
          OR has_table_privilege(r.rolname, c.oid, 'UPDATE')
          OR has_table_privilege(r.rolname, c.oid, 'DELETE'))
    `);
    // A phone never writes to the register: audit.append() takes its actor from settings a
    // direct client never sets, so a direct write would land unattributed.
    expect(Number(writes.rows[0]!.n)).toBe(0);
  });
});
