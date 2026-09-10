import type { FastifyRequest } from 'fastify';
import { UnauthorizedException } from '@nestjs/common';
import { parseCouncilConfig, type CouncilConfig } from '@ksdc/config';
import { getDb, withCouncil, type Tx } from '@ksdc/db';
import { sql } from 'drizzle-orm';
import type { EngineContext } from '../modules/followups/followup.service.js';

/**
 * Resolves the council and user for a request.
 *
 * Phase 1 has one operator, and passwordless email OTP is the next piece of work. Until
 * it lands, the API accepts a development identity from headers — but ONLY outside
 * production, and it says so loudly at boot. A convenience that silently survives into
 * production is how a legal register ends up with no access control at all.
 */

export interface RequestIdentity {
  councilId: string;
  userId: string;
  role: string;
}

const DEV_COUNCIL_HEADER = 'x-dev-council-id';
const DEV_USER_HEADER = 'x-dev-user-id';

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function resolveIdentity(req: FastifyRequest): RequestIdentity {
  // TODO(phase-1): replace with the session cookie minted by the email-OTP flow.
  if (!isProduction()) {
    const councilId = req.headers[DEV_COUNCIL_HEADER] as string | undefined;
    const userId = req.headers[DEV_USER_HEADER] as string | undefined;
    if (councilId && userId) return { councilId, userId, role: 'officer' };
  }
  throw new UnauthorizedException(
    'Not signed in. Email-OTP sign-in is the next piece of Phase 1; until then the API ' +
      'accepts a development identity in headers, and only outside production.',
  );
}

/** Cache of council configuration. One tenant today, and it changes by pull request. */
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
