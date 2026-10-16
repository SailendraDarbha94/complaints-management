# ADR-0003: The website is the officer's; members and auditors use the phone app

**Status:** accepted, implemented
**Date:** 2026-10-16

## Who uses what

| Who | Where | What they may do |
| --- | --- | --- |
| The dental officer (`officer`) | The website, and the phone app | Everything: the tray, Today, cases, letters, RTI, the register and its export, and filing documents from the phone. |
| Committee members (`committee_member`) | The KSDC phone app only | Read cases. |
| Auditors (`auditor`) | The KSDC phone app only | Read cases. |

The roles are in `packages/contracts/src/enums.ts` (`ROLES`); what each was meant to be is
in the build plan's "Roles (v1)".

## What a member reads, and where

The phone app reads Supabase directly, under row-level security and the grants in
`packages/db/migrations/0010_mobile_read_grants.sql`: the case, the parties' names and
ages, the respondents and their notice counts, the milestones and the documents. It is
deliberately what the photocopied case file held, and no more. It does NOT include the
officer's follow-ups (the chase list), correspondence (letters and unsent drafts),
contact events and the officer's notes, or the case's state history. 0010 explains each.

The phone calls the website's API for one thing only: the officer's own capture flow
(`/v1/cases/[id]/documents/upload-url` and `.../documents/commit`), which the app shows
only to an officer (`apps/mobile/src/app/case/[id]/add.tsx`).

## Why the website refuses them

The website was built for the officer, and its pages and routes show what 0010 leaves out -
the complainant's phone number and email, the chase list, every letter - and change the
register as a database role that may write anything. Before this decision, a route only
checked that the caller was signed in to the council, so a committee member signed in on
the website could read all of it and post letters as sent, follow-ups done, notices moved
and RTI decisions.

## The rule

- **Every new API route is officer-only by default.** `withAuth()` and
  `withAuthNoTransaction()` in `apps/web/lib/route.ts` refuse every role but `officer` with
  a 403 - "Only the Council's dental officer can use this. Committee members read cases in
  the KSDC phone app." - before the handler runs. A cross-council request still answers
  404, as before.
- A route opens itself to other roles only with `{ roles: [...] }`, and only for what a
  member needs on the website at all. Today that is `GET /v1/auth/me` (who is signed in)
  and `POST /v1/auth/council` (switching council). Signing in, refreshing and signing out
  need no session and are public.
- `apps/web/lib/routes.test.ts` lists every such route with its reason. A route that opens
  itself without a line there fails the build; `apps/web/lib/officer-only.test.ts` calls
  every officer-only route as a member, an auditor and the officer.
- **Every page** calls `officerOnly()` (`apps/web/app/components/officer-only.tsx`) before
  it fetches anything. A member or an auditor sees one page: who they are signed in as,
  "This website is for the Council's dental officer. Committee members read cases in the
  KSDC phone app.", and Sign out. `apps/web/lib/website-access.test.ts` fails any page that
  does not ask first. `/signin` is open to everyone.

Giving members more on the website - recusals or comments, which the build plan allows
them - is a new decision: add the routes and pages it needs, open them by name, and say
why in the allow-list.
