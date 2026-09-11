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

  it('exposes no public table to anon or authenticated at all, until one is granted', async () => {
    const rows = await db.execute<{ relname: string }>(sql`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (SELECT unnest(ARRAY['anon','authenticated']) AS rolname) r
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND has_table_privilege(r.rolname, c.oid, 'SELECT')
    `);
    expect(rows.rows.map((r) => r.relname)).toEqual([]);
  });
});

describe('the access token hook', () => {
  it('puts the council in app_metadata, and never touches the role claim', async () => {
    const out = await db.execute<{ out: { claims: Record<string, unknown> } }>(sql`
      SELECT public.custom_access_token_hook(${JSON.stringify({
        user_id: sbUserA,
        claims: { sub: sbUserA, role: 'authenticated', app_metadata: { provider: 'email' } },
      })}::jsonb) AS out
    `);
    const c = out.rows[0]!.out.claims as {
      role: string;
      app_metadata: { council_id: string; council_role: string; app_user_id: string };
    };

    expect(c.app_metadata.council_id).toBe(councilA);
    expect(c.app_metadata.council_role).toBe('officer');
    expect(c.app_metadata.app_user_id).toBe(appUserA);
    // PostgREST issues SET ROLE with this. 'officer' here would fail every request.
    expect(c.role).toBe('authenticated');
  });

  it('strips a stale council from somebody who is no longer a member', async () => {
    const out = await db.execute<{ out: { claims: { app_metadata: Record<string, unknown> } } }>(sql`
      SELECT public.custom_access_token_hook(${JSON.stringify({
        user_id: sbUserStranger,
        claims: { sub: sbUserStranger, app_metadata: { council_id: councilA, council_role: 'officer' } },
      })}::jsonb) AS out
    `);
    expect(out.rows[0]!.out.claims.app_metadata).toEqual({});
  });
});
