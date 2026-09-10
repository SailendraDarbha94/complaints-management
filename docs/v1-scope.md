# v1 scope — the cut list

This file is the answer to every mid-build *"while we're in here…"*. If something is not in
Phase 1's deliverables below, it does not go into Phase 1. Each cut item names the phase it
returns in, so nothing here is lost — only sequenced.

Source: `docs/00-build-plan.md` §14 and the roadmap.

## Phase 1 builds exactly this

- 20 tables, row-level security, `withCouncil()`, the CI isolation test
- `audit.events` — hash chain with `canonical_payload`
- The 8-state case lifecycle, generated `waiting_on`, 17 events, one test per transition row
- `follow_up`: escalation-as-new-row, snooze that never moves `due_on`, the `NO_NEXT_STEP` sweep,
  and the notice-counter severing rule
- The **Today** screen, grouped by who you are chasing
- Daily 09:00 IST digest to the officer's own address; email-OTP login; the "Reminders last ran"
  banner
- Manual case intake; case detail; document upload via signed URLs
- Plain-text templates, the draft composer, and "I have sent this" → starts the clock
- Register CSV export

## Cut from v1 — returns in a named phase

| Cut | Returns |
|---|---|
| Web Push / PWA (Phase 1 uses the in-app queue + one daily digest) | Phase 2 |
| IMAP mailbox reading, the unfiled queue, thread matching | Phase 2 |
| Backfilling the ten open cases; the reconciliation screen | Phase 2 |
| Gotenberg PDFs, letterhead rendering, the printable case file | Phase 3 |
| The GDCRI referral flow, despatch-number capture, physical custody | Phase 3 |
| Committee sittings, agenda, attendance, decisions, minutes, the call checklist | Phase 4 |
| Member access — bundle PDF plus the magic-link case sheet | Phase 4 |
| Ethics-notice intake, RTI, dentist registry import, suspension tracking | Phase 5 |
| AI assist · native Expo app · in-app voting · direct SMTP send | Phase 6, each behind its own gate |

## Decided against — not deferred, rejected

- The software minting outward despatch numbers
- Blockchain / OpenTimestamps anchoring of the audit chain
- CMEK (a key whose accidental disable makes every document unreadable)
- VPC Service Controls, WAF, penetration testing before the first live case
- PgBouncer
- MDM / DRM / jailbreak detection on members' phones
- Automated PII redaction of documents, including on radiographs
- Any autonomous send, to anyone, ever

## Replaced with something simpler — not merely postponed

| Design study proposed | v1 ships |
|---|---|
| 16 case states | 8 states + an `on_hold` boolean |
| 39 transition rows | 17 events |
| 60+ tables | 20 |
| 7 roles / 28 permissions | 3 roles / ~10 permissions |
| 15 configuration tables with CRUD screens | 1 validated JSONB row + a checked-in seed file |
| 4 audit chains | 1 |
| TipTap + hardened-Handlebars template IDE | a textarea, a field picker, a 30-line renderer |
| Per-respondent voting, tallies, casting votes, quorum blocking | one `case_decision` row |
| Native member app with burned watermarks and FLAG_SECURE | a bundle PDF + a logged read-only page |
| Vercel + Cloud Run | Cloud Run only |
| ClamAV + Eventarc + a separate bundle-builder | nothing — see §14 of the build plan |
| DPDP data-request / incident / RoPA modules | a policy pack for the Registrar to sign |
