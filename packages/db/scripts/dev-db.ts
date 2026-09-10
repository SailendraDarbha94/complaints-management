/**
 * A local PostgreSQL 17 for development, unpacked into node_modules.
 *
 * No Docker, no system service, no admin rights — which matters because the officer who
 * maintains this is a dental officer with a Windows laptop, not a platform engineer. It
 * is the same Postgres 17 the tests use and the same major version Cloud SQL will run, so
 * row-level security, generated columns and sha256() behave identically here, in CI and
 * in Mumbai.
 *
 *   pnpm db:dev            start (persistent) and print the connection string
 *   pnpm db:dev --reset    wipe the cluster and start clean
 *
 * infra/docker-compose.yml is there for anyone who does have Docker and prefers it.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

// pnpm runs package scripts with cwd set to the package directory, so the cluster lives
// beside the source rather than inside dist/.
const DATA_DIR = join(process.cwd(), '.pgdata-dev');
const PORT = Number(process.env.DEV_PG_PORT ?? 55432);
const DB_NAME = 'ksdc_dev';

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  if (reset) {
    console.log('  wiping the development cluster');
    await rm(DATA_DIR, { recursive: true, force: true });
  }

  const instance = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: true,
    // Windows initdb defaults to WIN1252, which cannot store Kannada. Cloud SQL is UTF-8.
    initdbFlags: ['--encoding=UTF8', '--lc-collate=C', '--lc-ctype=C'],
  });

  await instance.initialise().catch(() => {
    /* already initialised — persistent cluster */
  });
  await instance.start();

  const superUrl = `postgres://postgres:postgres@localhost:${PORT}/${DB_NAME}`;
  await instance.createDatabase(DB_NAME).catch(() => {
    /* already exists */
  });

  console.log('  applying migrations');
  await migrate(superUrl);

  // The app connects as app_rw so development exercises the same grants as production:
  // no DELETE anywhere, and row-level security that cannot be bypassed. Finding out in
  // Mumbai that a code path needed a grant it never had is not a good day.
  const admin = new pg.Client({ connectionString: superUrl });
  await admin.connect();
  await admin.query(`ALTER ROLE app_rw LOGIN PASSWORD 'app_rw_dev'`);
  await admin.end();

  const appUrl = `postgres://app_rw:app_rw_dev@localhost:${PORT}/${DB_NAME}`;

  console.log('  seeding');
  await seed(superUrl);

  console.log('\n  Postgres 17 is running and will stay up until you stop this process.\n');
  console.log(`  DATABASE_URL=${appUrl}\n`);
  console.log('  Owner connection (migrations, psql):');
  console.log(`  ${superUrl}\n`);

  const stop = async () => {
    console.log('\n  stopping');
    await instance.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Hold the process open so the cluster stays up.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
