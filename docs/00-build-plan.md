# KSDC Complaints Management — Build Plan

**Karnataka State Dental Council · complaints register and follow-up system**  
Version 1.0 · 10 September 2026 · owner: Dental Officer, KSDC

> This document is the canonical specification. It was produced from a 39-question requirements
> interview (`docs/requirements.md`) and supersedes any earlier design notes. Where it conflicts with
> the archived dimension documents under `docs/adr/background/`, this document wins.

---

## Executive summary

We are building the Karnataka State Dental Council's complaints register: a web application that replaces a physical book and, more importantly, guarantees that no case is ever sitting silently with nobody chasing it.

The design principle is one column: **`waiting_on`**. Every open case is always parked against exactly one party — the officer, the complainant, a respondent, the committee, or GDCRI — and the home screen is that list, grouped by who you are chasing, sorted by how late they are. Everything else in the product exists to keep that column honest.

The seven dimension designs that fed into this plan collectively specified about sixty tables, four hash chains, two PDF engines, a template IDE, a native member app with screenshot detection, and an AI subsystem — perhaps a year of solo part-time work with nothing usable until the end. That is cut. Phase 1 is nineteen tables, eight case states, one screen that matters, and a daily digest email; it is useful alone and it directly fixes "I keep forgetting to reach out."

Three safety rules override everything. The physical register stays authoritative until an explicit, gated, audited retirement action in Phase 5 — dual-running for ninety days with a weekly reconciliation screen. The software never invents a fact about a dentist: the three-notice counter increments only when the officer confirms a letter went out, never from a timer. And no real case data is entered until the council owns the GitHub org, the domain, the cloud billing account and the signed authorisation letter.

Total infrastructure: one Google Cloud invoice, INR with GST, everything in Mumbai, about **₹6,600/month**.

---

## The sixteen decisions that define the system

Each of these was contested during design. The rejected alternative is recorded so the argument is
not re-run in three months.

### D1. One canonical vocabulary, one schema package. `case_file`, `council_id`, GUC `app.council_id`, helper `withCouncil()`, `case_party`/`case_respondent`, `case_number`. All DDL lives only in `packages/db/schema/*.ts`; ADR-0001 is written and merged before any other code.

**Why.** The dimension designs used five names for the central entity and two for the tenant column, backed by two different session GUCs. Every RLS policy and FK in those documents is written against one of two mutually exclusive vocabularies. Without arbitration the first month is spent on schema merge conflicts.

**Rejected.** Letting each module keep its own names and reconciling at integration time.

### D2. v1 is the follow-up engine and nothing else: 19 tables, 8 case states, one dashboard, plain-text letters, register CSV. Committee, GDC letters, RTI, registry, AI and the member app are later phases, named and dated, not silently dropped.

**Why.** The combined designs are 9–15 months of solo part-time engineering with no value until the end. The user's stated pain is forgotten follow-ups. Phase 1 fixes exactly that in about six weeks and is genuinely usable alone.

**Rejected.** Building the full 60-table design and shipping once.

### D3. `case_file.waiting_on` is a Postgres `GENERATED ALWAYS AS (...) STORED` column derived from `state`. `waiting_since` and `due_at` remain service-written.

**Why.** A stored `waiting_on` maintained by a 39-row transition table will drift within months, and a dashboard that looks authoritative and is wrong is worse than the paper register. Deriving it makes drift impossible and deletes the nightly invariant-recompute job entirely.

**Rejected.** Stored column plus revoked UPDATE grants plus a nightly mismatch alarm — three mitigations for a problem created by storing it.

### D4. The software never generates an outward despatch number. `correspondence.despatch_no` / `despatch_date` / `despatch_register_page` are nullable and typed in after the letter is stamped, with a partial unique index per council+FY and a 'Pending despatch entry' follow-up.

**Why.** The outward register is a physical book shared with certificates and circulars issued by people who will never touch this software. Minting numbers would put the software's 298 against a clerk's handwritten 298 and corrupt the one document the council already produces in court.

**Rejected.** Allocating the office-wide serial from `number_sequence` at despatch time.

### D5. `case_respondent.notice_count` increments ONLY on an officer-confirmed despatch. Escalation ticks never touch it. Generating notice 2 or 3 requires an interstitial showing the full correspondence log and an explicit 'I confirm no reply has been received' click. Ex parte eligibility is computed from `respondent_notice` rows with a `sent_at` and a service record, never from `follow_up.escalation_level`.

**Why.** In v1 the officer must manually log inbound replies, and the premise of the project is that the officer forgets things. A timer-driven counter would produce a false notice count — the legal basis for an ex parte finding against a named dentist.

**Rejected.** Escalation auto-incrementing the notice ladder because 'it only produces a draft'.

### D6. The three-notice → ex parte rule is a warning with a typed-reason override, not a hard block. `respondent_notice` gains `service_mode` and `service_proof_document_id` so the RPAD acknowledgement card can be scanned in.

**Why.** Three notices came from one sentence of discovery, not from a statute anyone has checked. Software that refuses to record what the committee actually decided gets worked around. Proof of service, not notice count, is what sustains an ex parte finding on challenge.

**Rejected.** Hard-coding `notice_count >= 3` as a transition guard and blocking the sitting.

### D7. No native member app in v1. Members get a per-sitting case bundle PDF (the printouts they get today, generated instead of photocopied) plus a read-only mobile-web case sheet behind an OTP magic link, with a `document_access_log`. Usage is instrumented; after three sittings, two-or-more active members is the go/no-go for building the Expo app.

**Why.** Three honorary dentists and the President meeting every 6–8 weeks is the weakest link in the whole design. Watermark rendering, FLAG_SECURE, screenshot listeners, biometric gates and 180-day refresh tokens are months of work resting on an unvalidated assumption. The printouts they get today have no protection at all, so an access log is already an improvement.

**Rejected.** Expo app with server-burned watermarks and per-view document streaming in v1.

### D8. No in-app voting, no chair-confirmation gate, no minutes attestation in v1. A sitting produces one `case_decision` row: date, operative text, attendance, `decided_by ∈ unanimous|majority|consensus`, optional per-member dissent note. Quorum is a warning, never a block.

**Why.** The committee design's own escape hatch — `consensus_no_vote`, officer types it up — is the realistic 95% path. A hard quorum block would refuse to record a decision actually taken after the patient and dentist travelled to Bengaluru, teaching the officer the software is an obstacle.

**Rejected.** Per-respondent vote cards, append-only vote chains, casting-vote rows, 24-hour post-sitting voting windows.

### D9. Neither the Registrar nor the Chairperson can block a workflow. `awaiting_registrar_signature` is not a state; it is an officer follow-up titled 'Get the Registrar to sign…'. Chair approval in v1 is the officer recording 'approved by the Chairperson on <date>, in person/phone/WhatsApp'. Decision letters unlock per case, never behind sitting-wide minutes finalisation.

**Why.** Requirement 6 says the Registrar does not log in. Gating letter generation on a non-user's tap stalls the pipeline behind a busy senior person, and the officer's only recourse is to work outside the system.

**Rejected.** `waiting_on='registrar'` with push notifications, and minutes.finalise as the gate on all decision letters.

### D10. Database: **Cloud SQL for PostgreSQL 16, asia-south1 (Mumbai), db-g1-small, 20 GB SSD, 30-day backups + 7-day PITR** (~₹3,960/mo). Storage: **Google Cloud Storage, dual-region asia-south1 + asia-south2**, versioning on, UUID-only object keys, V4 signed URLs (~₹320/mo).

**Why.** The only combination that is in India, on the same INR+GST invoice as Cloud Run and Scheduler (one PO for procurement), zero-maintenance for a non-engineer, and supports IAM database auth so there is no password to leak. Shared-core has no SLA; at 2–4 complaints/month that is the right trade and the upgrade is a one-line tier change.

**Rejected.** Supabase or Neon (second USD invoice, US entity, reverse-charge GST), AlloyDB (~₹28,000/mo).

### D11. Drop Vercel. Next.js deploys to Cloud Run in asia-south1 alongside the API, `output: 'standalone'`, same pipeline, same domain family.

**Why.** Vercel is a USD invoice from a US entity for a state council whose procurement has not started, and the infra design already carried an exit hatch plus a CI job to stop it rotting — an admission the choice would be reversed. Dropping it deletes the second invoice, the cross-origin cookie design, the banned-imports lint rule and that CI job.

**Rejected.** Vercel Pro at ~₹1,760/mo with a maintained migration path.

### D12. One PDF engine: **Gotenberg 8** as a single extra Cloud Run service `render-svc`, min-instances 0. No ClamAV, no separate bundle-builder, no Eventarc trigger in v1.

**Why.** Letterhead as a print background, exact-mm `@page` margins and Kannada `@font-face` are Chromium-shaped requirements that `@react-pdf/renderer` cannot meet. Four deployable units maintained by one dentist is three too many, and shipping a 'blocked until scan CLEAN' rule with no scanner behind it would stop the officer sending letters.

**Rejected.** `@react-pdf/renderer` in-process; ClamAV-on-finalize gating attachments.

### D13. One audit chain: schema `audit`, table `audit.events`, per-council gapless `seq`, `SECURITY DEFINER` append under an advisory lock, UPDATE/DELETE revoked plus a raising trigger — and a stored `canonical_payload text` column holding the exact string that was hashed.

**Why.** Four competing audit designs existed. Storing the canonical string costs ~50 MB per decade and removes the sharpest edge in the whole design: a Postgres major-version change to `jsonb::text` silently invalidating every historical verification.

**Rejected.** Per-agenda-item sub-chains on votes/resolutions/minutes; re-deriving canonical form at verification time.

### D14. Per-council configuration is one `council_config` row holding a validated JSONB document, plus a checked-in `packages/config/ksdc.seed.ts`. No settings screens in v1. `council_id` + RLS + the CI isolation assertion stay exactly as designed.

**Why.** Fifteen config tables each imply a CRUD screen with validation for a single tenant with a single set of values — an estimated 4–6 weeks. `council_id` on every table is the part that is genuinely irreversible; editable-by-UI config is not. Onboarding council #2 is a second seed file.

**Rejected.** `sla_policies`, `escalation_rules`, `outcome_options`, `numbering_series`, `holiday_calendar`, `notice_texts`, `role_grants` and eight more as tables with screens.

### D15. Three roles in v1: `officer`, `committee_member`, `auditor`. `registrar` and `chairperson` exist as no-login identity rows for letters and attribution. The officer's account is not superuser over `audit.events`.

**Why.** Seven roles over 28 permissions with object-level conditions, a `role_grants` overlay and time-boxed break-glass elevation is machinery for an organisation, not for one operator and three honorary members. The design itself predicted the matrix would churn for three months.

**Rejected.** The seven-role matrix, `platform_admin`, break-glass elevation, `role_grants`.

### D16. AI ships **disabled**: `council_config.ai_enabled = false`, no `ANTHROPIC_API_KEY` provisioned. The gate to turn it on is the signed one-page disclosure note plus the DPDP line in the acknowledgement template. Every intake form works fully manually first.

**Why.** The council has no data policy, no processor agreements and no designated grievance officer. There is no India inference region, so identified patients' clinical narratives would cross the border before any of that exists. At 2–4 complaints a month, typing a complaint in by hand takes ten minutes.

**Rejected.** AI-assisted intake extraction in v1 with disclosure deferred.

---

## 1. One vocabulary, one schema, one owner

Nothing else is merged until `docs/adr/0001-canonical-schema.md` is. It fixes:

| Concept | Canonical | Banned (CI grep fails the build) |
|---|---|---|
| Central entity | `case_file` | `matter`, `complaint`, `complaints`, `cases` |
| Tenant column | `council_id` | `tenant_id` |
| Session GUC / helper | `app.council_id` / `withCouncil()` | `app.tenant_id`, `withTenant()` |
| Parties | `party`, `case_party`, `case_respondent` | `parties`, `respondent`, `case_respondents` |
| Identifier | `case_number` → `KSDC/COMP/2026-27/0042` | `complaint_no`, `reference_no`, `CMP` |
| Referral | `expert_referral` | `gdc_referrals` |

All DDL lives in **`packages/db/schema/*.ts`** (Drizzle) — the only place a table is declared, CODEOWNERS-protected. **`packages/contracts`** re-exports Zod enums generated from those Drizzle enums; one test asserts the Zod members and the Postgres enum members are identical. The seven dimension documents are archived under `docs/adr/background/` and are **not** a schema source — nobody codes from them.

The case-number format is one exported constant plus one regex derived from it, imported by templates and by the mail matcher. A round-trip test formats a number, puts it in a subject line, runs the matcher and asserts the case id comes back. In v1, with no outbound Message-ID, that token is the only thread key that survives a copy-paste send; a `CMP`-vs-`COMP` slip would send every reply silently to the unfiled queue.

**Ownership:** case model, milestones and lifecycle → `modules/cases`. Follow-ups, notifications, scheduler → `modules/followups`. Correspondence, templates, documents, numbering → `modules/correspondence`. Sittings and decisions → `modules/committee`. Audit, auth, tenancy → `modules/platform`. Each table has exactly one owning module.

---

## 2. The register: the columns, and why dates are events

The user asked us to propose the register columns. `v_case_register` is one row per case, printed landscape A3 (or CSV). Sorted by `register_sl_no`, which is per council per financial year and gapless.

| # | Column | Source | Phase |
|---|---|---|---|
| 1 | Sl. No. | `case_file.register_sl_no` | 1 |
| 2 | Case No. | `case_number` | 1 |
| 3 | Date received | milestone `received` | 1 |
| 4 | Category | Patient Complaint / Ethical Violation | 1 |
| 5 | Source & external ref. | `intake_source`, `external_ref_no`, `external_authority_name`, `external_due_at` | 1 |
| 6 | Complainant — name, mobile, email | `case_party` role `complainant` | 1 |
| 7 | Patient — name, age/sex | role `patient` (differs in legal-heir cases; the GDCRI letter names the **patient**) | 1 |
| 8 | Respondent(s) — name, reg. no., establishment | `case_respondent` + `registered_dentist` | 1 (reg. no. 5) |
| 9 | Nature of grievance | `summary` ≤200 chars | 1 |
| 10 | Documents complete on | milestone `documents_complete` — every downstream SLA runs from here, not from receipt | 1 |
| 11 | Notice 1 / 2 / 3 — date + despatch no. | `respondent_notice` | 1 (nos. 3) |
| 12 | Reply received on | `respondent_notice.reply_received_at` | 1 |
| 13 | Heard on | sitting dates, comma-separated | 4 |
| 14 | Expert referral — despatched / report in / shared with patient | `expert_referral` | 3 |
| 15 | Status · **Waiting on** · Days waiting | `state`, `waiting_on`, `now()-waiting_since` | 1 |
| 16 | Decision / outcome (per respondent) | `case_outcome` | 4 |
| 17 | Order despatched on + despatch no. | milestone + `correspondence` | 4 |
| 18 | Closed on + closure reason | `closed_at`, `closure_reason` | 1 |
| 19 | Physical originals held | `physical_custody` open row → Y/N | 3 |
| 20 | RTI refs. | `rti_case_link` | 5 |
| 21 | Officer | `owner_user_id` | 1 |
| 22 | Remarks | `remarks` | 1 |

Column 15 is the one the paper book could never have. Sorting by it is the daily to-do list.

**Dates are events, not columns.** `case_milestone(case_id, milestone, occurred_at, date_source, case_respondent_id, seq_no, ref_table, ref_id, note)`, append-only. Adding a register column later is a view change, not a migration. Crucially, `date_source ∈ ('recorded','from_physical_register','estimated_by_officer')` is **mandatory**; anything other than `recorded` is footnoted in every export and printed case file. That is what stops a reconstructed backlog date from becoming indistinguishable from a recorded fact in an RTI reply or a writ.

v1 milestone vocabulary: `received`, `acknowledged`, `documents_requested`, `documents_complete`, `respondent_notice_despatched`, `respondent_reply_received`, `respondent_declared_ex_parte`, `case_closed`, `case_reopened`. Phase 3 adds `expert_referral_despatched`, `expert_report_received`, `expert_report_shared`. Phase 4 adds `listed_for_sitting`, `heard`, `decision_recorded`, `order_despatched`.

---

## 3. The v1 schema — nineteen tables

| Table | Purpose |
|---|---|
| `council` | tenant root: code, name, address block, registrar/president names, timezone, FY start |
| `council_config` | one row, validated JSONB: SLAs, notice ladder, working days, holidays, outcome list, closure reasons, `ai_enabled` |
| `app_user` | global identity (email, mobile, name). **Not** council-owned |
| `council_membership` | `(app_user_id, council_id, role, starts_on, ends_on, status)` — the council picker and the multi-tenant future |
| `case_file` | the case. Includes `case_kind`, `case_number`, `register_sl_no`, `state`, `waiting_on` (generated), `waiting_since`, `due_at`, `on_hold`+`hold_reason`, `documents_complete_at`, `closure_requested_at`, `is_backfilled`, `legacy_register_ref`, `search_tsv` |
| `party` | person or organisation, with `registered_dentist_id` once identified |
| `case_party` | role on a case: complainant, patient, respondent_dentist, respondent_establishment, informant, witness, legal_representative |
| `case_respondent` | extends a respondent `case_party`: `notice_state`, `notice_count`, `reply_due_at`, `first_reply_at`, `ex_parte_eligible`, `ex_parte_at`, `dropped_at` |
| `respondent_notice` | seq 1..n, `sent_at`, `service_mode`, `service_proof_document_id`, `reply_due_at`, `reply_received_at` |
| `case_milestone` | append-only dated facts (§2) |
| `case_state_history` | append-only transition log (from, to, event, actor, note) |
| `contact_event` | every touch: channel, direction, `purpose`, `party_id`, summary, outcome. The satisfaction primitive for follow-ups |
| `case_note` | append-only revisions, no in-place edits |
| `follow_ups` | the engine (§5) |
| `correspondence` | every letter/email in or out (§6) |
| `document` / `document_version` | metadata over GCS; versions immutable, `sha256` recorded, `status ∈ stored\|misfiled_withdrawn` |
| `number_sequence` + `number_allocation` | case and RTI serials only — never despatch |
| `job_run` | `(job_name, logical_date)` unique — scheduler idempotency |
| `audit.events` | the chain (§11) |

Every table carries `council_id uuid NOT NULL` as the first column of every business unique constraint, `ENABLE`+`FORCE ROW LEVEL SECURITY`, and a `council_isolation` policy on `current_setting('app.council_id', true)::uuid`. Unset GUC → NULL → zero rows, never another council's data. A required CI check asserts every table with a `council_id` column has the policy, and that council B sees zero rows of council A through every repository method.

**No hard deletes.** `deleted_at`/`deleted_by`/`deletion_reason` with a mandatory reason; the app role has no DELETE grant. Corrections write a new value plus a `CORRECTION_RECORDED` audit event with a reason; the UI shows an amber "Amended" chip with who/when/why. **Misfiled documents** — the realistic 11pm mistake of putting patient A's OPG on patient B's case — get a first-class path: `status='misfiled_withdrawn'`, the object rewritten to a `quarantine-misfiled/` prefix that no case-sheet, bundle or export reads, and optionally re-created on the correct case from the same bytes. Nothing is deleted; the audit records the move. The API service account still has no `storage.objects.delete` anywhere.

---

## 4. The case lifecycle — eight states in v1

```
case_state: intake_received | awaiting_complainant_documents | under_scrutiny
          | awaiting_respondent_reply | ready_for_committee
          | awaiting_expert_report | awaiting_order_despatch | closed
```

`on_hold` is a **boolean plus reason**, not a state (sub judice, party indisposed, awaiting external authority). It suppresses SLAs and shows in its own dashboard bucket.

`waiting_on` is generated from `state`:

| State | waiting_on | Dashboard question it answers |
|---|---|---|
| `intake_received`, `under_scrutiny`, `ready_for_committee`, `awaiting_order_despatch` | `council_officer` | "What is on my desk?" |
| `awaiting_complainant_documents` | `complainant` | "Who owes me documents?" |
| `awaiting_respondent_reply` | `respondent` | "Which doctor has not replied?" |
| `awaiting_expert_report` | `expert_body` | "What is GDCRI sitting on?" |
| `closed` | `nobody` | — |

Phase 4 adds `listed_for_sitting` and `heard_awaiting_decision` (→ `committee`) and `compliance_monitoring` (→ `respondent`). Phase 3 adds `awaiting_expert_referral` (→ `council_officer`). Four states from the original sixteen are **not** built: `draft`, `awaiting_registrar_signature`, `expert_report_under_review` and a separate ex-parte state — the first is replaced by ordinary backfilled cases, the second by an officer follow-up, the third by a sitting agenda purpose, the fourth by a respondent-level flag.

Events (v1): `LOG_INTAKE`, `REQUEST_DOCUMENTS`, `DOCUMENTS_RECEIVED`, `MARK_COMPLETE_ON_ARRIVAL`, `ISSUE_RESPONDENT_NOTICE`, `RECORD_RESPONDENT_REPLY`, `DECLARE_RESPONDENT_EX_PARTE`, `DROP_RESPONDENT`, `ALL_RESPONDENTS_RESOLVED` (system), `RECORD_DECISION`, `DESPATCH_ORDER`, `REPORT_SETTLEMENT`, `MARK_COMPLAINANT_UNRESPONSIVE`, `PUT_ON_HOLD`, `RESUME`, `CLOSE`, `REOPEN`.

One data-driven `TRANSITIONS` array in `CaseLifecycleService`, one test per row, one `availableEvents(caseId, actor)` method that drives every button on web and mobile so no UI re-implements a guard. Each transition, in one transaction: writes `case_state_history`, writes the milestone, supersedes the previous state's auto follow-ups, creates the new ones, and appends one `audit.events` row.

**Closure is the officer's.** Requirement 15 is settled: the officer closes, with a reason from `council_config.closure_reasons` — `COMPLAINANT_UNRESPONSIVE`, `AMICABLE_SETTLEMENT`, `DECIDED_BY_COMMITTEE`, `WITHDRAWN`, `NO_JURISDICTION`, `DUPLICATE`, `COURT_SEIZED`, `NOTICE_COMPLIED_WITH`. Committee cover is available and optional, never a gate — a sitting is 6–8 weeks away and a closure cannot wait for it. Reopening is a `case_reopen` row with a mandatory reason back to `under_scrutiny`; there is no appeal entity, and we will say that to the user in plain words rather than invent a statutory workflow.

---

## 5. The follow-up engine and the Today screen — the product

**The invariant:** every open case owns at least one open follow-up, or it is flagged as having no next step. That single rule is the fix for "I keep forgetting to reach out", because forgetting almost always means nothing was ever scheduled — and a case with no timer is invisible to a timer-based system.

```sql
follow_ups(id, council_id, case_file_id, case_respondent_id, sitting_id, rti_request_id,
  stage followup_stage, waiting_on_kind, waiting_on_party_id, assignee_user_id,
  title, detail, opened_on date, due_on date, is_statutory bool,
  status open|snoozed|satisfied|escalated|superseded|cancelled,
  escalation_level int, escalated_from_id, snoozed_until date, snooze_count int,
  satisfied_at, satisfied_by, satisfied_by_contact_event_id, resolution_note,
  dedupe_key text, ...)
CREATE UNIQUE INDEX ON follow_ups (council_id, dedupe_key) WHERE status IN ('open','snoozed');
```

**Dates are `date`, in council-local time, never `timestamptz`.** The domain speaks in days ("give them seven days"); a date column makes working-day arithmetic and overdue counts correct with no DST reasoning.

v1 stages: `AWAIT_PATIENT_DOCS`, `AWAIT_RESPONDENT_EXPLANATION`, `AWAIT_EV_EXPLANATION`, `AWAIT_GDC_REPORT`, `AWAIT_ORDER_DESPATCH`, `AWAIT_COMPLIANCE`, `AWAIT_DESPATCH_ENTRY`, `AWAIT_REGISTRAR_SIGNATURE` (assigned to the *officer*), `AWAIT_AUTHORITY_REPORT_BACK`, `PROPOSE_EX_PARTE`, `PROPOSE_CLOSURE`, `NO_NEXT_STEP`, `AD_HOC`. Rules — due days, business-day or calendar, escalation count and gap, terminal action — live in `council_config.followup_rules`, seeded at 7 days / 3 notices for KSDC.

**Escalation creates a new row** linked by `escalated_from_id` and marks the old one `escalated`; nothing is ever mutated in place, so notice 1→2→3 is provable as three obligations with three dates. **Snoozing sets `snoozed_until` and never touches `due_on`** — snoozing can never launder an overdue case into a clean one, and the snoozed group shows "(2 · 1 overdue)" permanently.

**The engine never decides anything adverse.** After the last escalation it creates `PROPOSE_EX_PARTE` or `PROPOSE_CLOSURE` for the officer. It never auto-closes, never declares ex parte, never sends. And per §Key Decisions it never increments the notice counter — escalation pushes are titled *"no reply logged — check the mailbox"*, never *"did not respond"*, because the system cannot know the latter.

**Satisfaction:** an inbound `contact_event` from the waiting party, a state transition out of the stage, a document of a declared kind, or manual dismissal with a mandatory reason. `NO_NEXT_STEP` cannot be dismissed without creating another follow-up, transitioning, or closing.

**Today** (`GET /v1/queue`, web `/today`, phone browser, tab badge). Grouped by who you are chasing, urgency chips inside:

```
⚠ NEEDS A DECISION (2)   3 notices lapsed — propose ex parte: Dr S. Kamath
                         No next step: KSDC/COMP/2026-27/0009 · quiet 34 days
🔴 OVERDUE (4)           doctor 2 · patient 1 · GDCRI 1
🟠 DUE TODAY (3)         You — draft GDC letter, …/0011
📞 CALLS BEFORE 18 SEP   7 of 11 done
🔵 THIS WEEK (5)         😴 SNOOZED (2 · 1 overdue)
```

Priority is derived in the query, never stored. Row actions without leaving the list: Log contact · Draft reminder · Call (`tel:`, logs a contact event) · Snooze · Done · Open case.

**Delivery.** Phase 1: the in-app queue plus **one daily digest email at 09:00 IST to the officer's own address** (we already run a transactional mailer for OTP login). Explicitly **no system mail to registrar@ksdc.in** — that is the inbox the complaints arrive in and the pile the user is escaping. Phase 2 adds Web Push from a PWA, subscribed behind a deliberate Settings button (a browser prompt fired unprompted and denied is unrecoverable). Push title and body carry the case number and stage label only — never a party name.

**Scheduler.** No in-process cron: Cloud Run scales to zero and throttles CPU between requests. Cloud Scheduler (`Asia/Kolkata`) → OIDC → `POST /internal/jobs/:job`, guarded by `SchedulerOidcGuard`. Every handler is wrapped in one `@ScheduledJob('name')` decorator that owns the `job_run` row, the advisory lock, the structured `{"job":…,"status":"ok"}` log line and the Healthchecks.io ping — so a new job cannot be added without the alarm. Jobs: `daily` 09:00, `hourly` 08–21, `nightly` 01:30, `weekly-digest` Mon 08:00.

---

## 6. Correspondence, templates and numbering

**Two series the software owns:** `case_number` = `KSDC/COMP/2026-27/0042` (per council, per category, per FY, `UPDATE … RETURNING` inside the transaction, logged in `number_allocation`) and `rti_no`. That is all. The outward despatch number is typed in after the letter is stamped (see Key Decisions); until then `{{letter.despatch_ref}}` renders `KSDC/____/2026-27` as a pen-fillable blank, and an `AWAIT_DESPATCH_ENTRY` follow-up chases it. The complaint number always prints on its own reference line under the subject — that line never blanks.

**Templates are a textarea, not an IDE.** `template` / `template_version(subject_tpl, body, page_setup, published_at)`; the body is plain text (Phase 1) or simple HTML (Phase 3) with `{{field}}` tokens. Rendering is a ~30-line `renderTemplate(body, ctx)` supporting `{{field}}` and `{{#if field}}…{{/if}}`, escaping everything it inserts. Validation extracts tokens by regex and rejects any not in the template kind's declared field list, naming the valid ones. **Cut:** TipTap/ProseMirror, the merge-field atom node, Handlebars with an AST whitelist, Levenshtein suggestions, `locale` UI. **Kept**, because both are legally load-bearing: the **two-phase render** (all data slots — reference line, dates, addresses, deadlines, statutory wording — are filled *before* any AI-generated narrative is substituted, so those can never be rewritten), and **`merge_context` jsonb** snapshotted on every correspondence row so we can prove in 2031 what wording and what data produced a 2026 letter.

**Catalogue (Phase 1 text, Phase 3 PDF):** `ACK_COMPLAINT`, `REQUEST_DOCS`, `REQUEST_DOCS_REMINDER`, `RESPONDENT_EXPLANATION_SOUGHT`, `RESPONDENT_REMINDER`, `RESPONDENT_FINAL_NOTICE`, `SUMMONS_COMPLAINANT`, `SUMMONS_RESPONDENT`, `MEMBER_INTIMATION`, `GDC_REFERRAL_LETTER`, `GDC_REFERRAL_COPY_TO_PATIENT`, `EXPERT_REPORT_SHARE`, `ORDER_TO_RESPONDENT`, `ORDER_TO_COMPLAINANT`, `CLOSURE_INTIMATION`, `ETHICS_EXPLANATION`, `ETHICS_CEASE_DESIST`, `REPLY_TO_REFERRING_AUTHORITY`, `RTI_REPLY_COVER`.

`REQUEST_DOCS` carries the fixed checklist the officer sends today: itemised bills/receipts, prescriptions and treatment records, a chronological timeline, a concise summary, and the dentist's name, qualification, registration number and full clinic address, plus radiographs/OPGs if any.

**Sending, v1.** A `DraftComposer` panel: copyable subject (reference token pre-inserted), copyable body (`ClipboardItem` with both `text/html` and `text/plain`), an attachment checklist with per-file download, then one **"I have sent this"** confirmation with an editable date. That click writes `sent_at`, sets `response_due_at`, increments `respondent_notice.notice_count`, and emits the event that **starts the 5–7 day clock**. It all sits behind an `OutboundMailPort` so switching to SMTP later is one DI provider — the correspondence record, the timers and the audit are identical either way. Inbound is symmetrical from day one (`direction='IN'`, paste + upload) so the register shows a real two-way chronology before any mailbox is connected.

---

## 7. The GDC referral flow

One table, `expert_referral`, owned by `modules/cases`. The letter itself is an ordinary `correspondence` row of `kind='EXPERT_REFERRAL'` linked from it — not a parallel model.

```
referral_state: letter_drafted → awaiting_signature → signed_awaiting_despatch
              → despatched → appointment_fixed → report_received
              → committee_annotated → shared_with_complainant | withheld
              (| superseded | abandoned)
```

A partial unique index enforces at most one live referral per case; `seq_no` plus a `superseded` state exists so a re-referral after a deficient report needs no migration.

The letter reproduces the observed artefact: Ref line, stamped date, To the Dean GDCRI, subject *"Appointment of an Expert in the case of patient named <NAME>"* with the patient's mobile beneath it, `Ref: Complaint No. {{case.number}}` on its own line, the two questions (negligence; ethical guidelines followed), the request for a copy of the report for record, and page 2 as the "Copy To: <patient>" intimation. The two questions are editable template text, but the template is flagged `is_system` and editing raises a publish-time warning that this changes the terms of reference.

The print → wet signature → seal → scan loop is modelled honestly: the generated PDF and the **signed scan are two distinct `document` rows**, and from `despatched` onward the register and every bundle cite the scan. `CHECK (despatched_at IS NULL OR signed_scan_document_id IS NOT NULL)`. `awaiting_signature` is *not* a case state — it is an officer follow-up (`AWAIT_REGISTRAR_SIGNATURE`, escalating every 2 days) titled "Get the Registrar to sign the GDCRI letter for KSDC/COMP/2026-27/0042". The Registrar receives no notification and needs no account.

**The share gate.** `expert_referral.share_decision ∈ ('not_decided','share_as_annotated','withhold')` plus `committee_annotation_document_id`, writable **only** from a recorded committee decision, with `CHECK (shared_at IS NULL OR share_decision = 'share_as_annotated')`. The report reaches the patient only after the committee has modified/added to it and agreed to share. Making that a field the officer could set casually would be a confidentiality incident, so it is a constraint, not a convention. The report's document class is `may_summarise = false` — no AI path can ever reach it, enforced by a throwing context loader, not by a prompt.

---

## 8. Committee sittings and how members actually get the file

Phase 4. Tables: `sitting`, `agenda_item`, `sitting_attendance`, `recusal`, `deliberation_comment`, `case_decision`, `case_outcome`, `minutes`. Deleted from the plan: `vote`, `decision_vote`, `resolution`, `minutes_attestation`, `committee_bodies`, per-item hash chains.

**The sitting.** Officer fixes the date on WhatsApp (the user's choice; it stays outside the app) and types it in. `v_agenda_candidate` suggests ripe cases — explanation received or the notice ladder exhausted, `documents_complete_at` set, expert report returned, or an adjournment resumed — and shows non-ripe cases with their blockers, so a forgotten "documents complete" tick is visible rather than invisible. Officer picks 2–4. Publishing the agenda generates the **call checklist** (`sitting_call_task`, one row per complainant and per active respondent, parties only — members are coordinated on WhatsApp by explicit requirement) and drafts summons. Ticking a call writes a real `contact_event`, because "telephoned twice, no answer" is half of an ex parte justification.

**The decision.** One `case_decision` row: `decided_on`, `operative_text` (goes verbatim into the letter), attendance, recusals, `decided_by ∈ unanimous|majority|consensus`, optional dissent notes, plus per-respondent `case_outcome` rows — different respondents genuinely diverge. Outcomes: `NO_MISCONDUCT`, `WARNING`, `CENSURE`, `REIMBURSEMENT`, `RETREATMENT`, `SUSPENSION`, `REMOVAL_FROM_REGISTER`, `AMICABLE_SETTLEMENT`, `REFERRAL_TO_MEDICAL_EXPERT`, `ADVISORY_TO_ESTABLISHMENT`, `CEASE_AND_DESIST_CONFIRMED`, `COMPLAINT_DISMISSED`. Quorum is displayed as a warning; the officer decides whether the sitting can proceed. Decision letters unlock **per case** the moment that case's decision is recorded — never behind sitting-wide minutes.

**Minutes** are the system-generated header and per-case sheets plus the officer's typed consolidated notes, rendered once to an immutable PDF version. Corrections are a new version with a mandatory `corrigendum_reason`.

**Members.** No app. Each member gets (a) the per-sitting **case bundle PDF** — exactly the printouts they receive today, generated instead of photocopied, and (b) an OTP magic link to a **read-only mobile-web case sheet**: parties (complainant phone/email/address masked), respondent history, chronology, documents inline, respondent explanation verbatim, expert report verbatim, prior decisions. Every document view writes `document_access_log`, and the page says so. Recusal and comments are the only writes. Access to documents ends when the case closes or the member's term ends.

After three sittings we count active link users. **Two or more → build the Expo app** with push, watermarking and offline bundles. **Fewer → do not**, and we have saved months. That go/no-go is recorded in `docs/adr/`.

---

## 9. Ethics-violation notices

Same `case_file`, `case_kind='ethics_notice'`, driven by a `case_type` config row rather than a second code path: `requires_complainant=false`, `allows_expert_referral=false`, `max_respondent_notices=3`, `default_party_response_days=7`, and an `allowed_states` array that omits `awaiting_complainant_documents` and `awaiting_expert_report`. Case numbers run a separate series, `KSDC/ETH/2026-27/0007`.

The intake is a **manual form**, not the complaint form: source of the information (`intake_source ∈ dci_ndc_forward | police_forward | suo_motu | direct_email | other`), an optional informant party that may be marked `is_confidential`, the respondent (required), the allegation text, and documents. No AI extraction for this kind in v1 — the complaint-shaped extraction schema requires a complainant and would have to be forked for no benefit at two or three notices a year.

The lifecycle is the complaint lifecycle minus the complainant-document phase and minus expert referral: `intake_received → under_scrutiny → awaiting_respondent_reply → ready_for_committee → awaiting_order_despatch → closed`. Outbound is `ETHICS_EXPLANATION` then `ETHICS_CEASE_DESIST`. Closure reason `NOTICE_COMPLIED_WITH` exists for the common ending.

The case sheet renders "Informant (confidential)" or "Suo motu" where the complainant block would be, and the register's Category column distinguishes the two kinds at a glance — the reader must be able to tell which is which without opening anything.

**Forwarded matters.** Complaints also arrive forwarded from support@, from DCI/NDC and occasionally from the police. `MailIngestService` detects `message/rfc822` parts and `Fwd:`/`FW:` subjects and prefers the **inner original** for `from_addr`, `sent_at` and extraction, keeping the forwarder in `received_via` — otherwise sender matching mis-fires on every forwarded case. Where the referring authority imposes a reply-by date it goes in `external_due_at`, which outranks the council's own 7-day norm, drives an `AWAIT_AUTHORITY_REPORT_BACK` follow-up, and has its own outbound template.

---

## 10. RTI

Phase 5, and deliberately minimal — the user asked to scan and upload RTI requests and their answers and track them.

```sql
rti_request(id, council_id, rti_no, fiscal_year, received_on date, received_via,
  applicant_name, applicant_address, applicant_phone, applicant_email,
  subject, request_document_id, fee_received, is_bpl,
  due_on date,            -- received_on + 30 days
  state received|under_process|replied|rejected|closed,
  reply_document_id, replied_on, despatch_no, despatch_date,
  rejection_ground, notes)
rti_case_link(rti_request_id, case_file_id, note)   -- many-to-many, both sides optional
```

First and second appeals go in `notes` until a second appeal actually arrives; they become rows when one does. `AWAIT_RTI_REPLY` is a **statutory** follow-up — calendar days, not working days, pre-alerts at T−20/−7/−2, and it cannot be snoozed past `due_on`, because missing the 30 days is a personal penalty on a named officer.

Screens: RTI list with days-remaining chips; intake (scan upload, applicant, subject, fee/BPL); link to cases; reply drafting from `RTI_REPLY_COVER`; reply scan upload; despatch record.

**Redaction is manual and non-destructive.** The Export Builder lists every item in a case with Include / Exclude-with-reason / Substitute-a-manually-redacted-copy. The bundle carries a redaction log naming every withheld item and the ground relied on. The system will never draw black boxes over text and call it redacted, and it will never attempt automated PII redaction on an X-ray.

**Cut entirely from v1**, and named here so they are visibly deferred rather than forgotten: the DPDP `data_requests` workflow (access/correction/erasure/nomination), `security_incidents` with board-notification checkpoints, the generated Record of Processing Activities, retention-review queues and disposal certificates, and the `auditor_grants` scoping model. What we *do* build now is the four cheap load-bearing pieces: a versioned `notice_texts` v1 shown at intake, `case_file.processing_basis` (default `statutory_function`), `retention_until` plus `legal_hold`, and the access log — which audit gives us free. The rest becomes a one-page policy pack for the Registrar to sign, listed in §Open Questions.

---

## 11. Tenancy, identity, roles and audit

**Tenancy.** Shared schema, `council_id` on every table, RLS as the enforcement point — not ORM middleware. The app connects as `app_rw` (NOBYPASSRLS, owns nothing, DELETE revoked everywhere, INSERT+SELECT only on `audit.events`). Exactly one way to reach the database:

```ts
export async function withCouncil<T>(ctx, fn: (tx) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.council_id', ${ctx.councilId}, true),
                                set_config('app.user_id',   ${ctx.userId},   true),
                                set_config('app.request_id',${ctx.requestId},true)`);
    return fn(tx);
  });
}
```

The raw handle is not exported; an ESLint rule bans importing it outside `src/db/`. A dev-mode assertion **throws** when `app.council_id` is unset rather than returning empty, because "the data disappeared" is the worst debugging experience in this design.

**Identity.** Global `app_user` + `council_membership`; the JWT carries `active_council_id`. Passwordless email OTP (6 digits, 10 minutes, argon2id-hashed, rate-limited); 15-minute EdDSA access token; opaque rotating refresh token with reuse detection, in an `HttpOnly; Secure; SameSite=Lax` first-party cookie. Council switching is a token re-mint, so the requirement-38 picker works from day one even though there is one council. Step-up OTP on six actions: register export, case-file export, member management, council settings, case close, minutes finalise.

**Roles (v1):** `officer` (everything), `committee_member` (read all cases, recuse and comment, no case writes), `auditor` (read-only, time-boxed). `registrar` and `chairperson` exist as no-login identity rows so letters and attribution work. Denials return 404 across councils (never confirm existence), 403 within one.

**Audit.** Schema `audit`, table `audit.events`: per-council gapless `seq` under `pg_advisory_xact_lock`, `prev_hash`/`hash`, and **`canonical_payload text`** storing the exact string that was hashed. UPDATE/DELETE revoked plus a `BEFORE UPDATE OR DELETE` trigger that raises. Two writers: a row-level trigger on every business table (column diffs, actor from the GUCs, `metadata.unattributed=true` as the canary for a path that bypassed `withCouncil`) and explicit semantic events (`RESPONDENT_NOTICE_SENT`, `EX_PARTE_DECLARED`, `EXPERT_REPORT_SHARED_WITH_PATIENT`, `CASE_CLOSED`, `CORRECTION_RECORDED`, `EXPORT_GENERATED`, `DOCUMENT_DOWNLOADED`). The timeline UI renders the semantic ones; `case_milestone` remains the *register* projection and is rebuildable from the chain.

Nightly the chain head is signed (Ed25519, a separate `cms-seal` service account) and written to a **retention-locked** GCS bucket the API cannot write to. An alert fires if no seal lands in 48 hours. The head hash prints in the register PDF footer and on the printed case file, so a printout ties back to the chain. **No blockchain anchoring** — nobody at a state council will verify a Merkle proof, and the retention-locked object already answers "prove this wasn't backdated".

**The authorisation gate.** `council.production_authorised_at` stays NULL until four artefacts exist in `docs/authorisation/`: the signed letterhead authorisation, the Registrar's email to the project account, proof the domain is registered to the council, and proof the GCP billing account is the council's. While NULL the API refuses to create a non-synthetic case and the dashboard shows "DEMO DATA". Build and demo against the synthetic council until then. The legal register of a statutory body must never live inside one individual's personal Google account by drift.

---

## 12. Architecture, infrastructure and cost

**Everything in one GCP project, asia-south1 (Mumbai), one INR + GST invoice from Google Cloud India Pvt Ltd.** One PO, one line item, all data in India.

| Service | Config |
|---|---|
| **Cloud SQL PostgreSQL 16** | `db-g1-small`, 20 GB SSD auto-grow, zonal, 30-day backups, 7-day PITR, IAM database auth (no password exists), deletion protection. Databases `ksdc_prod` + `ksdc_staging` on one instance |
| **GCS** | `ksdc-cm-prod-documents` dual-region asia-south1+asia-south2, UBLA, versioning, soft-delete 30d; `-exports`, `-backups`, `-audit-seals` (retention-locked). Keys are UUID-only — no patient names, no filenames (keys appear in logs and browser history); filename applied at download via `response-content-disposition` |
| **Cloud Run `ksdc-api`** | NestJS+Fastify, 1 vCPU/1 GiB, min=1, max=4, concurrency 40, request-based billing |
| **Cloud Run `ksdc-web`** | Next.js `output:'standalone'`, min=0 |
| **Cloud Run `render-svc`** | Gotenberg 8 + Noto Serif/Sans/Kannada/Devanagari, min=0, internal ingress |
| **Cloud Scheduler** | 4 jobs, OIDC → `/internal/jobs/:job` |

Uploads go **direct to GCS** via a V4 signed PUT into a `staging/` prefix, then a `commit` endpoint sniffs magic bytes, hashes, and rewrites into place — Cloud Run caps requests at 32 MB and we accept 50 MB OPG scans. Downloads are 5-minute signed URLs, audited on issue.

**Monorepo:** pnpm workspaces + Turborepo, Node 22, `.npmrc` with `node-linker=hoisted` (non-negotiable for Expo/Metro later). `apps/web` (Next.js, route handlers + UI), `packages/{core,db,contracts,config,ui,testing}`, `infra/{terraform,docker-compose.yml,sql}`, `docs/{adr,runbooks,authorisation}`. **Drizzle**, not Prisma: this system's correctness lives in RLS policies, audit triggers and revoked grants, which Prisma does not model and `migrate` treats as drift. Migrations are checked-in SQL, expand/contract enforced — a CI script fails any `DROP COLUMN|DROP TABLE|RENAME|ALTER…TYPE` unless the file is `*.contract.sql` and the PR carries `destructive-migration-approved`. Applied by a Cloud Run **job** before traffic shifts, never at boot. GitHub Actions authenticates by Workload Identity Federation — no service-account JSON key exists.

| Item | ₹/month |
|---|---|
| Cloud SQL | 3,960 |
| Cloud Run api (min=1) | 1,230 |
| Cloud Run web + render-svc + staging | 550 |
| GCS (~25 GB) + egress | 520 |
| Artifact Registry, Scheduler, Secret Manager, jobs, drill | 310 |
| Sentry / Healthchecks / Cloud Logging | 0 (free tiers) |
| **Total** | **≈ ₹6,570 (~₹79,000/yr)** |

Phase 6 AI adds ~₹900/mo (about $1 per case). Apple/Play fees only if the app is ever publicly listed — internal distribution to five people needs neither.

**Backup/DR: RPO ≤ 5 min, RTO ≤ 4 h.** Daily automated backup, 7-day PITR, weekly logical dump (90d), monthly dump (8 years, Coldline), dual-region documents plus a weekly append-only DR replica, and — the one that matters most — a **nightly register export**: a signed CSV of every case, every milestone date, every outcome, plus `manifest.json` with each document's GCS key and sha256. That protects against the project ending, not just the infrastructure failing; any competent person with a laptop can reconstruct the register from it. A monthly automated restore drill verifies row counts, the audit chain and 20 sampled document hashes.

**The reminder ticker gets three independent alarms**, because a silently dead ticker recreates the exact pain this product exists to remove: (1) a Cloud Monitoring **metric-absence** alert if no successful tick in 26 hours; (2) a Healthchecks.io heartbeat that alerts from *outside* GCP, so a project-wide failure still reaches a phone; (3) an always-visible "Reminders last ran 09:02 today" banner on Today, red past 26 hours — visible to the person most harmed, depending on no alerting infrastructure at all. Every alert names a second human (the Registrar for ticker failure), and `docs/runbooks/handover.md` is written for a competent stranger.

---

## 13. AI assist — built, disabled, gated

`council_config.ai_enabled = false` at launch and no `ANTHROPIC_API_KEY` provisioned. Every intake and drafting form works fully manually first; AI is only ever an enhancement of a working form, and that discipline is enforced by simply not having the AI path at launch.

**The gate to enable it** is one checkable artefact: a signed one-page note to the Registrar stating (a) that complaint text and locally-extracted document text, including patient health information, is transmitted to Anthropic's API; (b) that **no images** — no radiograph, OPG or clinical photo — and **no expert report, respondent explanation, minutes or vote record** are ever transmitted; (c) that data is not retained by the vendor and not used to train models (zero data retention on the account); (d) that processing occurs **outside India** — there is no India inference region today, so this is disclosed, not avoided; and (e) that **no decision, finding, outcome or case status is ever produced by software**. Plus the DPDP line added to the acknowledgement template.

**When enabled (Phase 6), three tasks**, all `claude-opus-5` with effort tuned per task, all with **no tools declared** and Zod-constrained structured output:
1. *Intake extraction* — parties, respondents, treatment, chronology, grievance types, a 200-word summary, and a `documents_missing` list that pre-fills the `REQUEST_DOCS` letter.
2. *Draft narrative slots* — the model receives the letter **already rendered** with every data slot filled and only `<<<FILL: key>>>` sentinels left; it returns `{slots: {...}}`. Any key not declared as a narrative slot is discarded. It cannot touch the reference line, the deadline, the statutory wording or the operative decision paragraph, because it never receives them as writable.
3. *Case-sheet background narrative* — one labelled ≤400-word section; everything else on the sheet is deterministic or verbatim.

**Guardrails, all kept:** every field returns `{value, found: explicit|inferred|absent, quote}` and the server **verifies each quote is a literal substring** of the source, demoting `explicit`→`inferred` and nulling fabricated quotes — a checkable claim, unlike a confidence float. Output lands in `ai_extraction_field` rows that an officer accepts **individually**; Save is disabled while any required field is pending. A distinct Postgres role `app_ai` has no INSERT/UPDATE on `case_file`, `case_outcome`, `case_decision`, `expert_referral` or `correspondence` — "AI cannot change the case" is a grant, not a convention, with a CI test asserting the grant set. Every run writes an append-only `ai_run` row: task, model id, effort, prompt file path **and sha256**, input hash, full output, usage, `inference_geo`, requester. Every AI-assisted document carries a one-line provenance footnote in the printed case file and register export.

Aadhaar/PAN/bank/UPI/card patterns are hard-dropped before transmission. Names, phones and emails are **not** redacted — extracting them is the task, and pretending otherwise would be false assurance to the Registrar.

---

## 14. What we are deliberately NOT building in v1

Named, so they are visibly deferred rather than quietly lost.

**Not built, ever (decided against):** the software minting outward despatch numbers · blockchain/OpenTimestamps anchoring of the audit chain · CMEK (a KMS key whose accidental disable makes every document unreadable) · VPC Service Controls, WAF, pen-testing before the first live case · PgBouncer · MDM/DRM/jailbreak detection on members' phones · automated PII redaction of documents · any autonomous send.

**Deferred to a named phase:**

| Cut from v1 | Returns |
|---|---|
| Web Push / PWA (Phase 1 uses in-app queue + one daily digest email to the officer) | Phase 2 |
| IMAP mailbox reading, unfiled queue, thread matching | Phase 2 |
| Gotenberg PDFs, letterhead rendering, printable case file | Phase 3 |
| GDC referral flow, despatch-number capture, physical custody tracking | Phase 3 |
| Committee sittings, agenda, attendance, decisions, minutes, call checklist | Phase 4 |
| Member access (bundle PDF + magic-link case sheet) | Phase 4 |
| Ethics-notice intake, RTI module, dentist registry Excel import, suspension tracking | Phase 5 |
| AI assist; native Expo app; in-app voting | Phase 6, each behind its own gate |

**Cut and replaced with something simpler (not merely postponed):** 16 case states → 8 + a boolean. 39 transition rows → 17 events. 60+ tables → 19 in v1. Seven roles / 28 permissions → three roles / ~10 permissions. Fifteen config tables → one JSONB row + a seed file. Four audit chains → one. TipTap + hardened-Handlebars template IDE → a textarea with a field picker and a 30-line renderer. Per-respondent voting with tallies, casting votes, quorum blocking, chair confirmation and minutes attestation → one `case_decision` row. Native member app with server-burned watermarks, FLAG_SECURE and screenshot detection → a generated bundle PDF plus a logged read-only web page. Vercel → Cloud Run. ClamAV + Eventarc + a separate bundle-builder → nothing (the council forwards these same attachments from webmail today with no scanning at all; we are not making it worse, and shipping a "blocked until CLEAN" rule with no scanner behind it would stop the officer sending letters). DPDP data-request/incident/RoPA modules → a policy pack for the Registrar.

The cut list lives in `docs/v1-scope.md` and is the answer to every mid-build "while we're in here…".

---

## 15. Retiring the physical register — the safety gate

This is the single most likely way this project harms the user, so it is designed, not left to drift. The failure mode: the officer enters the ten open cases, stops writing in the book by week two, then hits a bug or an outage in month three and has neither a working system nor a maintained register — for a quasi-judicial body.

**The paper register remains authoritative until an explicit, one-time, audited retirement action.** Until then the dashboard carries a persistent banner: *"Paper register still authoritative — day 41 of 90."*

Four conditions must all be true before that action becomes available:
1. **90 consecutive days** of dual-running from the start of Phase 2.
2. **90 consecutive verified nightly register exports** (checked by the nightly job; a gap resets nothing but is reported).
3. The officer has **personally executed `docs/runbooks/restore.md` end to end** and recorded the elapsed time in the runbook. A runbook never run by the person who will need it is not a runbook.
4. **Four consecutive clean weekly reconciliations.** The Reconciliation screen prints that week's software register beside blank tick columns; the officer ticks against the book and records discrepancies. Each reconciliation writes an audit event.

Then a single **"Retire the physical register"** action, step-up authenticated, writes a dated audit event and drops the banner.

**Backfilling the ten open cases** (start of Phase 2) uses no special mode and skips no guards. Cases are entered normally with three additions: `is_backfilled`, `legacy_register_ref`, and a **mandatory `date_source`** on every milestone (`from_physical_register` or `estimated_by_officer` where it is not a recorded fact) — footnoted in every export. A photograph of the relevant physical register page is attached to each case as a `legacy_register_extract` document. **`register_sl_no` is seeded from the book** and new cases start after the highest: renumbering a legal register is worse than a gap, and we say that to the officer explicitly rather than design around it silently.

**Degraded mode.** Two rules written into `docs/runbooks/outage.md`. First, the council mailbox — never the software — is the primary evidence of receipt; `received_at` always comes from the email timestamp or the physical stamp, not from when it was typed in. Second, a one-page printable **intake slip** (case no. blank, received date, complainant, respondent, summary) captures an arrival during an outage for later entry with `date_source='from_physical_register'`. The same runbook explains how to pull the overdue follow-up list out of the last nightly export and how to fire a tick manually, so nothing slips while the ticker is being fixed.

---

## Roadmap

Each phase is shippable and useful on its own. Phase 1 fixes the stated pain even if the project
stops there.

| Phase | Goal | Duration |
|---|---|---|
| **Phase 0** | Remove the four unknowns that can invalidate months of work, and settle the vocabulary | 2 weeks elapsed, ~6 hours of the officer's time (mostly emails and phone calls) |
| **Phase 1** | Fix 'I keep forgetting to reach out' | 6 weeks part-time (~5–6 weekends plus evenings) |
| **Phase 2** | Stop the officer having to manually log every inbound reply, and make the register trustworthy enough to run beside the book | 4 weeks part-time |
| **Phase 3** | Replace the officer's Word documents, and make the longest-latency leg of a case visible | 4 weeks part-time |
| **Phase 4** | Stop the officer photocopying case sheets, and get decisions into the register the day they are made | 4 weeks part-time |
| **Phase 5** | Complete the officer's actual job description, then make the software the system of record — safely and on the record | 4 weeks part-time |
| **Phase 6** | Build only what the first five phases have proved is wanted | Open-ended, 2–4 weeks per item |

### Phase 0 — Authorisation, accounts and facts

*2 weeks elapsed, ~6 hours of the officer's time (mostly emails and phone calls)*

**Goal.** Remove the four unknowns that can invalidate months of work, and settle the vocabulary. Runs in parallel with Phase 1 build; only gates real case data.

**Deliverables**

- `docs/adr/0001-canonical-schema.md` — the glossary, the ownership map, the banned-identifier CI grep
- `docs/v1-scope.md` — the cut list from section 14, so every later 'while we're in here' has an answer
- Repo transferred to a `ksdc` GitHub org with the Registrar as second owner; domain registered in the council's name; GCP billing account under the council's PAN/GST started
- MX-record check on ksdc.in + one call to the mail host → `docs/adr/0002-mail-host.md` recording whether IMAP + app passwords exist, and whether a forwarding rule to a council-owned Workspace mailbox is easier to get approved
- Officer pastes a formatted test letter into the actual council webmail and screenshots the result (settles the clipboard-HTML question in five minutes rather than at launch); prints the letterhead calibration sheet on the office printer
- Signed authorisation letter + Registrar's email filed in `docs/authorisation/`
- One-page cost sheet handed to the Registrar: ₹6,570/month, one INR+GST invoice from Google Cloud India Pvt Ltd, all infrastructure in Mumbai

**Done when.** All four authorisation artefacts exist in `docs/authorisation/`, so `council.production_authorised_at` can be set — and the mail-host and webmail questions have written answers.

### Phase 1 — The follow-up engine

*6 weeks part-time (~5–6 weekends plus evenings)*

**Goal.** Fix 'I keep forgetting to reach out'. Nothing else. This phase is useful alone even if the project stopped here.

**Deliverables**

- 19 tables (§3), RLS + `withCouncil()` + the CI isolation test, `audit.events` with the chain and `canonical_payload`
- 8-state lifecycle, generated `waiting_on`, 17 events, one test per transition row
- `follow_ups` with escalation-as-new-row, snooze that never moves `due_on`, the `NO_NEXT_STEP` nightly sweep, and the notice-counter severing rule
- The **Today** screen: grouped by who you are chasing, with Log contact / Draft reminder / Call / Snooze / Done inline
- Daily 09:00 IST digest email to the officer's own address; email-OTP login; the 'Reminders last ran…' banner
- Manual case intake, case detail (parties, respondents, timeline, documents, correspondence log), document upload via signed URLs
- Plain-text templates + DraftComposer copy panel + 'I have sent this' → starts the clock
- Register CSV export; Cloud SQL + GCS + two Cloud Run services + Cloud Scheduler live in Mumbai; ticker alarms wired **before** the ticker logic

**Done when.** The officer runs one real, live case end to end — intake, document request, respondent notice, reply logged, closed — from the Today screen, without touching the paper book for that case, and receives the correct digest email on three consecutive mornings.

### Phase 2 — Mail in, register out, dual-running starts

*4 weeks part-time*

**Goal.** Stop the officer having to manually log every inbound reply, and make the register trustworthy enough to run beside the book.

**Deliverables**

- Read-only mailbox ingestion (IMAP `readOnly:true`, never marks read, never moves mail — or a forwarding rule into a council-owned mailbox if that is easier to get approved), `mail_message`/`mail_attachment`, idempotent on Message-ID with a sha256 secondary guard
- Unfiled queue + the 4-rung matching ladder (only the reference token and thread headers auto-file; sender match only suggests) + forwarded-message unwrapping
- Web Push from a PWA, subscribed behind a deliberate Settings button
- The ~10 open cases backfilled with `date_source` and scanned register pages; `register_sl_no` seeded from the book
- Weekly Reconciliation screen + the 'Paper register still authoritative — day N of 90' banner
- Nightly signed register export + manifest; `docs/runbooks/restore.md`; first manual restore drill executed by the officer
- Global search (cases, parties, dentists) with phone-number normalisation

**Done when.** An inbound reply from a doctor arrives in the mailbox, appears in the unfiled queue within 10 minutes, files to the correct case in one click, and satisfies that case's follow-up — and the 90-day dual-running clock has started.

### Phase 3 — Letters, the GDC referral, the printable case file

*4 weeks part-time*

**Goal.** Replace the officer's Word documents, and make the longest-latency leg of a case visible.

**Deliverables**

- `render-svc` (Gotenberg 8) with the letterhead in RENDERED and PREPRINTED modes and Kannada fonts baked in
- Template editor: textarea + merge-field picker + Preview PDF; `merge_context` snapshotted per letter; two-phase render
- The full GDC referral flow: draft → approve → print → signed scan (a separate document, and the record copy) → mark despatched → report received; the `share_decision` gate wired to a recorded committee decision
- Manual despatch-number capture with the partial unique index and the `AWAIT_DESPATCH_ENTRY` follow-up queue
- Physical custody tracking; misfiled-document path; case-file PDF export with cover, index and the audit head hash

**Done when.** One real GDCRI referral goes out end to end — generated, signed by the Registrar with the rubber seal, scanned back, despatch number entered — and the register shows all three dates without anyone typing them twice.

### Phase 4 — Committee sittings and member access

*4 weeks part-time*

**Goal.** Stop the officer photocopying case sheets, and get decisions into the register the day they are made.

**Deliverables**

- `sitting`, `agenda_item`, `sitting_attendance`, `recusal`, `deliberation_comment`, `case_decision`, `case_outcome`, `minutes`
- `v_agenda_candidate` ripeness view (built on `respondent_notice`, showing blockers for non-ripe cases) and the agenda builder
- The pre-sitting phone-call checklist, generated at agenda publication, ticking into `contact_event`
- Per-sitting case bundle PDF for members; OTP magic-link read-only mobile-web case sheet with `document_access_log` and masked complainant contact details
- Attendance roll, decision capture, per-respondent outcomes, minutes composer, decision letters unlocked per case
- Member usage instrumentation and the recorded go/no-go on building the native app

**Done when.** A full sitting runs inside the software from agenda to despatched decision letters, no member receives a photocopy, and the register's Heard-on and Outcome columns populate themselves.

### Phase 5 — Ethics notices, RTI, registry, and retiring the book

*4 weeks part-time*

**Goal.** Complete the officer's actual job description, then make the software the system of record — safely and on the record.

**Deliverables**

- Ethics-notice intake form and `KSDC/ETH/…` series; `REPLY_TO_REFERRING_AUTHORITY` and the `external_due_at` follow-up
- RTI module: list with days-remaining chips, scan-in, scan-out, link to cases, statutory follow-up ladder
- Dentist registry: .xlsx import (map columns → preview diff → commit as a batch), upsert-never-delete, absent rows marked `lapsed`; respondent history and active-suspension banner light up
- Suspension tracking with the `btree_gist` no-overlap constraint and restoration reminders at T−14 and T−0
- `docs/retention-schedule.md` signed by the Registrar; the one-page AI disclosure note prepared
- The gated, audited **'Retire the physical register'** action

**Done when.** All four retirement conditions are satisfied — 90 days dual-run, 90 verified exports, a restore drill executed by the officer, four clean reconciliations — and the officer takes the retirement action.

### Phase 6 — Conditional: AI, native app, voting

*Open-ended, 2–4 weeks per item*

**Goal.** Build only what the first five phases have proved is wanted. Each item has its own gate; none is automatic.

**Deliverables**

- **AI assist** — gate: the signed disclosure note. Then intake extraction, narrative slot drafting, case-sheet background, with `app_ai` grants, quote verification, `ai_run` audit and the verbatim-class loader
- **Native Expo app** — gate: two or more members actively using the magic-link case sheet across three consecutive sittings. Then push, offline bundles, watermarked streaming
- **In-app voting and chair confirmation** — gate: the council's rules of procedure actually requiring a recorded division. Then `vote` rows with supersession, tallies and casting votes
- **SMTP send** — gate: the mail host supporting authenticated submission and the officer wanting it. Still behind a human click

**Done when.** Each gate is either passed and the item shipped, or failed and the item formally closed in `docs/adr/` with the evidence — so nobody rebuilds the argument in six months.

---

## Risks and mitigations

**Phase 1 slips and the officer starts entering real cases into a half-built system before the dual-running discipline exists — the classic way a register migration destroys evidence.**

> `council.production_authorised_at` blocks non-synthetic case creation until the four authorisation artefacts exist, and the reconciliation banner appears the moment the first real case is created, not at some later 'go-live'. Demo and build against the synthetic council.

**The officer stops logging inbound replies (which is the whole premise of the project — they forget things), so follow-ups escalate against parties who did respond.**

> Notice counts never move on a timer; escalation pushes say 'no reply logged — check the mailbox', not 'did not respond'; notices 2 and 3 require an interstitial showing the correspondence log and an explicit confirmation. Phase 2's read-only mailbox reader closes the gap structurally and is scheduled early for exactly this reason.

**The mail host turns out to offer POP3 only, rewrite Message-IDs on delivery, or refuse app passwords — invalidating Phase 2's design after it is scheduled.**

> The MX check and the host call are Phase 0 deliverables with a written ADR. Preferred fallback is a forwarding rule into a council-owned Workspace mailbox (easier to approve, cannot lock anyone out, fully controlled). If Message-IDs are rewritten, the raw-source sha256 becomes the primary dedupe key rather than the fallback.

**Committee members never open the magic-link case sheet, so Phase 4's member half is dead weight and the officer keeps photocopying.**

> Phase 4 ships the bundle PDF first — it replaces the photocopier regardless of member behaviour — and the link is instrumented. Two-or-more active members across three sittings is the recorded gate for any further member investment; failing it costs nothing already spent.

**Procurement rejects cloud spend entirely, or the council cannot open a GCP billing account under its own PAN/GST.**

> Phase 0 hands the Registrar a one-page cost sheet and starts the billing conversation before Terraform exists. Everything is one Indian vendor, one invoice; the austerity variant (min-instances 0, smaller tier) halves the bill; and the nightly register export means the register survives a project that has to move hosts.

**The three-notice → ex parte rule turns out to be wrong, or to require registered post with acknowledgement due, and an order is set aside on challenge.**

> It is a warning with a typed-reason override, never a guard; `respondent_notice.service_mode` and `service_proof_document_id` capture the RPAD card; and the question is on the Registrar's list. Proof of service, not notice count, is what the record will rest on.

**Solo-maintainer bus factor: one person holds every account, every runbook and every alert channel, and is also the only user.**

> Second GitHub org owner and a sealed break-glass envelope with the Registrar; a named second recipient on the three alerts that matter; `docs/runbooks/handover.md` written for a competent stranger; alert routing re-verified at every quarterly restore drill; and the nightly export as the artefact any competent person can rebuild from.

**Scope creep during the build — the seven dimension documents are seductive and each cut item has a good argument behind it.**

> `docs/v1-scope.md` names every cut item and its phase, and `packages/db/schema/` is CODEOWNERS-protected so a new table cannot appear without a deliberate decision. The archived dimension documents are explicitly not a schema source.

**Members browsing all complaints (the user's explicit requirement) widens DPDP exposure — three external dentists can reach every patient's documents, not just the cases they are hearing.**

> Complainant contact details masked; no download and no offline caching in the web case sheet; every view logged with a visible banner; access ends at case closure and at term end; a versioned confidentiality undertaking accepted at first login. A `member_sees_all_cases` setting exists, defaulted to true per the requirement, so it can be narrowed after a word with the Registrar.

**Cross-border AI processing of patient health data becomes a problem after the fact, once the council has a data policy.**

> AI ships disabled with no API key provisioned, every form works manually, and the switch is one config value. Turning it on requires the Registrar's signature on a note that states plainly what leaves India — so the decision is made deliberately, by the right person, before any data moves.

---

## Open questions

These need the officer, the Registrar, or a phone call to a third party. Each names what it blocks.

- **Mail host (blocks Phase 2 planning).** Does ksdc.in offer IMAP over TLS with an issuable app password — or, easier to approve, can the council's IT set a forwarding rule from registrar@ksdc.in's 'Complaints' folder into a new council-owned mailbox we control? One call to the hosting provider settles a two-day task versus a redesign.
- **Domain and billing (blocks Phase 0 sign-off).** Can the council issue `complaints.ksdc.in` and `api.complaints.ksdc.in` with DNS records, and can it open a Google Cloud billing account under its own PAN/GST? If subdomains are impossible we register a separate domain in the council's name; if cloud spend is impossible we need to know before Terraform exists.
- **Register serials for the ten backlog cases.** We recommend seeding `register_sl_no` from the physical book and starting new cases after the highest, so the software's numbers match the book's forever. The alternative — starting at 1 with a cross-reference column — leaves two numbering systems in circulation. Please confirm.
- **The ex parte rule.** Is 'three notices, then proceed ex parte' written anywhere — the Dentists Act, DCI/NDC regulations, or the council's rules of procedure — and must the third notice go by registered post with acknowledgement due? We have built it as a warning with an override, but the seed value and the service requirement should match reality.
- **What does the Registrar actually wet-sign?** We have seeded `requires_registrar_signature = true` for the GDCRI referral only. Do cease-and-desist notices, suspension orders and RTI reply covers also go out under his signature? This is seed data, not code — but each one adds a print-and-scan loop.
- **Committee procedure (needed before Phase 4 hardens anything).** Must the President personally preside for a decision to be valid, or may the members present elect a presiding member? Is the majority required a majority of those present or of the full committee of four? And does the committee record a formal division, or simply a consensus the officer minutes?
- **Retention.** Does the Dentists Act or any Karnataka council rule prescribe a record-retention period for ethics-committee proceedings? Our default is permanent retention of case records with 8-year backups, pending a signed one-page schedule from the Registrar — a one-line config change, but a wrong answer is a compliance problem.
- **Cross-border AI processing (gates Phase 6 only).** There is no India-resident inference option today. The choice is: enable AI assist with a cross-border disclosure in the DPDP notice and in the acknowledgement email, or leave `ai_enabled = false` and run a fully manual — still very useful — system. We need an explicit yes from the Registrar before any AI feature is built, not after.
