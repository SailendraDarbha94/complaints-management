import { rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

/**
 * A throwaway PostgreSQL 17 for integration tests, shared by @ksdc/db and @ksdc/core.
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

/**
 * Windows holds a handle on the data directory for a moment after the postmaster exits,
 * so removing it immediately fails with EBUSY. Retry for a couple of seconds; if it still
 * will not go, say so rather than throwing, because the next run wipes it anyway and a
 * green test suite should not exit non-zero over a directory.
 */
async function removeDataDir(dataDir: string, { fatal }: { fatal: boolean }): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(dataDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (fatal) {
    throw new Error(
      `Could not remove the test cluster at ${dataDir}. A postgres.exe from an earlier ` +
        `run is probably still holding it - end it and try again.`,
    );
  }
  console.warn(`  note: ${dataDir} could not be removed; the next run will wipe it.`);
}

export async function startTestDatabase(opts: HarnessOptions): Promise<Harness> {
  const dbName = opts.databaseName ?? 'ksdc_test';
  // Fatal here: starting on top of someone else's cluster would test the wrong database.
  await removeDataDir(opts.dataDir, { fatal: true });

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
      // A non-persistent cluster deletes its own directory as it stops, which is the same
      // EBUSY race - and it throwing here turns a passing suite into a failed run.
      await instance.stop().catch(() => {});
      await removeDataDir(opts.dataDir, { fatal: false });
    },
  };
}
