#!/usr/bin/env node
/**
 * Migration guard. Two checks, both of which have already caught something real.
 *
 * 1. ASCII only. A server whose database encoding is not UTF-8 (Windows `initdb` defaults
 *    to WIN1252) rejects a decorative em-dash in a comment and turns a cosmetic character
 *    into a failed migration. Case DATA is UTF-8 and must be — Kannada is a requirement —
 *    but the migration FILES are ASCII so they apply anywhere.
 *
 * 2. Expand/contract. `DROP COLUMN`, `DROP TABLE`, `RENAME` and `ALTER COLUMN ... TYPE`
 *    are refused unless the migration says, in the file, why it is safe.
 *
 * The build plan called for a `destructive-migration-approved` pull-request label. There
 * are no pull requests here — one dental officer merges to main — so the approval lives
 * in the file instead, where it is still reviewable and, unlike a label, still legible in
 * three years when someone is reading the migration and wondering what happened.
 *
 *     -- destructive-migration-approved: <reason>
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const DESTRUCTIVE = [
  { re: /\bDROP\s+COLUMN\b/i, what: 'DROP COLUMN' },
  { re: /\bDROP\s+TABLE\b/i, what: 'DROP TABLE' },
  { re: /\bALTER\s+TABLE\s+\S+\s+RENAME\b/i, what: 'RENAME' },
  { re: /\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, what: 'ALTER COLUMN ... TYPE' },
];

const APPROVAL = /--\s*destructive-migration-approved:\s*\S+/i;

let failures = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  const source = readFileSync(join(dir, file), 'utf8');
  const lines = source.split('\n');
  const approved = APPROVAL.test(source);

  lines.forEach((line, i) => {
    const offenders = [...line].filter((c) => c.codePointAt(0) > 127);
    if (offenders.length) {
      console.error(`${file}:${i + 1}  non-ASCII ${JSON.stringify(offenders.join(''))}`);
      failures++;
    }

    // Skip comment lines when hunting for destructive statements — the guard should not
    // trip on a comment that merely mentions DROP COLUMN.
    if (line.trim().startsWith('--')) return;

    for (const { re, what } of DESTRUCTIVE) {
      if (re.test(line) && !approved) {
        console.error(
          `${file}:${i + 1}  ${what} without approval\n` +
            `    Add a line to this migration saying why it is safe:\n` +
            `    -- destructive-migration-approved: <reason>\n` +
            `    ${line.trim()}`,
        );
        failures++;
      }
    }
  });
}

if (failures) {
  console.error(`\n✗ ${failures} problem(s) in migrations.`);
  process.exit(1);
}
console.log('✓ migrations are ASCII and non-destructive (or approved)');
