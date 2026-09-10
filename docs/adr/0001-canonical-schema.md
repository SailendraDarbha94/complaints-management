# ADR-0001 — Canonical schema vocabulary and module ownership

- **Status:** Accepted
- **Date:** 2026-09-10
- **Supersedes:** the seven design studies archived under `docs/adr/background/`

## Context

Seven design studies fed into `docs/00-build-plan.md`. Between them they used **five names for
the central entity** (`case_file`, `matter`, `complaint`, `complaints`, `cases`) and **two for the
tenant column** (`council_id`, `tenant_id`), backed by two mutually exclusive session variables.
Every row-level-security policy and foreign key in those documents is written against one of two
incompatible vocabularies.

Left unarbitrated, the first month of this project is spent on schema merge conflicts, and the
row-level-security policies — the thing standing between council A's patients and council B's
officer — become the least reviewed code in the repository.

## Decision

One vocabulary. It is enforced by CI (`pnpm check:vocabulary`), not by discipline.

| Concept | Canonical | Banned — the build fails |
|---|---|---|
| Central entity | `case_file` | `matter`, `complaint`, `complaints`, `cases` |
| Tenant column | `council_id` | `tenant_id` |
| Session variable | `app.council_id` | `app.tenant_id` |
| Transaction helper | `withCouncil()` | `withTenant()` |
| Parties | `party`, `case_party`, `case_respondent` | `parties`, `respondent`, `case_respondents` |
| Case identifier | `case_number` → `KSDC/COMP/2026-27/0042` | `complaint_no`, `reference_no`, `CMP/` |
| Expert referral | `expert_referral` | `gdc_referral`, `gdc_referrals` |

### The case-number format is one constant

`@ksdc/contracts` exports `formatCaseNumber()` and `CASE_NUMBER_RE`, derived from a single format
string. Templates and (from Phase 2) the mail matcher both import them. A round-trip test formats a
number, embeds it in a subject line, runs the matcher and asserts the same case comes back.

In Phase 1 the officer sends mail by hand from council webmail, so there is no outbound
`Message-ID` to thread on. **The reference token in the subject line is the only thread key that
survives a copy-paste send.** A `CMP` versus `COMP` slip would route every reply to the unfiled
queue, silently, and the failure would look like "the software doesn't find my mail".

### All DDL lives in exactly one place

`packages/db/src/schema/*.ts`. That directory is CODEOWNERS-protected. A table declared anywhere
else does not exist. `@ksdc/contracts` re-exports Zod enums generated from the Drizzle enums, and a
test asserts the Zod members and the Postgres enum members are identical — so a value can never be
valid in the API and invalid in the database.

### Module ownership — one owning module per table

| Module | Owns |
|---|---|
| `modules/cases` | `case_file`, `party`, `case_party`, `case_respondent`, `respondent_notice`, `case_milestone`, `case_state_history`, `case_note`, `contact_event`, `expert_referral` |
| `modules/followups` | `follow_up`, the scheduler, notifications |
| `modules/correspondence` | `correspondence`, `template`, `template_version`, `document`, `document_version`, `number_sequence`, `number_allocation` |
| `modules/committee` | (Phase 4) `sitting`, `agenda_item`, `case_decision`, `case_outcome`, `minutes` |
| `modules/platform` | `council`, `council_config`, `app_user`, `council_membership`, `auth_*`, `audit.events`, `job_run` |

## Consequences

- Renaming any term in the left column later is a migration against a legal register. Treat the
  table as frozen.
- The archived design studies are **background, not a schema source**. Nobody codes from them.
- A pull request adding a table touches a CODEOWNERS-protected directory and therefore requires a
  deliberate decision, which is the point.
