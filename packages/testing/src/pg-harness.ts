import { rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

/**
 * A throwaway PostgreSQL 17 for integration tests, shared by @ksdc/db and apps/api.
 *
 * `embedded-postgres` unpacks a real Postgres into node_modules and runs it on a private
 * port — no Docker, no system service, no admin rights. That matters: the tenant-isolation
 * check is a required CI gate, and a gate that only runs where someone remembered to
 * install Docker is a gate that quietly stops running.
 *
 * Postgres 17 matches the Cloud SQL target, so row-level security, generated columns and
 * sha256() behave in tests exactly as they will in Mumbai.
 */

export interface HarnessOptions {
  /** Directory for the throwaway cluster. Deleted before and after the run. */
  dataDir: string;
  port: number;
  databaseName?: string;
  /** Applies the migrations. Receives a superuser connection string. */
  migrate: (connectionString: string) => Promise<unknown>;
}

export interface Harness {
  /** Connects as `app_rw` — the role the API uses, with its real grants. */
  appUrl: string;
  /** Connects as the owner. For tests that must act outside the application's grants. */
  superUrl: string;
  stop: () => Promise<void>;
}

const SUPER_USER = 'postgres';
const SUPER_PASS = 'postgres';

export async function startTestDatabase(opts: HarnessOptions): Promise<Harness> {
  const dbName = opts.databaseName ?? 'ksdc_test';
  await rm(opts.dataDir, { recursive: true, force: true });

  const instance = new EmbeddedPostgres({
    databaseDir: opts.dataDir,
    user: SUPER_USER,
    password: SUPER_PASS,
    port: opts.port,
    persistent: false,
    // Windows initdb defaults to WIN1252, which cannot store Kannada and rejects any
    // non-Latin-1 byte. Cloud SQL is UTF-8; tests must match it or they exercise a
    // database the council will never run.
    initdbFlags: ['--encoding=UTF8', '--lc-collate=C', '--lc-ctype=C'],
  });

  await instance.initialise();
  await instance.start();
  await instance.createDatabase(dbName);

  const superUrl = `postgres://${SUPER_USER}:${SUPER_PASS}@localhost:${opts.port}/${dbName}`;
  await opts.migrate(superUrl);

  // The migration creates app_rw NOLOGIN — on Cloud SQL it authenticates by IAM and has
  // no password at all. Tests connect as that role so they exercise the real grants,
  // particularly the revoked DELETE.
  const admin = new pg.Client({ connectionString: superUrl });
  await admin.connect();
  await admin.query(`ALTER ROLE app_rw LOGIN PASSWORD 'app_rw_test'`);
  await admin.end();

  return {
    appUrl: `postgres://app_rw:app_rw_test@localhost:${opts.port}/${dbName}`,
    superUrl,
    stop: async () => {
      await instance.stop();
      await rm(opts.dataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
