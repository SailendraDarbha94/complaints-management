import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDatabase, type Harness } from '@ksdc/testing';
import { migrate } from '@ksdc/db/migrate';

const HERE = dirname(fileURLToPath(import.meta.url));
let harness: Harness | undefined;

/**
 * Supabase credentials for the integration tests that need them.
 *
 * Only the SUPABASE_* keys are taken, deliberately. .env.dev also holds DATABASE_URL,
 * which now points at the live project - loading the whole file would silently aim the
 * entire test suite at production. The tests that use these skip themselves when the keys
 * are absent, so a fresh clone with no .env.dev still runs everything else.
 */
function loadSupabaseEnv(): void {
  const path = join(HERE, '..', '..', '..', '.env.dev');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(SUPABASE_(?:URL|SECRET_KEY|PUBLISHABLE_KEY|STORAGE_BUCKET))=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) {
      process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
    }
  }
}

export async function setup(): Promise<void> {
  loadSupabaseEnv();

  harness = await startTestDatabase({
    dataDir: join(HERE, '..', '.pgdata-test'),
    // A different port from @ksdc/db's harness so `turbo run test` can run both at once.
    port: Number(process.env.TEST_PG_PORT ?? 54330),
    migrate,
  });
  process.env.TEST_DATABASE_URL = harness.appUrl;
  process.env.TEST_DATABASE_URL_SUPER = harness.superUrl;
}

export async function teardown(): Promise<void> {
  await harness?.stop();
}
