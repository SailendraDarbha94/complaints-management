# ADR-0002: Next.js route handlers, and Supabase as the platform

**Status:** accepted, partially implemented
**Date:** 2026-09-11
**Supersedes:** the hosting half of ADR-0001's assumptions, and build-plan D7's two-service shape

## Decision

Three things, decided together by the council's dental officer:

1. **NestJS is gone.** The service layer moved from `apps/api` to `packages/core` and the
   HTTP layer became Next.js App Router route handlers in `apps/web/app/v1/`.
2. **Supabase becomes the platform** for authentication, file storage and the database.
3. **The React Native committee app will talk to Supabase directly**, not through this
   API.

Item 1 is done. Items 2 and 3 are prepared for and not switched on: the seams exist, the
drivers are selected by environment variable, and both currently default to what already
works.

## Why this is recorded rather than assumed

An analysis run on 2026-09-11 argued against items 2 and 3 (cost roughly 2x at a matched
recovery target, `service_role` holding `BYPASSRLS` against a schema whose security
argument is that nothing can bypass row-level security, and a procurement question about
whether the council can pay a USD subscription at all). The officer considered that and
decided otherwise. Recording it here means the next person sees a decision, not a drift,
and knows which questions were already asked.

The three open questions that decision rests on, unresolved at the time of writing:

- **Can the council make a foreign remittance against a purchase order?** If not, the
  billing-ownership gate in `case-intake.service.ts:73` cannot be satisfied and real case
  data cannot be entered. One email to the Registrar's accounts clerk settles it.
- **Does Supabase still grant `anon` and `authenticated` privileges on new public tables?**
  If it does, the four deliberately unprotected tables (`app_user`, `auth_otp`,
  `auth_session`, `job_run`) become internet-reachable and migration 0001's claim that no
  DELETE grant exists anywhere stops being true.
- **Are Storage objects included in any Supabase backup product?** The documents are
  magic-byte-sniffed verbatim originals; they are the evidence.

Half a day on a free Mumbai project answers all three: run `pnpm --filter @ksdc/db migrate`
against it and check whether `CREATE ROLE app_rw NOLOGIN NOBYPASSRLS` succeeds, whether a
new public table comes back with grants to `anon`, and whether `audit.append()` still
inserts through the pooler.

## What changed, concretely

### The service layer did not

`apps/api` → `packages/core`, and 26 NestJS import lines came out. Every service now takes
its collaborators as constructor arguments and every method still takes `(tx, ctx, args)`.
All 152 core tests passed unchanged, because none of them ever went through HTTP — they
construct services by hand and hand them a transaction. That is why this cost days rather
than weeks.

`@Injectable()` and Nest's `Logger` were the only things most services imported.
`packages/core/src/common/logger.ts` replaces the latter in twenty lines.

### Dependency injection became a plain object

`packages/core/src/services.ts`. Built once per process, cached on `globalThis` so Next's
hot reload does not rebuild it — a rebuilt `TokenService` would sign with a key the
previous instance's tokens cannot be verified against.

The database pool moved to `globalThis` for the same reason
(`packages/db/src/client.ts`): a module-scoped pool leaks one pool per hot reload, and you
run out of PostgreSQL connections after a morning's work while the failure looks like the
database being down.

### The global guard became a wrapper plus a test

This is the one real loss in moving off NestJS, and the one thing worth reading carefully.

Nest registered `AuthGuard` globally, so an endpoint was authenticated unless it declared
`@Public()`. The App Router has no such hook: `route.ts` is live the moment the file
exists. The default inverts from closed to open, and on a legal register the cost of
forgetting is a disclosure rather than a bug report.

It is bought back three ways, in `apps/web/lib/route.ts` and `apps/web/lib/routes.test.ts`:

- A handler only becomes a route by passing through `withAuth()` or `withPublic()`.
- A test walks `app/v1`, imports every route file, and fails if any exported HTTP method
  did not come from one of those two.
- A second test asserts the set of public endpoints equals a list written out in the test
  file, with a reason for each. Making something public is therefore a reviewed diff to
  that list, not a quiet decision inside a route nobody reads again.

`withPublic()` refuses a reason shorter than twenty characters. That is deliberate.

There are seven public endpoints: four auth (no session exists yet, by definition), two
local-storage (a signed URL carries its own authority), and the daily job (Cloud Scheduler
presents OIDC).

### Transactions and the pooler

`withAuth()` opens one transaction per request with `app.council_id` set for its whole
span, and hands the handler the transaction. Nothing reaches the database outside
`inCouncilScope()`.

A worry worth deleting: **transaction pooling does not break this.** `withCouncil()` issues
`set_config(..., true)` as the first statement inside the transaction, and a transaction
pooler pins one backend from `BEGIN` to `COMMIT`. What transaction pooling breaks is
session state — bare `SET`, session-scoped advisory locks, `LISTEN` — and this codebase
uses none of them. The audit chain already uses `pg_advisory_xact_lock`, the
transaction-scoped variant. Supabase's Supavisor in transaction mode is safe here.

Every route file exports `runtime = 'nodejs'` (the `pg` driver and `node:crypto` do not
exist on the edge runtime) and `dynamic = 'force-dynamic'` (a cached route handler would
serve one council's data to another).

## The Supabase seams

Three, each selected by environment variable and each defaulting to what works today.

**Auth — `AUTH_DRIVER`.** `apps/web/lib/auth-adapter.ts` is the only place a request
becomes an identity. Setting `AUTH_DRIVER=supabase` currently throws a clear error rather
than half-working, because the prerequisites are not built:

- An identity here is `(who, which council, what role)`. The council is what RLS filters
  on. A Supabase session is only usable once `council_id` and `role` are carried in the JWT
  as custom claims, set by a custom access token hook reading `council_membership`.
- Those claims must be **verified against the project's JWKS**, never merely decoded. A
  decoded-but-unverified JWT is an attacker-supplied council id, and the council id is the
  only thing standing between two councils' case files.
- `auth_otp.purpose` is constrained to `sign_in` or `step_up` because a step-up code
  phished from an inbox must not create a session. Supabase's `verifyOtp` always mints a
  session. Step-up either keeps the existing scrypt path or is rebuilt on something else.

**Storage — `STORAGE_DRIVER`.** `packages/core/src/modules/documents/supabase-storage.ts`
implements the same five-method `StoragePort` as the local and GCS adapters, so nothing
above it changes. Three conditions before switching it on: the bucket must be private,
image transformation must stay off (a re-encoded radiograph is a different file with a
different hash, and the stored sha256 would stop matching), and the bucket needs its own
backup, because Supabase's database backups do not cover Storage objects.

One genuine improvement over GCS: Supabase's `move` is a server-side rename rather than
copy-then-delete, so committing a document does not require delete permission on the
bucket. The GCS adapter's `file.move()` does delete the source, which contradicts the build
plan's claim that the service account holds no delete permission.

**Database.** No seam needed. All 1,271 lines of checked-in SQL apply to Supabase Postgres
unchanged, and the migration runner with its SHA-256 immutability guard does not care who
hosts the cluster. Keep this repo's migrations authoritative; do not adopt the Supabase
CLI's migration system alongside them, because two tracking tables both believing they own
the schema is how a legal record acquires an untracked change.

## The React Native app talking to Supabase directly

This is the decision with the largest consequence, and it is not yet implemented.

A direct client has no server in the path, so it cannot call `withCouncil()` or
`set_config()`. Its queries are filtered by policies evaluated against the caller's own
JWT instead. **That is a second, independent enforcement model over the same tables.**

The practical consequences:

- Every table the app reads needs a policy written against `auth.jwt()` claims. The
  existing `app.council_id` policies return **zero rows** for a PostgREST caller — not an
  error. The failure mode is a silently empty screen, not a loud refusal.
- `audit.append()` reads `app.user_id`, `app.role` and `app.request_id` from GUCs that a
  direct client never sets. Any write reaching the database that way is unattributed, which
  breaks the chain the legal-defensibility story depends on. **Writes should not go
  direct.** Reads may.
- Coalescing the two models in one policy —
  `USING (council_id = coalesce(current_council_id(), (auth.jwt()->>'council_id')::uuid))`
  — is explicitly rejected. It makes a forged claim sufficient whenever the GUC is unset,
  which is precisely when a direct client is calling.

The recommendation, which the officer may overrule: let the mobile app **read** through
JWT-keyed policies and **write** through these route handlers with a bearer token, which
the auth code already supports. That keeps every mutation attributed in the audit chain.

Until those policies exist, the app should use the route handlers for everything.

## Consequences

- One deployable unit instead of two. One pipeline, one set of secrets, one Cloud Run
  service (plus `render-svc`, which stays its own container regardless).
- The process boundary around the secrets is gone. A compromise in the React render path
  now lands in a process holding `DATABASE_URL`, the JWT signing key and the storage
  credential. Next 15 plus React 19 is a larger and faster-moving dependency surface than
  Fastify plus `jose` plus `pg`. This is a real cost and it was accepted knowingly.
- The 703 lines of controller had zero test coverage and their replacements start the same
  way, apart from the default-closed tests. The route layer is now the least-tested part of
  the repository.
- Server components still fetch `/v1` over HTTP rather than calling `@ksdc/core` directly.
  That hop is now pointless and removable; it was kept to hold the diff down.
- `pnpm --filter @ksdc/core daily` runs the scheduled tick as a process, so the daily job
  no longer depends on an HTTP endpoint finishing inside a request timeout.

## Storage: switched on 2026-09-11

`STORAGE_DRIVER=supabase`, bucket `case-documents`, private, 50 MB per object, no MIME
allowlist - a claimed content type is not trusted, and the bytes are sniffed on commit,
which is strictly stronger.

Verified end to end against the live project: signed upload URL issued, bytes PUT straight
to Supabase, commit sniffed the type and computed the sha256, the object moved out of
`staging/` into `documents/<councilId>/`, a signed download returned it BYTE-IDENTICAL, and
the same object without a signature was refused.

**There are no policies on `storage.objects`, and that is the correct state.** No policies
means deny-by-default: an anonymous caller listing the bucket gets `[]` even when objects
exist, confirmed with the publishable key while a document was in there. Only the secret
key, held server-side, can reach the bytes. Policies get written when the React Native app
needs direct read access and not before - each one is a decision, not a default.

**The backup gap is real and unclosed.** Supabase's database backups do not cover Storage
objects, at any tier. The documents are magic-byte-sniffed verbatim originals; they ARE
the evidence. Nothing currently copies them anywhere. Before real case files go in, this
needs either a scheduled export to a second provider or a bucket on a provider that backs
up. It is the largest known gap in the system.

## What is deliberately not done

- Nothing is deployed. The app runs on a laptop; hosting is undecided.
- No backup of Storage objects. See above.
- No JWT-claim RLS policies on `storage.objects` - deliberate, see above.
- No React Native app.
- The build plan's cost model, its two-service deployment section and D7 still describe the
  old shape and need rewriting.
