# KSDC Complaints Management

The Karnataka State Dental Council's complaints register, and the follow-up engine that
makes sure no case sits silently with nobody chasing it.

- **[docs/00-build-plan.md](docs/00-build-plan.md)** — the specification. Read this first.
- **[docs/requirements.md](docs/requirements.md)** — the requirements interview it came from.
- **[docs/v1-scope.md](docs/v1-scope.md)** — what Phase 1 builds, and what it deliberately does not.
- **[docs/adr/0001-canonical-schema.md](docs/adr/0001-canonical-schema.md)** — the vocabulary. CI enforces it.
- **[docs/adr/0002-nextjs-route-handlers-and-supabase.md](docs/adr/0002-nextjs-route-handlers-and-supabase.md)** — why there is no separate API service, and what is prepared for Supabase.

## Running it locally

You need Node 22 and pnpm. **No Docker and no PostgreSQL install** — `pnpm db:dev`
unpacks PostgreSQL 17 into `node_modules` and runs it on port 55432. It is the same major
version Cloud SQL will run, so row-level security, generated columns and `sha256()`
behave here exactly as they will in Mumbai.

```bash
pnpm install
pnpm db:dev          # leave running: starts Postgres, migrates, seeds KSDC
```

Run it again later and it notices the cluster is already up, migrates and seeds against
it, and exits — so it is safe to run every morning whether or not yesterday's postmaster
is still alive. `pnpm db:dev --reset` wipes and starts clean, and refuses while a cluster
is running rather than deleting the files underneath it.

**Settings.** The scripts read `.env.dev` at the repository root; Next.js reads
`apps/web/.env.local`. Both are gitignored and loaded automatically — no exported
variables. `.env.example` shows what goes in them.

```
DATABASE_URL=postgres://app_rw:app_rw_dev@localhost:55432/ksdc_dev
JWT_PRIVATE_KEY="..."     # from: pnpm --filter @ksdc/core keys
JWT_PUBLIC_KEY="..."
MAIL_TRANSPORT=console
```

Without the keys an ephemeral pair is generated and everyone is signed out whenever the
process reloads — which, under Next's dev server, is often. It says so in the log and
refuses to do it in production. In production every one of these comes from Secret Manager
and the environment; nothing reads a file there.

In a second terminal — one command, because the API is not a separate service any more:

```bash
pnpm --filter @ksdc/core demo   # example cases, created through the real services
pnpm --filter @ksdc/web dev     # the register AND /v1 on :3000
```

**Signing in.** There is no password: a six-digit code is emailed. In development
`MAIL_TRANSPORT` is `console`, so the code is printed in the log and appended to
`apps/web/var/mail/outbox.log` — no mail server needed. Sign in as `officer@ksdc.in`.

**The daily job**, which escalates the ladder and sends the digest, is normally called by
Cloud Scheduler. Two ways to fire it by hand:

```bash
pnpm --filter @ksdc/core daily
```

```bash
curl -X POST http://localhost:3000/v1/internal/jobs/daily -H 'x-dev-scheduler: 1'
```

`infra/docker-compose.yml` is there if you would rather use Docker.

## Layout

```
apps/
  web/          Next.js. The UI in app/, and the whole API in app/v1/ as route handlers.
packages/
  core/         The register itself: services, the follow-up engine, auth, documents.
                No web framework — everything takes (tx, ctx, args) and returns data.
  contracts/    Enums, the case-number format, the case lifecycle as one data table.
  config/       Council configuration schema + the KSDC seed.
  db/           Drizzle schema, migrations, withCouncil(), the dev database.
  testing/      The shared PostgreSQL test harness.
infra/          docker-compose, and (later) Terraform.
docs/           The plan, the requirements, the ADRs.
```

## Checks

```bash
pnpm test              # 308 tests, against a real PostgreSQL 17
pnpm typecheck
pnpm check:vocabulary  # ADR-0001: fails the build on a banned identifier
```

The tenant-isolation test in `packages/db/src/tenancy.test.ts` is the one that matters
most: it asserts every table carrying `council_id` has row-level security **enabled and
forced** with a policy, and that one council sees exactly zero rows of another's.

## Things that will bite you if you don't know them

- **`waiting_on` is a generated column.** It is derived from `state` by Postgres and
  cannot be written. Each `CASE` branch casts to the enum individually — casting the
  `CASE` result fails as non-immutable, because `enum_in` is `STABLE`.
- **The application role cannot DELETE anything, anywhere.** "No hard deletes" is a grant,
  not a convention. Tests clean up by closing and cancelling rows, not by deleting them.
- **Migrations are ASCII, and line endings are pinned to LF.** The runner stores a SHA-256
  of each applied migration; a rewritten line ending would look like tampering.
- **The notice counter moves in exactly one place** — an officer-confirmed despatch. No
  timer touches it. Reminders say *"no reply logged"*, never *"did not respond"*, because
  in Phase 1 inbound mail is logged by hand and the software cannot tell the difference
  about a named dentist.
- **The software never generates an outward despatch number.** That book is shared with
  certificates and circulars issued by people who will never touch this system.
- **A council is not authorised for production data** until four artefacts exist in
  `docs/authorisation/`. Until then the API refuses to create a real case and the
  dashboard says DEMO DATA. The paper register stays the legal record until the gated
  retirement action in Phase 5.
- **Row-level security has exactly two documented exceptions**, both cut as narrowly as
  they could be, and both with tests that hold them to that size:
  - `app.auth_subject` (migration 0003) lets sign-in read *one user's own* council
    memberships, before any council scope exists.
  - `app.scheduler_scan` (migration 0004) lets the daily job list `council_config`, and
    only that table, to know which councils to process.

  Both are set transaction-locally. Adding a third needs the same treatment: a migration
  that explains itself, and a test that proves it reaches no case data.
- **The mailer refuses to write to `registrar@`, `support@`, `info@` or `office@`.** Those
  are where complaints arrive — the pile the officer is escaping. System mail goes to a
  person.

## Where Phase 1 has got to

Done: the schema, tenancy and audit chain; the case lifecycle; the follow-up engine; case
intake; the Today queue and screen; the scheduler; passwordless email sign-in with
rotating refresh tokens; and the daily digest.

Next: document upload via signed URLs, the draft composer with "I have sent this", and
the register CSV export. After that, Phase 2 — mailbox ingestion and the start of
dual-running.
