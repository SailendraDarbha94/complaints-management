import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDatabase, type Harness } from '@ksdc/testing';
import { migrate } from '../scripts/migrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let harness: Harness | undefined;

export async function setup(): Promise<void> {
  harness = await startTestDatabase({
    dataDir: join(HERE, '..', '.pgdata-test'),
    port: Number(process.env.TEST_PG_PORT ?? 54329),
    migrate,
  });
  process.env.TEST_DATABASE_URL = harness.appUrl;
  process.env.TEST_DATABASE_URL_SUPER = harness.superUrl;
}

export async function teardown(): Promise<void> {
  await harness?.stop();
}
