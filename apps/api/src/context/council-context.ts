import type { FastifyRequest } from 'fastify';
import { UnauthorizedException } from '@nestjs/common';
import { parseCouncilConfig, type CouncilConfig } from '@ksdc/config';
import { getDb, withCouncil, type Tx } from '@ksdc/db';
import { sql } from 'drizzle-orm';
import type { Role } from '@ksdc/contracts';
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

export function resolveIdentity(req: FastifyRequest): RequestIdentity {
  if (!req.identity) throw new UnauthorizedException('Not signed in.');
  return req.identity;
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
      const config = await loadConfig(tx, identity.councilId);
      return fn(tx, { councilId: identity.councilId, userId: identity.userId, config });
    },
    getDb(),
  );
}
