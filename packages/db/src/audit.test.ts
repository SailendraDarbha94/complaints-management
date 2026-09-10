import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, createDb, initDb, withCouncil, type Db } from './client.js';

/**
 * The audit chain (build plan §11, D13).
 *
 * The register is the legal record of a quasi-judicial body. These tests assert the three
 * properties that make it defensible: it records everything, it cannot be rewritten, and a
 * break in the chain is detectable.
 */

let db: Db;
let superDb: Db;
let closeSuper: () => Promise<void>;
const councilA = '33333333-3333-4333-8333-333333333333';
const councilB = '44444444-4444-4444-8444-444444444444';
const officer = '55555555-5555-4555-8555-555555555555';

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  // A second pool connected as the owner, for the tamper-detection test only.
  ({ db: superDb, close: closeSuper } = createDb({
    connectionString: process.env.TEST_DATABASE_URL_SUPER!,
  }));

  for (const [id, code] of [
    [councilA, 'AUDA'],
    [councilB, 'AUDB'],
  ] as const) {
    await withCouncil({ councilId: id }, async (tx) => {
      await tx.execute(sql`
        INSERT INTO council (id, code, name, address_lines, official_email, registrar_name, is_synthetic)
        VALUES (${id}::uuid, ${code}, ${`Council ${code}`}, '[]'::jsonb,
                ${`r@${code.toLowerCase()}.in`}, 'Test Registrar', true)
        ON CONFLICT (id) DO NOTHING
      `);
    });
  }
});

afterAll(async () => {
  await closeSuper();
  await closeDb();
});

async function makeCase(councilId: string, serial: number, userId?: string) {
  const id = crypto.randomUUID();
  await withCouncil({ councilId, userId: userId ?? null }, async (tx) => {
    await tx.execute(sql`
      INSERT INTO case_file (id, council_id, case_number, fiscal_year, register_sl_no, summary)
      VALUES (${id}::uuid, ${councilId}::uuid,
              ${`AUD/COMP/2026-27/${String(serial).padStart(4, '0')}`}, '2026-27', ${serial},
              'audit probe')
    `);
  });
  return id;
}

describe('the audit chain', () => {
  it('records an insert without the application asking it to', async () => {
    const caseId = await makeCase(councilA, 1, officer);

    const res = await withCouncil({ councilId: councilA }, (tx) =>
      tx.execute<{ action: string; actor_user_id: string | null; case_file_id: string }>(sql`
        SELECT action, actor_user_id, case_file_id
        FROM audit.events
        WHERE entity_id = ${caseId}::uuid
      `),
    );

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.action).toBe('case_file.insert');
    // The actor comes from the session variable set by withCouncil, not from a parameter
    // the caller could forget to pass.
    expect(res.rows[0]!.actor_user_id).toBe(officer);
    expect(res.rows[0]!.case_file_id).toBe(caseId);
  });

  it('flags a write with no actor as unattributed — the canary for a bypassed withCouncil', async () => {
    const caseId = await makeCase(councilA, 2); // no userId

    const res = await withCouncil({ councilId: councilA }, (tx) =>
      tx.execute<{ metadata: { unattributed: boolean } }>(sql`
        SELECT metadata FROM audit.events WHERE entity_id = ${caseId}::uuid
      `),
    );
    expect(res.rows[0]!.metadata.unattributed).toBe(true);
  });

  it('captures before and after on an update, and ignores a no-op update', async () => {
    const caseId = await makeCase(councilA, 3, officer);

    await withCouncil({ councilId: councilA, userId: officer }, async (tx) => {
      await tx.execute(sql`UPDATE case_file SET summary = 'amended' WHERE id = ${caseId}::uuid`);
      // Writing the same value again is not an event.
      await tx.execute(sql`UPDATE case_file SET summary = 'amended' WHERE id = ${caseId}::uuid`);
    });

    const res = await withCouncil({ councilId: councilA }, (tx) =>
      tx.execute<{ action: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
        sql`
          SELECT action, before, after FROM audit.events
          WHERE entity_id = ${caseId}::uuid AND action = 'case_file.update'
        `,
      ),
    );

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.before.summary).toBe('audit probe');
    expect(res.rows[0]!.after.summary).toBe('amended');
  });

  it('refuses to update or delete an event, even though the trigger is the second line of defence', async () => {
    await makeCase(councilA, 4, officer);

    await expect(
      withCouncil({ councilId: councilA }, async (tx) => {
        await tx.execute(sql`UPDATE audit.events SET action = 'tampered'`);
      }),
    ).rejects.toThrow(/permission denied|append-only/i);

    await expect(
      withCouncil({ councilId: councilA }, async (tx) => {
        await tx.execute(sql`DELETE FROM audit.events`);
      }),
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('keeps a gapless sequence per council, and the two councils do not interleave', async () => {
    await makeCase(councilB, 101, officer);
    await makeCase(councilB, 102, officer);

    for (const councilId of [councilA, councilB]) {
      const res = await withCouncil({ councilId }, (tx) =>
        tx.execute<{ seq: string }>(sql`SELECT seq FROM audit.events ORDER BY seq`),
      );
      const seqs = res.rows.map((r) => Number(r.seq));
      expect(seqs.length).toBeGreaterThan(0);
      expect(seqs, `council ${councilId} is not gapless`).toEqual(
        seqs.map((_, i) => i + 1),
      );
    }
  });

  it('links each event to the previous one by hash', async () => {
    const res = await withCouncil({ councilId: councilB }, (tx) =>
      tx.execute<{ seq: string; prev_hash: string | null; hash: string }>(
        sql`SELECT seq, prev_hash, hash FROM audit.events ORDER BY seq`,
      ),
    );

    expect(res.rows[0]!.prev_hash).toBeNull();
    for (let i = 1; i < res.rows.length; i++) {
      expect(res.rows[i]!.prev_hash, `event ${res.rows[i]!.seq}`).toBe(res.rows[i - 1]!.hash);
    }
  });

  it('verifies clean, and detects tampering when history is rewritten behind the trigger', async () => {
    const clean = await withCouncil({ councilId: councilB }, (tx) =>
      tx.execute<{ broken_seq: string; reason: string }>(
        sql`SELECT * FROM audit.verify_chain(${councilB}::uuid)`,
      ),
    );
    expect(clean.rows).toEqual([]);

    // Simulate an attacker with direct database access who disables the trigger — the
    // scenario the hash chain exists for. The grants and trigger stop the application;
    // the chain is what catches someone who got past both.
    await superDb.execute(sql`ALTER TABLE audit.events DISABLE TRIGGER audit_events_immutable`);
    await superDb.execute(sql`
      UPDATE audit.events
      SET canonical_payload = canonical_payload || 'tampered'
      WHERE council_id = ${councilB}::uuid AND seq = 2
    `);

    const broken = await superDb.execute<{ broken_seq: string; reason: string }>(
      sql`SELECT * FROM audit.verify_chain(${councilB}::uuid)`,
    );
    expect(broken.rows).toHaveLength(1);
    expect(Number(broken.rows[0]!.broken_seq)).toBe(2);
    expect(broken.rows[0]!.reason).toMatch(/canonical payload/i);

    // Put it back so later tests see a clean chain.
    await superDb.execute(sql`
      UPDATE audit.events
      SET canonical_payload = replace(canonical_payload, 'tampered', '')
      WHERE council_id = ${councilB}::uuid AND seq = 2
    `);
    await superDb.execute(sql`ALTER TABLE audit.events ENABLE TRIGGER audit_events_immutable`);
  });

  it('stores the canonical payload rather than re-deriving it at verification time', async () => {
    // The whole point of the stored payload: verification must not depend on how this
    // Postgres version happens to render jsonb::text today.
    const res = await withCouncil({ councilId: councilA }, (tx) =>
      tx.execute<{ ok: boolean }>(sql`
        SELECT bool_and(hash = encode(sha256(convert_to(canonical_payload, 'UTF8')), 'hex')) AS ok
        FROM audit.events
      `),
    );
    expect(res.rows[0]!.ok).toBe(true);
  });

  it('never lets one council read another council’s audit trail', async () => {
    const a = await withCouncil({ councilId: councilA }, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit.events`),
    );
    const b = await withCouncil({ councilId: councilB }, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit.events`),
    );
    const total = await superDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit.events`,
    );

    expect(a.rows[0]!.n).toBeGreaterThan(0);
    expect(b.rows[0]!.n).toBeGreaterThan(0);
    // Each council sees strictly less than everything.
    expect(a.rows[0]!.n).toBeLessThan(total.rows[0]!.n);
    expect(b.rows[0]!.n).toBeLessThan(total.rows[0]!.n);
  });
});
