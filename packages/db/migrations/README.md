# Migrations

Checked-in SQL, applied in filename order, each in its own transaction, recorded in
`_migration` with a checksum.

## Why not `drizzle-kit push`

This database's correctness lives in row-level security policies, audit triggers and
revoked grants. `push` does not model any of them, treats them as drift, and would
happily remove them. Against a legal register that is not an acceptable failure mode.

## Two kinds of file

| File | Author | Regenerate? |
|---|---|---|
| `0000_init.sql` | `pnpm --filter @ksdc/db generate` | yes, before it is applied anywhere |
| `0001_rls_and_audit.sql` | by hand | never — add a new file |

The generator reads the **compiled** schema (`dist/schema/index.js`), not the TypeScript
source: drizzle-kit resolves through CJS and cannot follow NodeNext `.js` specifiers.
`pnpm generate` builds first.

## Rules

1. **An applied migration is immutable.** The runner stores each file's SHA-256 and
   refuses to continue if a file it has already applied has changed. The database would
   no longer match the file that describes it.
2. **Migrations are ASCII.** `pnpm test` fails otherwise. A server whose database
   encoding is not UTF-8 — Windows `initdb` defaults to WIN1252 — rejects a decorative
   em-dash in a comment and turns a cosmetic character into a failed migration. Case
   *data* is UTF-8 and must be: Kannada is a requirement.
3. **Expand/contract.** No `DROP COLUMN`, `DROP TABLE`, `RENAME` or `ALTER … TYPE` unless
   the file is named `*.contract.sql` and the pull request carries the
   `destructive-migration-approved` label.
4. In production, migrations run as a Cloud Run **job** before traffic shifts — never at
   application boot.

## Gotchas already paid for

- **Generated columns and enums.** `waiting_on` casts each `CASE` branch to the enum
  individually. Casting the `CASE` *result* fails with *"generation expression is not
  immutable"*, because `enum_in` is `STABLE` (`provolatile = 's'`), so an outer cast is a
  runtime call. Per-branch literals are constant-folded at parse time.
- **`FORCE ROW LEVEL SECURITY` is not optional.** Without it the table owner bypasses
  every policy, and migrations and seeds run as the owner.
