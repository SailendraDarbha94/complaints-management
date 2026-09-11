import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, initDb, withCouncil, type Db } from '@ksdc/db';
import { KSDC_CONFIG } from '@ksdc/config';
import { inCouncilScope, type RequestIdentity } from './council-context.js';
import { seedCouncilAndOfficer } from '../test-support/fixtures.js';

/**
 * The membership check every request goes through.
 *
 * A security audit of the live project found that the server path trusted the council in
 * the access token for as long as the token lived - an hour - while the direct-client
 * path re-checked membership on every row. So an officer or committee member whose term
 * ended this morning went on reading AND WRITING that council's complaints until their
 * token happened to expire. The two paths disagreed, and the weaker one was the one the
 * officer actually uses.
 *
 * These tests are what stops that coming back. They are the only tests that exercise
 * inCouncilScope itself: everything else in this package calls the services directly with
 * a transaction, which is why the gap existed for as long as it did.
 */

let db: Db;
const councilId = '7c111111-1111-4111-8111-111111111111';
const otherCouncilId = '7c222222-2222-4222-8222-222222222222';
const officerId = '7c333333-3333-4333-8333-333333333333';

const identity: RequestIdentity = {
  councilId,
  userId: officerId,
  role: 'officer',
  sessionId: '7c444444-4444-4444-8444-444444444444',
  email: 'officer@ctx.test',
  name: 'Test Officer',
};

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });

  await withCouncil({ councilId }, async (tx) => {
    await seedCouncilAndOfficer(tx, { councilId, officerId, code: 'CTXA' });
    // A council configuration, because inCouncilScope loads one after the check. The real
    // KSDC config rather than a stub: loadConfig parses it, so a stub would test the
    // parser's tolerance instead of the thing this file is about.
    await tx.execute(sql`
      INSERT INTO council_config (council_id, config)
      VALUES (${councilId}::uuid, ${JSON.stringify(KSDC_CONFIG)}::jsonb)
      ON CONFLICT (council_id) DO NOTHING
    `);
  });
  await withCouncil({ councilId: otherCouncilId }, async (tx) => {
    await seedCouncilAndOfficer(tx, {
      councilId: otherCouncilId,
      officerId: '7c555555-5555-4555-8555-555555555555',
      code: 'CTXB',
    });
  });
});

afterAll(async () => {
  await closeDb();
});

/** Restores the membership afterwards, so the tests do not depend on their own order. */
async function withMembershipEnding<T>(endsOn: string | null, fn: () => Promise<T>): Promise<T> {
  await withCouncil({ councilId }, async (tx) => {
    await tx.execute(sql`
      UPDATE council_membership SET ends_on = ${endsOn}::date
      WHERE app_user_id = ${officerId}::uuid AND council_id = ${councilId}::uuid
    `);
  });
  try {
    return await fn();
  } finally {
    await withCouncil({ councilId }, async (tx) => {
      await tx.execute(sql`
        UPDATE council_membership SET ends_on = NULL
        WHERE app_user_id = ${officerId}::uuid AND council_id = ${councilId}::uuid
      `);
    });
  }
}

describe('acting for a council', () => {
  it('lets a current member through', async () => {
    const out = await inCouncilScope(identity, null, async (_tx, ctx) => ctx.councilId);
    expect(out).toBe(councilId);
  });

  it('refuses the moment a membership has ended, not when the token expires', async () => {
    // The token is still perfectly valid here. That is the whole point: nothing about it
    // has changed, and access has to stop anyway.
    await withMembershipEnding('2026-09-10', async () => {
      await expect(
        inCouncilScope(identity, null, async () => 'reached the handler'),
      ).rejects.toThrow(/membership of this council is not currently active/i);
    });
  });

  it('refuses a membership that has not started yet', async () => {
    await withCouncil({ councilId }, async (tx) => {
      await tx.execute(sql`
        UPDATE council_membership SET starts_on = current_date + 7
        WHERE app_user_id = ${officerId}::uuid AND council_id = ${councilId}::uuid
      `);
    });
    try {
      await expect(inCouncilScope(identity, null, async () => 'reached')).rejects.toThrow(
        /not currently active/i,
      );
    } finally {
      await withCouncil({ councilId }, async (tx) => {
        await tx.execute(sql`
          UPDATE council_membership SET starts_on = '2026-04-01'
          WHERE app_user_id = ${officerId}::uuid AND council_id = ${councilId}::uuid
        `);
      });
    }
  });

  it('refuses a council the holder was never a member of', async () => {
    // A forged or stale council_id claim that survived token verification still dies here.
    await expect(
      inCouncilScope({ ...identity, councilId: otherCouncilId }, null, async () => 'reached'),
    ).rejects.toThrow(/not currently active/i);
  });

  it('refuses before the handler runs, so nothing is read or written first', async () => {
    let ran = false;
    await withMembershipEnding('2026-09-10', async () => {
      await expect(
        inCouncilScope(identity, null, async () => {
          ran = true;
          return 'x';
        }),
      ).rejects.toThrow();
    });
    expect(ran, 'the handler ran despite the membership being over').toBe(false);
  });
});
