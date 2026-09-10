# KSDC Complaints Management

The Karnataka State Dental Council's complaints register, and the follow-up engine that
makes sure no case sits silently with nobody chasing it.

- **[docs/00-build-plan.md](docs/00-build-plan.md)** — the specification. Read this first.
- **[docs/requirements.md](docs/requirements.md)** — the requirements interview it came from.
- **[docs/v1-scope.md](docs/v1-scope.md)** — what Phase 1 builds, and what it deliberately does not.
- **[docs/adr/0001-canonical-schema.md](docs/adr/0001-canonical-schema.md)** — the vocabulary. CI enforces it.

## Running it locally

You need Node 22 and pnpm. **No Docker and no PostgreSQL install** — `pnpm db:dev`
unpacks PostgreSQL 17 into `node_modules` and runs it on port 55432. It is the same major
version Cloud SQL will run, so row-level security, generated columns and `sha256()`
behave here exactly as they will in Mumbai.

```bash
pnpm install
pnpm db:dev          # leave running: starts Postgres, migrates, seeds KSDC
```

That prints a `DATABASE_URL` and the two development identity headers. In a second
terminal:

```bash
export DATABASE_URL="postgres://app_rw:app_rw_dev@localhost:55432/ksdc_dev"
pnpm --filter @ksdc/api demo     # example cases, created through the real services
pnpm --filter @ksdc/api dev      # API on :8080
```

And a third:

```bash
export API_URL=http://localhost:8080
export DEV_COUNCIL_ID=...        # printed by pnpm db:dev
export DEV_USER_ID=...
pnpm --filter @ksdc/web dev      # Today screen on :3000
```

`infra/docker-compose.yml` is there if you would rather use Docker.

## Layout

```
apps/
  api/          NestJS + Fastify. The only thing that talks to the database.
  web/          Next.js. A thin client over the API — it holds no credentials.
packages/
  contracts/    Enums, the case-number format, the case lifecycle as one data table.
  config/       Council configuration schema + the KSDC seed.
  db/           Drizzle schema, migrations, withCouncil(), the dev database.
  testing/      The shared PostgreSQL test harness.
infra/          docker-compose, and (later) Terraform.
docs/           The plan, the requirements, the ADRs.
```

## Checks

```bash
pnpm test              # 132 tests, against a real PostgreSQL 17
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

## Where Phase 1 has got to

Done: the schema, tenancy and audit chain; the case lifecycle; the follow-up engine; case
intake; the Today queue and screen; the scheduler.

Next: email-OTP sign-in (the API currently accepts development identity headers, and
refuses them when `NODE_ENV=production`), the daily digest email, document upload, the
draft composer, and the register CSV export.
