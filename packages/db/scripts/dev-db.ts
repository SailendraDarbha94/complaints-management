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

const superUrl = (database: string) =>
  `postgres://postgres:postgres@localhost:${PORT}/${database}`;

/**
 * A postmaster left over from yesterday survives a closed terminal, and starting a second
 * one on the same data directory fails with a lock-file error that reads like corruption.
 * Ask the port instead: if something already answers, that is our cluster and it is fine
 * to migrate and seed against it.
 */
async function alreadyRunning(): Promise<boolean> {
  const probe = new pg.Client({
    connectionString: superUrl('postgres'),
    connectionTimeoutMillis: 2000,
  });
  try {
    await probe.connect();
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

async function ensureDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: superUrl('postgres') });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      DB_NAME,
    ]);
    if (!rowCount) await admin.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const running = await alreadyRunning();

  if (reset && running) {
    throw new Error(
      `Postgres is already running on :${PORT}. Stop it first — Ctrl+C in the terminal ` +
        `holding it open — then run \`pnpm db:dev --reset\` again. Wiping the data ` +
        `directory underneath a live postmaster corrupts it.`,
    );
  }

  if (reset) {
    console.log('  wiping the development cluster');
    await rm(DATA_DIR, { recursive: true, force: true });
  }

  let instance: EmbeddedPostgres | null = null;

  if (running) {
    console.log(`  Postgres is already up on :${PORT} — reusing that cluster.`);
  } else {
    instance = new EmbeddedPostgres({
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
  }

  await ensureDatabase();

  console.log('  applying migrations');
  await migrate(superUrl(DB_NAME));

  // The app connects as app_rw so development exercises the same grants as production:
  // no DELETE anywhere, and row-level security that cannot be bypassed. Finding out in
  // Mumbai that a code path needed a grant it never had is not a good day.
  const admin = new pg.Client({ connectionString: superUrl(DB_NAME) });
  await admin.connect();
  await admin.query(`ALTER ROLE app_rw LOGIN PASSWORD 'app_rw_dev'`);
  await admin.end();

  const appUrl = `postgres://app_rw:app_rw_dev@localhost:${PORT}/${DB_NAME}`;

  console.log('  seeding');
  await seed(superUrl(DB_NAME));

  console.log(`\n  DATABASE_URL=${appUrl}`);
  console.log('  Owner connection (migrations, psql):');
  console.log(`  ${superUrl(DB_NAME)}\n`);

  if (!instance) {
    console.log(
      '  That cluster is held open by another terminal, so this command is done — ' +
        'the database stays up.\n',
    );
    return;
  }

  console.log('  Postgres 17 is running and will stay up until you stop this process.\n');

  const live = instance;
  const stop = async () => {
    console.log('\n  stopping');
    await live.stop();
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
