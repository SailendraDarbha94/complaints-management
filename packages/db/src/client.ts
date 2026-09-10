import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema/index.js';

/**
 * The ONLY way to reach the database.
 *
 * Tenant isolation is enforced by Postgres row-level security, not by ORM middleware or
 * by remembering to add a WHERE clause. Every policy reads `app.council_id` from the
 * session; `withCouncil()` is the only thing that sets it.
 *
 * The raw handle is deliberately not exported. An ESLint rule bans importing from this
 * module outside packages/db and apps/api/src/db.
 */

export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let db: Db | undefined;

export interface DbOptions {
  connectionString?: string;
  max?: number;
  ssl?: boolean;
}

export function initDb(opts: DbOptions = {}): Db {
  if (db) return db;
  const connectionString = opts.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  pool = new pg.Pool({
    connectionString,
    // Cloud Run: one instance, concurrency 40. A small pool per instance is right; the
    // Cloud SQL connector multiplexes and PgBouncer is explicitly not in scope.
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(opts.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  db = drizzle(pool, { schema });
  return db;
}

export function getDb(): Db {
  if (!db) return initDb();
  return db;
}

/**
 * A separate, uncached connection pool. Used by tests that need to act as a different
 * database role, and by the migration and seal jobs, which connect as themselves.
 * Application code uses getDb()/withCouncil().
 */
export function createDb(opts: DbOptions & { connectionString: string }): {
  db: Db;
  close: () => Promise<void>;
} {
  const p = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 2,
    ...(opts.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  return { db: drizzle(p, { schema }), close: () => p.end() };
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}

export interface CouncilContext {
  councilId: string;
  userId?: string | null;
  requestId?: string | null;
  role?: string | null;
}

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Run `fn` inside a transaction scoped to one council.
 *
 * `set_config(..., true)` makes the setting transaction-local, so a pooled connection
 * cannot leak one council's scope into the next request. If `app.council_id` is unset,
 * every RLS policy compares against NULL and matches nothing — the failure mode is zero
 * rows, never another council's data.
 *
 * That failure mode debugs badly ("the data disappeared" rather than an error), so in
 * development `assertCouncilScope` throws instead.
 */
export async function withCouncil<T>(
  ctx: CouncilContext,
  fn: (tx: Tx) => Promise<T>,
  database: Db = getDb(),
): Promise<T> {
  if (!ctx.councilId) throw new Error('withCouncil: councilId is required');

  return database.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.council_id', ${ctx.councilId}, true),
        set_config('app.user_id',    ${ctx.userId ?? ''}, true),
        set_config('app.request_id', ${ctx.requestId ?? ''}, true),
        set_config('app.role',       ${ctx.role ?? ''}, true)
    `);
    return fn(tx);
  });
}

/**
 * Development guard. Call at the top of a repository method that is about to run a query
 * outside withCouncil by mistake.
 */
export async function assertCouncilScope(tx: Tx): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;
  const res = await tx.execute<{ council_id: string | null }>(
    sql`select current_setting('app.council_id', true) as council_id`,
  );
  const value = res.rows[0]?.council_id;
  if (!value) {
    throw new Error(
      'app.council_id is unset — this query would silently return zero rows. ' +
        'Wrap it in withCouncil(). See ADR-0001.',
    );
  }
}

export { schema };
