#!/usr/bin/env node
/**
 * Migrations must be ASCII.
 *
 * A server whose database encoding is not UTF-8 (Windows initdb defaults to WIN1252)
 * rejects a decorative em-dash in a comment with
 * "character ... has no equivalent in encoding WIN1252" — turning a cosmetic character
 * into a failed migration. Case DATA is UTF-8 and must be: Kannada is a requirement.
 * The migration FILES are ASCII so they apply anywhere.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let bad = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
  readFileSync(join(dir, f), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const offenders = [...line].filter((c) => c.codePointAt(0) > 127);
      if (offenders.length) {
        console.error(`${f}:${i + 1}  non-ASCII ${JSON.stringify(offenders.join(''))}`);
        bad++;
      }
    });
}
if (bad) {
  console.error(`\n✗ ${bad} line(s) with non-ASCII characters in migrations.`);
  process.exit(1);
}
console.log('✓ migrations are ASCII');
