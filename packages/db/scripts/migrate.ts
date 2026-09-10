/**
 * Migration runner.
 *
 * Deliberately not `drizzle-kit push`: this database's correctness lives in row-level
 * security policies, audit triggers and revoked grants, which push treats as drift and
 * would happily remove. Migrations are checked-in SQL applied in filename order, each in
 * its own transaction, recorded in `_migration`.
 *
 * In production this runs as a Cloud Run job before traffic shifts, never at boot.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Walk up from this module until we find the migrations directory. The same file runs
 * from `scripts/` in development and from `dist/scripts/` once compiled, so a fixed
 * relative path is wrong in one of the two.
 */
function findMigrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'migrations');
    if (existsSync(join(candidate, '0000_init.sql'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('Could not locate the migrations directory from ' + fileURLToPath(import.meta.url));
}

const MIGRATIONS_DIR = findMigrationsDir();

// Statements drizzle-kit separates with this marker; we apply each file whole instead,
// so the marker is stripped rather than split on.
const BREAKPOINT = /-->\s*statement-breakpoint/g;

export async function migrate(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migration (
        filename   text PRIMARY KEY,
        sha256     text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const { rows } = await client.query<{ filename: string; sha256: string }>(
      'SELECT filename, sha256 FROM _migration',
    );
    const seen = new Map(rows.map((r) => [r.filename, r.sha256]));

    for (const filename of files) {
      const raw = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
      const sha256 = createHash('sha256').update(raw).digest('hex');
      const previous = seen.get(filename);

      if (previous) {
        if (previous !== sha256) {
          // An applied migration was edited. Against a legal register that is never a
          // harmless tidy-up — the database no longer matches the file that describes it.
          throw new Error(
            `Migration ${filename} has changed since it was applied.\n` +
              `  applied: ${previous}\n  on disk: ${sha256}\n` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        continue;
      }

      const sql = raw.replace(BREAKPOINT, '');
      process.stdout.write(`  applying ${filename} … `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migration (filename, sha256) VALUES ($1, $2)', [
          filename,
          sha256,
        ]);
        await client.query('COMMIT');
        process.stdout.write('ok\n');
        applied.push(filename);
      } catch (err) {
        await client.query('ROLLBACK');
        process.stdout.write('FAILED\n');
        throw err;
      }
    }
  } finally {
    await client.end();
  }

  return applied;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  migrate(url)
    .then((applied) => {
      console.log(applied.length ? `✓ ${applied.length} migration(s) applied` : '✓ up to date');
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
