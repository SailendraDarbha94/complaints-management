#!/usr/bin/env node
/**
 * ADR-0001 enforcement. Fails the build if a banned identifier appears in source.
 *
 * The design studies used five names for the central entity and two for the tenant
 * column. This script is the reason that cannot happen again.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

const BANNED = [
  { re: /\btenant_id\b/g, use: 'council_id', note: 'ADR-0001: the tenant column is council_id' },
  { re: /\bapp\.tenant_id\b/g, use: 'app.council_id', note: 'ADR-0001: session variable' },
  { re: /\bwithTenant\s*\(/g, use: 'withCouncil(', note: 'ADR-0001: transaction helper' },
  { re: /\bgdc_referrals?\b/g, use: 'expert_referral', note: 'ADR-0001: GDCRI is one expert body, not the concept' },
  { re: /\bcase_respondents\b/g, use: 'case_respondent', note: 'ADR-0001: table names are singular' },
  // The central entity. `case_file` is canonical; these are the rejected names.
  // Matched only as a table/identifier, so English prose ("the complaint arrives") is fine.
  { re: /\b(pgTable|from|join|into|update)\s*\(?\s*['"`](matters?|complaints?|cases)['"`]/g,
    use: 'case_file', note: 'ADR-0001: the central entity is case_file' },
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', '.turbo', 'coverage', 'build']);
const EXTS = /\.(ts|tsx|js|mjs|cjs|sql)$/;
// This script necessarily contains the banned strings; docs discuss them by name.
const SKIP_FILES = new Set([join('scripts', 'check-vocabulary.mjs')]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTS.test(entry)) yield full;
  }
}

let failures = 0;
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (SKIP_FILES.has(rel) || rel.split(sep).includes('docs')) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { re, use, note } of BANNED) {
      re.lastIndex = 0;
      if (re.test(line)) {
        console.error(`${rel}:${i + 1}  banned identifier — use \`${use}\`\n    ${note}\n    ${line.trim()}`);
        failures++;
      }
    }
  });
}

if (failures) {
  console.error(`\n✗ ${failures} ADR-0001 vocabulary violation(s). See docs/adr/0001-canonical-schema.md`);
  process.exit(1);
}
console.log('✓ ADR-0001 vocabulary check passed');
