import { parseCouncilConfig, type CouncilConfig } from '@ksdc/config';
import { getDb, withCouncil, type Tx } from '@ksdc/db';
import { sql } from 'drizzle-orm';
import type { Role } from '@ksdc/contracts';
import { UnauthorizedError } from '../common/domain-error.js';
import type { EngineContext } from '../modules/followups/followup.service.js';

/**
 * The council and user for a request.
 *
 * Populated by AuthGuard from a verified access token. There is no development bypass:
 * a convenience that survives quietly into production is how a legal register ends up
 * with no access control at all.
 */

export interface RequestIdentity {
  councilId: string;
  userId: string;
  role: Role;
  sessionId: string;
  email: string;
  name: string;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Council configuration. One tenant today, and it changes by pull request. */
const configCache = new Map<string, CouncilConfig>();

export async function loadConfig(tx: Tx, councilId: string): Promise<CouncilConfig> {
  const cached = configCache.get(councilId);
  if (cached) return cached;

  const res = await tx.execute<{ config: unknown }>(
    sql`SELECT config FROM council_config WHERE council_id = ${councilId}::uuid`,
  );
  const raw = res.rows[0]?.config;
  if (!raw) {
    throw new Error(
      `Council ${councilId} has no configuration row. Run \`pnpm db:seed\` — a council ` +
        'without deadlines, a calendar and a notice ladder cannot schedule anything.',
    );
  }
  const parsed = parseCouncilConfig(raw);
  configCache.set(councilId, parsed);
  return parsed;
}

export function clearConfigCache(): void {
  configCache.clear();
}

/**
 * Run a handler inside a council-scoped transaction with the configuration loaded.
 * Every request-serving code path goes through here; nothing reaches the database
 * another way.
 */
export async function inCouncilScope<T>(
  identity: RequestIdentity,
  requestId: string | null,
  fn: (tx: Tx, ctx: EngineContext) => Promise<T>,
): Promise<T> {
  return withCouncil(
    {
      councilId: identity.councilId,
      userId: identity.userId,
      role: identity.role,
      requestId,
    },
    async (tx) => {
      await assertMembershipLive(tx, identity);
      const config = await loadConfig(tx, identity.councilId);
      return fn(tx, { councilId: identity.councilId, userId: identity.userId, config });
    },
    getDb(),
  );
}

/**
 * Is this person still entitled to act for this council, right now?
 *
 * The council in a request comes from a signed token, and a token lives an hour. Without
 * this, a committee member whose term ended this morning goes on reading and WRITING that
 * council's complaints until their token happens to expire - and if they keep the tab
 * open, until they sign out. For an ordinary application that window is a shrug; for a
 * statutory body's register, an hour of access by somebody no longer appointed is the
 * kind of thing that gets asked about in a hearing.
 *
 * The direct-client path already re-checks this per row, inside the policy, because a
 * PostgREST caller has no server to ask. This is the same guarantee for the server path,
 * and the two now agree.
 *
 * One indexed query per request, inside the transaction that was opening anyway. The
 * officer handles four complaints a month; this is not the thing that will be slow.
 */
async function assertMembershipLive(tx: Tx, identity: RequestIdentity): Promise<void> {
  const rows = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM council_membership m
      WHERE m.app_user_id = ${identity.userId}::uuid
        AND m.council_id = ${identity.councilId}::uuid
        AND m.starts_on <= current_date
        AND (m.ends_on IS NULL OR m.ends_on >= current_date)
    ) AS ok
  `);

  if (!rows.rows[0]?.ok) {
    throw new UnauthorizedError(
      'Your membership of this council is not currently active. Sign in again, and ask ' +
        'the Registrar if you believe this is wrong.',
    );
  }
}
