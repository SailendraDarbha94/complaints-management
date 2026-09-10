/**
 * Starts a throwaway PostgreSQL 17 for the integration tests.
 *
 * `embedded-postgres` unpacks a real Postgres into node_modules and runs it on a private
 * port — no Docker, no system service, no admin rights. That matters: the isolation test
 * below is a required CI check, and a check that only runs where someone remembered to
 * install Docker is a check that stops running.
 *
 * Postgres 17 matches the Cloud SQL target, so RLS, generated columns and sha256()
 * behave in tests exactly as they will in Mumbai.
 */
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { migrate } from '../scripts/migrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', '.pgdata-test');
const PORT = Number(process.env.TEST_PG_PORT ?? 54329);
const SUPER_USER = 'postgres';
const SUPER_PASS = 'postgres';
const DB_NAME = 'ksdc_test';

let instance: EmbeddedPostgres | undefined;

export async function setup(): Promise<void> {
  await rm(DATA_DIR, { recursive: true, force: true });

  instance = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: SUPER_USER,
    password: SUPER_PASS,
    port: PORT,
    persistent: false,
    // Windows initdb defaults to WIN1252, which cannot store Kannada and rejects any
    // non-Latin-1 byte. Cloud SQL is UTF-8; the tests must match it or they test a
    // database the council will never run.
    initdbFlags: ['--encoding=UTF8', '--lc-collate=C', '--lc-ctype=C'],
  });

  await instance.initialise();
  await instance.start();
  await instance.createDatabase(DB_NAME);

  const superUrl = `postgres://${SUPER_USER}:${SUPER_PASS}@localhost:${PORT}/${DB_NAME}`;
  await migrate(superUrl);

  // The migration creates app_rw NOLOGIN (it authenticates by IAM on Cloud SQL). Tests
  // need to connect AS that role so they exercise the real grants — particularly the
  // revoked DELETE — rather than the owner's privileges.
  const admin = new pg.Client({ connectionString: superUrl });
  await admin.connect();
  await admin.query(`ALTER ROLE app_rw LOGIN PASSWORD 'app_rw_test'`);
  await admin.end();

  process.env.TEST_DATABASE_URL = `postgres://app_rw:app_rw_test@localhost:${PORT}/${DB_NAME}`;
  process.env.TEST_DATABASE_URL_SUPER = superUrl;
}

export async function teardown(): Promise<void> {
  await instance?.stop();
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
}
