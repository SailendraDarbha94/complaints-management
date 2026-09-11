# Security audit — 2026-09-11

Five agents probed the live Supabase project (`gicmjqvhhmanitvmpnmk`, ap-south-1) across
five attack surfaces. Every finding was then independently re-run by a second agent, which
refuted or corrected several. Everything below marked **proved** was demonstrated with a
command and its output, not inferred.

Nothing was left behind: the forged `user_metadata` one agent planted on the officer's
account was removed, no test users or tables remain, and the 44 rows in `audit.events` are
the seed's own trail, not attack traffic.

---

## What held

These were attacked and did not break.

**No table is reachable over the data API — by anyone.** `case_file`, `correspondence`,
`document`, `app_user`, `auth_otp`, `auth_session`, `job_run`, `council`,
`council_membership`: every one returns `42501 permission denied` to `anon`, to a real
signed-in officer, **and to the secret key**. That last one is unusual and worth keeping:
even a leaked `sb_secret_` key reads no case data over PostgREST, because migration 0006
revoked `service_role`'s grants along with everyone else's.

**A forged tenant in `user_metadata` is never trusted.** An agent planted
`user_metadata.council_id = 00000000-…-deadbeef` on the officer's real account and got it
into a signed token. It was inert: both the RLS policy and `supabase-jwt.ts` read
`app_metadata` only, which a user cannot write.

**The token hook is locked down.** `custom_access_token_hook` and `council_claim_for` —
the two functions that read across memberships — are refused over HTTP to `anon`, to
`authenticated`, and to the secret key. Calling the hook with somebody else's `user_id` is
not reachable.

**The audit schema is not exposed at all.** `Accept-Profile: audit` returns
`PGRST106 Invalid schema`. GraphQL is off; `pg_graphql` is not installed.

**Forgery is refused three ways** — tampered signature, tampered payload, `alg=none`.

**Sign-ups are closed** — `422 Signups not allowed for this instance`.

---

## Fixed

### 1. The daily job accepted any bearer token — *proved, high*

```
no header                       403
Authorization: Bearer junk      200   ← anyone on the internet
```

The gate was `if (auth?.startsWith('Bearer ')) return`, and its own comment stated the
token "is checked by assertScheduler". It was not checked at all. The reasoning had been
that Cloud Run terminates OIDC before the request arrives — true of exactly one deployment,
and of no laptop, preview, or alternative host.

Triggering the job is not catastrophic (it is idempotent and claims the day) but it sends
the officer's digest and advances the escalation ladder, and a stranger should not be able
to fire it repeatedly.

**Now:** a shared secret compared in constant time. Production *refuses to run the job*
with no secret configured, rather than falling open. Moved out of the route file into
`apps/web/lib/scheduler-auth.ts` with 12 tests — a gate living untested inside a route
file is how this survived the NestJS-to-Next port unnoticed.

Set `SCHEDULER_SECRET` on the service and on whatever calls it before deploying.

### 2. An off-boarded member kept access for up to an hour — *proved, medium*

The direct-client path re-checked membership on every row. The server path trusted the
council in the access token for the token's full life. The two paths disagreed — and the
weaker one is the one the officer actually uses.

So a committee member whose term ended this morning went on reading **and writing** that
council's complaints until their token happened to expire, or until they closed the tab.

**Now:** `inCouncilScope` verifies the membership is live before the handler runs. One
indexed query, inside a transaction that was opening anyway. Its five tests are the only
ones that exercise `inCouncilScope` at all — which is precisely why the gap lasted.

### 3. A policy written wider than intended — *proved, high*

Migration 0006 created `jwt_own_membership` with no `TO` clause, which in PostgreSQL means
every role. It was meant for `authenticated` only. Since `app_rw` can set
`request.jwt.claims` itself — it is an ordinary session setting — the policy handed it a
second route to membership rows. Scoped in migration 0008.

---

## Recorded, not fixed

Both are properties of the design, not defects in it. They belong in the record so nobody
rediscovers them as surprises.

### A holder of the `app_rw` credential can read any council

Enumerate council ids, set `app.council_id`, read. This is inherent to enforcing tenancy
with a session GUC: the setting is writable by whoever holds the connection, and no
arrangement of policies changes that.

What row-level security defends against here — and still does — is application bugs and
SQL injection. It was never the defence against a stolen database credential; that is
secret management, network egress, and the fact that `app_rw` holds no DELETE anywhere so
a thief can read but not erase.

Fixing it properly would mean a database role per council, which does not scale to the
multi-council ambition, or moving the council into a connection-level attribute, which
means a pool per council.

### `app_rw` can write audit events under any identity

`audit.append` is granted to `app_rw` because the application calls it. A party holding
that credential can therefore write chain-valid events naming any council and any officer.
The chain proves *nothing has been altered or removed*; it does not prove *who wrote it*.
That distinction is worth knowing before the chain is ever offered as evidence.

The nightly Ed25519 seal to a retention-locked bucket, which the build plan specifies and
nothing yet writes, is what would close this. It remains unbuilt.

---

## Lower-severity notes

- **User enumeration by timing** on `/v1/auth/code` and on GoTrue's `/recover`. The bodies
  are identical; the durations are not. Real but low value to an attacker who already
  knows the council's officers are listed publicly.
- **Weak brute-force throttling** on password sign-in: ~30 attempts per IP before a 429.
- **`mailer_autoconfirm` is on.** Harmless while sign-ups are closed, since only the secret
  key creates accounts. It would matter again the moment sign-ups were reopened.
- **Access tokens survive sign-out** until they expire — normal for JWTs, worth knowing.
- **Schema enumeration** over PostgREST: `PGRST204` for an unknown column versus `42501`
  for a known one lets an unauthenticated caller map table and column names. Stock
  PostgREST behaviour; the names are in a public repository anyway.
- **Five tables lack RLS, not four.** `_migration` is the fifth. Unreachable all the same.
- **Storage has no per-council policy.** It is not switched on, so nothing is at risk
  today, but document tenancy would rest solely on object keys being UUIDs. Write the
  policies before setting `STORAGE_DRIVER=supabase`.

---

## Open, needing a decision

**`linkUser` is trust-on-first-use by email address.** An unlinked `app_user` row is
claimable by whoever obtains a Supabase account for that address. Sign-ups being closed
shuts the obvious door — only the secret key creates accounts now — but the model is worth
naming: the first Supabase identity to present a matching address wins the row.

It matters most for committee members added to the register before they ever sign in. The
safer pattern is to create their Supabase account deliberately, with the secret key, at the
same time as their `app_user` row, so there is never an unlinked row to claim.

Related: the seeded officer row carries `officer@ksdc.in` while the working identity is a
personal mailbox, so automatic linking did not fire and the link was made by hand. Deciding
which address is canonical for officers is a records question, and it should be settled
before committee members are added.
