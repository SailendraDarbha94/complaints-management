# RTI: what the register has to comply with

Researched 2026-09-11 against the bare Act, the Karnataka Rules, DoPT guidance and CIC/KIC
decisions, then independently re-checked. Section numbers and sources are in the workflow
transcript.

**This is not legal advice.** It is an attempt to establish what the statute says so the
software can be built to the right deadlines and the right procedure. Where something is
genuinely unsettled it says so, and those points want the Registrar's view rather than a
default chosen by whoever wrote the code.

---

## Four findings that change the design

### 1. Section 8(1)(j) was rewritten, and the new version is in force

The DPDP Act 2023 substituted the whole clause, and it commenced on **13 November 2025**
(G.S.R. 843(E)). It is live now.

**Before:**
> information which relates to personal information the disclosure of which has no
> relationship to any public activity or interest, or which would cause unwarranted
> invasion of the privacy of the individual **unless** the officer is satisfied that the
> larger public interest justifies the disclosure…

**Now, in its entirety:**
> information which relates to personal information

Three tests are gone: the public-activity test, the unwarranted-invasion test, and the
internal public-interest override. For a register whose files are a patient's health
complaint and a named dentist's conduct, that is close to the whole ball game — most of
what an applicant asks for here *is* personal information, and the clause is now a flat
exemption.

Two cautions. **s.8(2) is untouched** and is now the only public-interest route — the
authority *may* disclose where public interest outweighs the harm, and it is a discretion,
not a duty. And the rest of the DPDP Act's obligations on the council as a data fiduciary
do **not** commence until **14 May 2027**, so this is one clause arriving early, not a new
regime.

### 2. The penalty is paid by a person, not by the council

**₹250 for each day of delay, capped at ₹25,000** — the cap arrives at 100 days. Imposed
only by the Commission, only after a hearing, and **the burden is on the PIO to prove they
acted reasonably and diligently.**

It is **recovered from the officer's salary.** Compensation to the applicant under
s.19(8)(b) is different — that the authority pays.

This is the single strongest argument for building the module properly. The software is not
protecting an institution from an abstract risk; it is protecting a named person from a
deduction they will feel, and the evidence that discharges the burden is exactly what an
audited workflow produces.

### 3. Section 11 is procedure, not an exemption

You can never refuse **under** s.11. Two CIC decisions are explicit: a refusal must rest on
s.8(1) or s.9, and s.11 is the process you follow first.

So in the drafting screen the refusal-ground picker offers **only s.8(1)(a)–(j) and s.9**.
"Refused under s.11" must be impossible to compose, because it is a defective refusal and
an appealable one.

The trigger is also narrower than it looks: s.11 fires when the officer **intends to
disclose** third-party information, not merely because a third party appears in the file.
That intention should be a recorded, timestamped decision — it is the statutory trigger and
it is the thing the council would have to prove.

### 4. The clock has two origins, and they can collide

The 5-day notice and the 40-day outer limit both run from **receipt of the application**.
The third party's 10 days runs from **their receipt of the notice** — a date the council
does not control and cannot know until the acknowledgement card comes back.

So the module needs a hard alarm when the representation window would close within a few
days of the 40-day deadline, or after it. Otherwise the officer discovers on day 38 that a
dentist still has six days to object.

---

## The deadlines, in one place

| What | Days | From |
|---|---|---|
| Ordinary reply | **30** | receipt by the authority (its inward date) |
| Life or liberty | **48 hours** | receipt — but only on demonstrably proven danger, and the officer's reasoned decision on that claim should be recorded |
| Received by an Assistant PIO | **+5** | lengthens the window; does not pause it |
| Transfer to another authority | **5** | receipt — late transfer keeps the transferring officer's personal exposure for the overshoot |
| Reply by the receiving authority | **30** | its own receipt (DoPT guidance, not statutory text) |
| Third-party notice | **5** | receipt of the application |
| Third party's representation | **10** | **their receipt of the notice** |
| Decision where s.11 applies | **40** | receipt of the application — replaces the 30, a net gain of ten days only |
| Applicant's first appeal | **30** | expiry, or receipt of the decision — condonable, so a file must stay re-openable |
| First Appellate Authority | **30 from receipt, 45 from filing** | two anchors, both must be held |
| Third party's appeal against disclosure | **30 from the date of the order** | **and disclosure must be held until it is decided** |

**Deemed refusal** on missing the reply period, and then s.7(6) makes the information
**free** — no per-page charge at all. A fee demand sent after the period has expired is void
and is itself a ground of complaint.

The only true stop-the-clock is the fee: the period between despatching the intimation and
the applicant paying is **excluded**. Both dates have to be recorded or the deadline cannot
be computed.

**A second appeal to the Karnataka Information Commission takes about 1 year 9 months** in
practice — 47,825 pending as at June 2025. Do not build a 45-day expectation into anything
the officer sees. A file can sit open for years while the officer who handled it moves on,
which is an argument for the audit trail carrying the reasoning, not just the dates.

---

## Settled: the council is covered

KSDC is constituted under **s.21 of the Dentists Act, 1948** — created *by* a statute, not
merely registered under one, which is the distinction the Supreme Court drew in
*Thalappalam* (2013). The Dental Council of India itself complies, with a designated CPIO,
a First Appellate Authority and a full s.4(1)(b) handbook. Karnataka's s.24 exemption
notification covers three police bodies and nothing else.

DCI's own list of State Dental Councils gives KSDC's registrar address as
`registrar@ksdc.in` — the same inbox the complaints arrive in.

---

## Genuinely unsettled — these want the Registrar, not a default

**Which commission hears a second appeal against KSDC.** Turns on which government
constituted, owns, controls or substantially finances the council. It decides which fee
schedule and which portal apply, so it is worth knowing rather than discovering.

**Whether an application without the fee is a valid application.** Directly contradictory
authority: DoPT says an application without the ₹10 is not a valid application; other
decisions treat the clock as running anyway. The safe build treats the clock as running.

**Whether an emailed application must be accepted.** s.6(1) expressly allows a request
"through electronic means", but Karnataka has prescribed no electronic fee route. Given
that complaints already arrive at `registrar@ksdc.in`, an RTI application will too, and the
software should assume it is valid.

**Whether the s.8(1) proviso survived** the substitution of clause (j) — the one saying
information that cannot be denied to a legislature cannot be denied to any person.

---

## What this means for the build

Not a filing cabinet. A second case type through the machinery that already exists —
intake, a clock, an escalation ladder, letters, documents, an audit trail — with three
things the complaints side does not need:

1. **A branching state machine** with an explicit "I intend to disclose" step
2. **Two clock origins**, and an alarm when they collide
3. **A refusal composer that cannot produce an unlawful refusal** — the grounds picker
   limited to s.8(1) and s.9, and the reply carrying reasons, the section relied on, the
   appeal route and the appellate authority's particulars, because a refusal missing any of
   those is appealable on its face

The register already owns `rti_no` as a number series, `rti_reply_cover` as a
correspondence kind, and an "RTI refs." column waiting for a table.
