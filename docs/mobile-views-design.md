## The pick

**Design C is the spine.** Not because it is the prettiest — B's Brief reads better — but because it is the only one of the three whose shape survives contact with the situation described. Five surfaces, no writes, server-rendered page images, no push, no archive. Every cut it makes buys something the other two spend on machinery the member never sees.

A is the richest and it is the wrong shape: ten surfaces, an encrypted bundle with its own key lifecycle, a Notice-history screen, a Chronology screen, an Earlier-sittings screen, a Other-open-cases screen. Each is defensible alone. Together they are an app a dentist has to *learn*, and the reader has ten minutes and is standing up. B is C with three extra stack entries (Respondent, Papers, History) that exist because B refused to put anything long on one scroll — but the thing being read is 2–4 cases, not a caseload, and the scroll is the right container.

**Grafted in from A:**
- The **ask sentence is written by the officer**, not generated. C generates it and C's own `hardestCall` admits this is the weakest part of it: a templated string at the head of a quasi-judicial file frames the case before the member reads a word. A is right. It becomes a mandatory field on `agenda_item` at publish time, ~90 seconds per sitting for the officer.
- The **notice ladder with proof of service**, because when the ask is "proceed ex parte?" — which it will be, often, given `noticesBeforeExParte: 3` in `packages/config/src/ksdc.seed.ts` — the evidence for that decision is the acknowledgement card, not the notice count. C omitted it entirely. But it goes *inline in the case scroll*, not on A's separate screen.
- **Honest retention, stated in the UI**, not buried.
- **Date-source footnotes** (`from_physical_register`, `estimated_by_officer` in `packages/contracts/src/enums.ts` are mandatory on every milestone precisely so a reconstructed date never reads as recorded fact; the phone must not flatten that).

**Grafted in from B:**
- The **sticky docket bar**. This is B's single best idea and it is the one that answers the constraint nobody else took seriously: the reader is interrupted. Coming back at the expert report having lost the thread is the actual failure mode, and a 44pt bar carrying the question fixes it for almost nothing.
- **Gap markers** in the chronology (`· 41 days ·`), because the questions a committee asks are usually about the silences.

**Rejected from both:** A's offline bundle as a separate encrypted store with its own key release; A's "This dentist before" (prejudicial, and if it matters it belongs in the officer's covering note); A's push notifications; B's Respondent / Papers / History screens; A's and B's "Other open cases" browser.

---

## The one rule

Every screen is judged by one sentence: **a member must be able to tell, in three seconds, what they are being asked to decide.** Where an element competes with that sentence for the top of the screen, the element loses.

---

# The surfaces, in display order

Seven things. Five are stack entries, two are sheets. `expo-router` `Stack` with `headerShown: false` throughout — the existing `apps/mobile/src/app/_layout.tsx` already argues this correctly and I am not overruling it: a tab bar here is three empty rooms around the one thing.

---

## 1. Sign in — `/sign-in`, stack entry

Already half-built at `apps/mobile/src/app/sign-in.tsx`. Unchanged in spirit.

| Element | Why |
|---|---|
| `KARNATAKA STATE DENTAL COUNCIL`, 11pt letterspaced grey | Orientation for a member who has four council-ish apps. |
| **Committee file**, 24pt | The name the member uses. Not "complaints management" — that is the officer's product. |
| One email field, autofocused, `keyboardType="email-address"`, `autoComplete="email"` | Passwordless OTP is already the auth model (build plan §, `app_user` + `council_membership`). |
| `Send me a code` → the same screen swaps in place to a 6-digit field | Not a second route. A route transition for step two of two is a wasted 300ms and a back-button question. |
| Errors as a red 13pt line under the field, never an `Alert` | A modal for a mistyped digit is an interruption inside an interruption. |
| `Only the three committee members and the Council office can sign in.` | Sets the expectation that a wrong email will simply fail. |

**Not-appointed state** — keep the existing copy verbatim, it is already right: *"This account is not an active member of any council in the register. Ask the Registrar — signing in is not the same as being appointed."* Signing in is not the same as being appointed, and the app should say so rather than show an empty list.

On success: `router.replace('/')` — back never returns here.

**Cut:** passwords, sign-up, forgot-password, social login, "remember me", a council picker (requirement 38's multi-council picker is a *token re-mint* concern and there is one council; the picker appears the day there are two), biometric enrolment UI (the OS owns that).

---

## 2. Undertaking — `/undertaking`, stack entry, once per version

Listed as a screen rather than hidden, because counting one-time screens as free is how cut-lists become dishonest. A member sees this once in a three-year term.

Build-plan line 680 already commits to *"a versioned confidentiality undertaking accepted at first login"* as part of the answer to members browsing all complaints. This is that.

- **Before you read a file**, 22pt.
- Five lines, 17pt, one idea each: confidential to the Council · a patient's health information · a named dentist's professional standing turns on them · **do not photograph, forward, or discuss them outside the sitting** (medium weight — it is the one obligation the software cannot enforce, so it is the one the software says out loud) · every document you open is logged with your name and the time.
- `Undertaking v1 · September 2026`, 11pt grey.
- **I agree**, full width, disabled until the text scrolls to its end.

The scroll gate is the only gating of its kind in the app, justified because this is the one screen whose *purpose* is that it was read. There is no Decline button; declining is closing the app, which is the truthful option. Agreement writes one row (member, version, timestamp) and the screen never returns unless the text version changes.

**Cut:** signature pad, checkbox grid, a PDF of the DPDP policy (there isn't one — requirement 8), "email me a copy".

---

## 3. The lock — not a screen

`expo-local-authentication` sheet over a blurred app, on cold launch and on resume after 5 minutes background. It is a system sheet, not a route, so there is nothing to design and nothing to skin.

Two RN details that matter: register an `AppState` listener and set a full-screen blur/overlay **on `'inactive'`, not `'background'`** — iOS takes the app-switcher snapshot during `inactive`, and doing it on `background` is too late; the snapshot shows a patient's name. On Android, `FLAG_SECURE` handles the recents thumbnail and screenshots in one line (`expo-screen-capture`'s `preventScreenCaptureAsync`), set while any case content is mounted.

---

## 4. Sitting — `/index`, stack root, `FlatList`

The home screen, and the empty state most of the year. Ten months out of twelve there is no sitting, and that state has to read as *correct*, not broken.

**RN:** `FlatList` over `ScrollView` — not for virtualization (n = 2–4), but for the free `RefreshControl` and because these are homogeneous rows. `ListHeaderComponent` = council mark + sitting line + status line. `ListFooterComponent` = confidentiality line + sign-out. `SafeAreaView edges={['top','left','right']}`; bottom inset goes into `contentContainerStyle.paddingBottom = insets.bottom + 24`, **not** onto the view — put it on the view and the last card cannot scroll clear of the home indicator and the scroll indicator gets clipped.

Top to bottom:

**1. Slim header: `KSDC · Committee`.** Nothing on the right. No gear, no bell, no avatar — each would be a promise of a screen that does not exist.

**2. The sitting line.** `Sitting — Thursday 24 September, 11:00 a.m.` at 20pt; `Council office, Bengaluru` at 14pt grey. When no date is fixed: `Next sitting — date not yet fixed`. The venue line is tappable → device maps. That is the one action in the app that leaves the app, kept from A, because it is genuinely used in a car.

**3. One 12pt grey status line, exactly one of four strings:**
- `Updated 9:41 a.m. · files ready`
- `Getting files (4 of 22)`
- `Offline — showing this file as of yesterday, 6:10 p.m.`
- `Item 2 — expert report not downloaded. Tap to fetch.` (amber)

*Why one line:* this is A's readiness strip and "what changed" line and B's download state, collapsed. A member needs to know the files are on the phone before they drive; they do not need a downloads manager.

**4. The 2–4 case cards, in agenda order.** The officer's order — the order the room will take them. Never newest-first, never most-urgent-first, because "we're on the second one" has to map to something.

Each card, top to bottom:
- A 4pt unread dot at the left edge, local to the device, never synced. *Why local:* a synced read-receipt turns three honorary peers into each other's supervisors. That is a different product.
- **THE QUESTION**, 20pt semibold, up to three lines, `numberOfLines={0}` — **never truncated.** This is the entire card. Everything else on the screen is set smaller and grey so the eye lands here.
- The grievance one-liner, 15pt, clamped to 2 lines.
- `Smt. R. Lakshmi against Dr. K. N. Prasad`, 14pt grey — becoming `…and one other` at two or more respondents (`case_respondent` is genuinely multi-row, requirement 18). A single amber dot if any respondent is `awaiting_reply` past the ladder.
- `KSDC/COMP/2026-27/0042 · Received 14 March 2026`, 12pt grey, and an item numeral at the right edge.

Three cards should fill a phone with **three questions and almost nothing else.** That is the preparation brief, readable standing up, in about four seconds.

**5. Empty state:** `No files yet. The office puts the sitting's case files here a few days beforehand.` and under it `Last sitting: 30 July 2026.`

**6. Footer:** `Confidential to the Council. Every document you open is logged.` then `Signed in as Dr. S. Rao · Sign out`.

**On tap:** card → push `/case/[id]`. Pull-to-refresh. Sign out → one confirm, then delete every cached file and page image on the device. No swipe actions, no long-press, no header buttons, no multi-select.

**Deliberately off this screen:** search, filter, sort, tabs (2–4 items — a search box on four items is an admission the list was designed wrong) · state names (`ready_for_committee`), `waiting_on`, days-quiet, on-hold counts, follow-up badges — the officer's vocabulary, and every one is a number that can be wrong on a phone · a calendar or RSVP (requirement 28 puts scheduling on WhatsApp, explicitly) · closed cases and past sittings · anything that creates something.

---

## 5. Case — `/case/[id]`, stack push, one `ScrollView`

The photocopied bundle, better ordered. One scroll, no tabs, no accordions.

**RN, the part worth getting right:** the docket bar is **not** `stickyHeaderIndices`. Two reasons: a sticky child cannot paint under the status bar with its own background, and it would push the ask down 44pt permanently — costing the three-second test the top of the screen it depends on. Instead: the `ScrollView` runs edge-to-edge with `contentContainerStyle.paddingTop = insets.top + 12`, and an `Animated.View` docket is absolutely positioned above it, `height: insets.top + 44`, opacity driven by a Reanimated `useAnimatedScrollHandler` (Reanimated 4.5 is already a dependency — this runs on the UI thread and does not jank the scroll). It fades in past ~80pt of scroll: back chevron, case number, the question truncated to one line.

*Why it exists at all:* you are interrupted by a patient, come back forty minutes later at the expert report, and have lost the thread. Scroll position is persisted per case and restored across cold launch.

`ScrollView` over `FlatList`/`SectionList`: heterogeneous sections, ~25–40 children, scroll restoration is one line instead of `getItemLayout` arithmetic over variable heights.

Top to bottom:

**1. On-hold band, conditional.** `On hold since 3 July — matter before the City Civil Court.` Above everything, because `on_hold` is a boolean with a reason in this schema, not a state, and a listed case that is on hold changes what the sitting can do at all.

**2. THE QUESTION** — 24pt, up to three lines, 3pt accent rule down the left edge. Officer-authored, mandatory at agenda publish, ends in a question mark. *"Dr. Prasad has answered the notice. Did his treatment of a 7-year-old amount to professional misconduct?"* If the field is somehow empty, the band says so in plain words — `The office has not recorded what this sitting is to decide` — rather than the app guessing from `case_state`.

**3. WHAT IT IS ABOUT** — 12pt uppercase grey label, then the officer's grievance summary at 17pt, two to five sentences, **not truncated**. The shortest honest account of why a patient came to the Council.

**4. WHO** — complainant, name only. Patient on its own line *only when different*, with age, sex and relationship: `Patient — Master A. Kiran, 7, male (her son)`. A parent complaining for a child changes how you read the whole file, so the relationship is in words, not an enum label.

Then one block per respondent: `Dr. K. N. Prasad · Reg. 12345`, and beneath it that respondent's own position as a **sentence, not a badge** — `Replied on 2 August` / `No reply after three notices, the last on 14 July` / `Declared ex parte on 20 August` / `Dropped — not the treating dentist`. Two respondents get numbered blocks with a hairline between, because their outcomes are independent (requirement 18).

**5. THE NOTICES — inline, only when a respondent is `awaiting_reply` or `ex_parte`.** Grafted from A, demoted from a screen. One line per notice:

> `Notice 1 · 14 Apr · registered post with A/D · acknowledgement card on file` → tappable
> `Notice 3 · 14 Jul · speed post · no proof of service on file`
> `The Council's practice is three notices before ex parte. Three were despatched; proof of service is on file for two.`

*Why inline:* when the ask is "proceed ex parte?", this **is** the decision material, and a member should not have to discover a second screen to find it. Proof of service is set at the same weight as the date — the count is what gets quoted in the room, the proof is what an ex parte finding survives on when challenged, and `SERVICE_MODES` in the contracts file says so in a comment already. The app presents the evidence and the Council's own threshold from config; it does not present a computed verdict.

**6. WHAT THE DENTIST SAYS** — one full-width tappable strip per respondent explanation: title, `3 pages`, `received 2 August`, chevron. When there is none: `No written explanation on file.` in grey — that absence is itself a finding and must not be a blank space.

**7. THE EXPERT'S OPINION** — same strip, when one exists. `Govt. Dental College & Research Institute · 5 pages · 20 August`.

Neither of these is summarised, on the phone or anywhere. `NEVER_SUMMARISE` in `packages/contracts/src/enums.ts` lists `expert_report`, `respondent_explanation`, `committee_record`, enforced by a throwing context loader. B called this its hardest call and worried the brief has a hole where its most important content should be. It does. That hole is correct: the difference between "the expert found the extraction unjustified" and what six pages of qualified clinical language actually say is the whole case.

**8. THE PAPERS** — the rest, flat. Title at 16pt, then `Bill · 2 pages · 3 February` at 12pt grey. Grouped by `document_class` in a fixed order of decision-weight, with thin dividers only past ~8 documents. Radiographs marked as such in words so the member knows to expect an image. **Filenames never shown** — `IMG_20260302_114233.jpg` tells a reader nothing and looks like a bug.

**9. HOW IT GOT HERE** — the chronology, last, and deliberately the quietest thing on the screen. Fixed-width date column, event in plain words from the v1 milestone vocabulary. Respondent-scoped milestones name the dentist. A dagger on any date whose `date_source` is not `recorded`, footnoted once. Gap markers where the interval exceeds ~60 days: `· 4 months ·`.

*Why last and grey:* the chronology is reference, consulted in the room, not read in the car park. Putting a timeline at the top is the commonest way a case file fails the three-second test.

**10. Two quiet text rows, then the footer.** `Questions for the sitting (3)` · `Recuse myself` · `Confidential to the Council. Every document you open is logged, with your name and the time.`

**On tap:** any document strip → the page viewer. `Recuse myself` → sheet. Questions → sheet. Back → Sitting at its remembered position. Long-press does nothing. **Text is not selectable anywhere in the app** — selection is the cheapest extraction path and there is no legitimate reason to lift text out of a patient's complaint.

**Deliberately off this screen:** every party's mobile, email and address — *absent, not masked behind a reveal*. The member never rings anyone; the officer does, and requirement 17 gives the officer a call checklist for exactly that. One well-meaning pre-hearing phone call can wreck a proceeding. · State badges, `waiting_on`, days-quiet, follow-ups. · Correspondence bodies — the member reads what the dentist wrote, not what the office wrote. · The officer's internal remarks — the officer's private reading is prejudicial to someone who has to hear the case. · Prior complaints against this dentist. · The outcome field — nothing has been decided, and an empty Outcome row invites someone to fill it in. · Any colour on case content. No red next to a named dentist's name; colour is reserved for system status (offline, downloading, on hold).

---

## 6. Pages — `/case/[id]/doc/[docId]`, `presentation: 'fullScreenModal'`, `gestureEnabled: false`

Where the substance actually is. A dentist's explanation and a GDCRI report are **scanned paper**, which is the honest reason this app cannot be two screens.

**Server-rendered page images, one per page, no PDF engine on the client.** Three things fall out of that, and this is the single highest-leverage technical decision in the design:
1. The watermark — member's name, case number, date, diagonal, low contrast — is **burned server-side at signing time**, so it cannot be lost to a client bug and cannot be stripped by a determined reader.
2. One code path for scans, phone photos, WhatsApp images, OPG JPEGs and PDFs (requirement 33 lists all of them).
3. No `react-native-pdf`, no native module, no custom dev client.

- Black ground, edge to edge, `edges={[]}`, close button at `insets.top + 8`.
- Horizontal `FlatList`, `pagingEnabled`, `windowSize={3}`, `getItemLayout` with a fixed page width of `Dimensions.get('window').width` — fixed layout means jumping to page N is exact and instant.
- Each page: `expo-image` (already a dependency) inside a pinch/pan wrapper built on `react-native-gesture-handler` + Reanimated — both already dependencies. Do **not** use `ScrollView`'s `maximumZoomScale`; it is iOS-only and Android would silently lose zoom.
- Top overlay fades out after 3s: title, `2 of 5`, an X. Nothing at the bottom.
- Swipe-down-to-dismiss is **disabled** — it fights a vertical pan on a zoomed page, and closing a confidential file should be deliberate.

Opening a page writes one `document_access_log` row. Offline opens queue and flush on reconnect.

**Cut:** the share sheet (the single most likely way a patient's radiograph leaves the Council's control, and it is one line of code *not* to have) · save-to-photos, print, open-in, copy · annotation and highlighting (a member's marginal mark is a record whose discoverability under RTI nobody has decided — requirement 36 makes RTI a live concern here, not a hypothetical) · **invert/contrast tools for radiographs**. A dentist will want them, and that is precisely the reason to withhold them: a member is not diagnosing from a phone, the expert report is the clinical opinion on the record, and a re-rendered radiograph that changes someone's view is a clinical hazard dressed as a comfort feature. · page thumbnails, OCR, search-in-document, brightness slider.

---

## 7. The two sheets

**Questions** — `presentation: 'formSheet'`, half height, keyboard up on open. Existing lines as plain rows, one multiline input, Done. Footer: `These stay on this phone. They are not sent to the Council and are not part of the case record.` Swipe a line to delete. **Nothing syncs** — so this is not a server write and buys no sync engine. It is the biro in the margin of the photocopy, kept. Deleted with everything else on sign-out or expiry.

*Cut from it:* sharing with the other members or the chair — half-formed questions circulated in advance start caucusing before a quasi-judicial hearing, and the moment a member's private musing is discoverable under RTI, members stop writing them.

**Recuse** — `Recuse yourself from KSDC/COMP/2026-27/0042?`, two lines of consequence (`The office will be told. You will not be able to open the documents in this case.`), optional one-line reason, confirm not styled as destructive. Emphasis on the consequence lines, not the button.

**This is the app's only write**, and it is deliberate. Build plan §8 already names recusal and comments as the only member writes; requirement 26 names recusal as a member power; and in a profession this small, recognition happens in the first three seconds of reading the respondent's name — a member who has to remember to ring the officer on Monday will not. It needs connectivity and is allowed to **fail loudly** rather than queue, which is what keeps the zero-sync-engine property intact. Undoing a recusal is a phone call to the officer.

On confirm: the card on Sitting collapses to `You have recused — 24 September`, documents lock, local copies for that case are wiped on the spot.

---

## The machinery with no screen

**Prefetch.** When a case appears on the member's list, the app fetches its JSON and every page image in the background, into `FileSystem.documentDirectory` (**not** `cacheDirectory` — the OS can evict a cache directory, and it will do it the night before the sitting), marked excluded from iCloud backup. On Wi-Fi: everything. On cellular: the expert report and every respondent explanation first, then page 1 of every other document, then the rest. Roughly 25 pages per case at 300–500KB is ~30MB for a full sitting.

Files delete when the case leaves the list, on term end, on sign-out, on recusal. The retention line is displayed, not buried: `Papers for the sitting of 24 September stay on this phone until 1 October.`

**The entire UI for all of this is one word in the status line.** No toggle, no downloads manager, no "offline mode" — a toggle makes the member responsible for a decision they will get wrong exactly once, in a car park, with no signal.

**No push notifications.** A push about a patient complaint puts a case number, and possibly a dentist's name, on a lock screen in a waiting room. The sitting was arranged on WhatsApp (requirement 28), so the member already knows. This is where I overrule A, which specified three carefully-worded pushes: the wording is not the risk, the notification tray is.

---

## What I cut, and what it costs

| Cut | Cost, honestly |
|---|---|
| **"All open cases" browser** (requirement 26, `memberSeesAllCases: true`) | The member cannot idly browse the other seven open files from the car. I read that requirement as an **entitlement, not a screen**: the permission stays true at the API and RLS layer, and the officer can put any case on the list in one click. The gain is that three private phones hold four patients' files instead of ten — the largest confidentiality surface in the whole idea, bought for a use nobody in this situation actually has. If a member asks for it twice, build A's deliberately dull ten-row list. |
| **Past sittings / archive** | "What did we decide last time" goes unanswered on the phone. It is a real question, but it is asked about once a year, it is in the minutes the officer types, and building it means keeping closed cases' documents live on personal phones indefinitely. |
| **In-app voting, decisions, outcomes, attendance** | The officer still types the sheet. Build plan D8 already settled this, and the committee's own procedure is an **open question in this project's docs** — is the majority a majority of those present or of all four? Building a UI for an undecided rule is how a wrong rule gets encoded and then cited. |
| **Shared deliberation comments** | A member cannot flag a point to the others in advance. They have WhatsApp, and four people in a room for two hours will say it out loud. A comment typed into a phone the other three never open is worse than silence, because it looks like it was communicated. |
| **The officer's whole world** — follow-up queue, letter composer, correspondence bodies, register export, upload, days-overdue badges | Nothing. A member cannot chase a dentist, and showing them the chase list invites exactly the phone call that would compromise the hearing. Read-only is not a limitation of this app, it is its definition. |
| **Search, filter, sort, tabs** | Nothing at n = 4. |
| **Separate Respondent / Papers / Chronology / Notice screens** (B and A) | Deeper cases feel slightly denser on one scroll. Worth it: same fact, same place, every case, no navigation to learn. |
| **Screenshot detection on iOS** | A determined leak is unattributed by detection anyway. An "someone screenshotted" event creates an incident-response process nobody at the Council has agreed to run, and an alert nobody acts on is worse than no alert. The **burned watermark is the whole answer on iOS**; `FLAG_SECURE` is genuinely free on Android and is set. |
| **MDM, DRM, jailbreak detection, remote wipe** | Already decided against in `docs/v1-scope.md` under *rejected, not deferred*, and rightly: three volunteer dentists will not enrol personal phones in council device management, and building it means either they do not use the app or someone pretends they did. |
| **Settings screen** | Nothing. Theme follows the system; text size follows the OS accessibility setting (`allowFontScaling` left **on** — the real answer for readers over fifty); files manage themselves; sign-out is a text row at the foot of home. |
| **Onboarding, tooltips, help, FAQ, changelog, skeleton loaders** | Four users, all of whom have the officer's mobile number. Skeletons exist to fill a network wait this app does not have — the data is on disk; render the disk and put a 2pt progress bar under the header while it refreshes. |

---

## React Native specifics, consolidated

- **Stack entries:** `/sign-in`, `/undertaking`, `/` (root), `/case/[id]`, `/case/[id]/doc/[docId]` (`fullScreenModal`, `gestureEnabled: false`). **Sheets:** questions, recuse (`formSheet`).
- **`FlatList`:** Sitting (2–4 rows, for `RefreshControl`), and the page pager (horizontal, `pagingEnabled`, `getItemLayout` on a fixed screen-width page, `windowSize={3}`, `removeClippedSubviews` on Android).
- **`ScrollView`:** the Case screen. No virtualization at ~30 children; scroll restoration is one line.
- **Where safe areas bite:** (1) bottom inset belongs in `contentContainerStyle.paddingBottom`, never on the container view, or the last row will not clear the home indicator; (2) the Case docket must paint under the status bar, which `stickyHeaderIndices` cannot do — hence the absolutely-positioned `Animated.View` with `height: insets.top + 44`; (3) the page viewer takes no insets but its close button sits at `insets.top + 8`; (4) Android translucent status bar — the Sitting header needs `insets.top` padding or the council mark sits under the clock.
- **Small phones** (iPhone SE, 375×667; Android 360dp): below ~700pt of height the ask drops from 24pt to 21pt and section spacing tightens 4pt, so that **the question plus the first two lines of the grievance are always above the fold**. That is the whole point of the screen and it is the one thing that must not reflow off it. The ask gets `maxFontSizeMultiplier: 1.6` — a member at 200% system text still sees where the grievance starts; every other element scales freely.
- **Reanimated on the UI thread** for the docket fade, because a janky header on the one screen people read is worse than no header.
- **No native modules beyond what `apps/mobile/package.json` already has** — `expo-image`, `expo-secure-store`, `gesture-handler`, `reanimated`, plus `expo-local-authentication` and `expo-screen-capture`. Server-rendered pages are what buys that.

---

## Judged against the sentence

Cold launch → biometric sheet → Sitting. Three cards, three questions, 20pt, nothing else competing. Tap → the question again at 24pt with a coloured rule, above the fold on an SE. Interrupted at minute four, back at minute forty → the docket bar is still carrying the question, and the scroll is where it was left.

The design fails the sentence in exactly one place, and I want that on the record: **when the officer does not write the question.** The whole top of both screens is a field a human has to fill in, ninety seconds per sitting, and if it is skipped the member gets `The office has not recorded what this sitting is to decide` — honest, and useless. C's instinct to generate it from `case_state` and the notice ladder is the safety net, and I rejected it because a generated sentence at the head of a quasi-judicial file frames the case before the member reads a word. The mitigation is procedural, not technical: **the agenda cannot be published with the field empty.** That is one `NOT NULL` on `agenda_item` and a disabled Publish button in the officer's web app — and it is the single most load-bearing line of the whole design.

The open question for the Registrar, phrased the way the AI gate was: three honorary dentists' personal phones will hold page images of a named patient's radiographs and a named dentist's written defence, for roughly ten days per sitting, protected by a device passcode and a burned watermark. Build plan line 680 currently commits to *no download and no offline caching* for the member channel. This design deliberately breaks that rule, because the reading happens in a car park and a member who taps a file and gets a spinner goes straight back to the photocopy the app exists to abolish. That trade belongs in a one-page note someone signs, next to the wipe schedule — not in a design document.