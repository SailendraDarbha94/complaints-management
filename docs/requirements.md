# Requirements — captured 10 September 2026

Source: a 39-question discovery interview with the Dental Officer, KSDC, plus the one existing
artefact (a scanned GDCRI referral letter, `KSDC/297/2026-27`). Answers are authoritative. Where an
answer changed a default assumption, the change is noted.

## Ownership, mail and users

| # | Question | Answer |
|---|---|---|
| 1 | Sanctioned project or personal tool? | **Sanctioned KSDC project.** Written authorisation on council letterhead being arranged, plus a Registrar email to the project account. Council owns the data. |
| 2 | Which mailbox? | `registrar@ksdc.in` (webmail). Sometimes forwarded from `support@ksdc.in`, but registrar@ is the primary home. |
| 3 | May the software read the mailbox? | **Yes** — a Complaints folder — and draft responses for review. |
| 4 | May the software send? | **Not yet.** Software drafts; the officer copy-pastes and sends from the council mailbox. Automate once the system is proven. |
| 5 | How many operators? | **One** — the officer, as of now. |
| 6 | Does the Registrar log in? | **No.** But role-based access is wanted eventually. |
| 7 | Budget and hosting? | **Council budget via procurement.** Intended: Next.js on Vercel, NestJS on Google Cloud Run. Database and storage recommendation requested. |
| 8 | Data-residency or DPDP policy? | **None exists** at the council. |

## Register, numbering and letters

| # | Question | Answer |
|---|---|---|
| 9 | The `KSDC/297/2026-27` serial? | **Office-wide outward despatch register**, shared with certificates and circulars. Complaints have their **own** serial. Letters carry a despatch number and quote the complaint number in a reference line below the subject. |
| 10 | Does the register stay on paper? | **No — the software becomes the default register.** |
| 11 | Current register columns? | Not available: *"it's a mess right now — you figure out the columns and milestones, I will suggest changes."* → columns proposed in the plan, §2. |
| 12 | What needs wet signature? | **GDC letters only.** All other correspondence is email. |
| 13 | Templates? | Exist on paper somewhere. Wants a **Templates section in the software**, editable, used to draft the emails. |
| 14 | Response times? | **5–7 days** to each party. |
| 15 | Who closes a case? | **The officer.** Routes: unresponsive patient, committee decision, settlement between patient and doctor. |
| 16 | Reminder delivery? | **In-app queue + push notifications on due dates.** |
| 17 | Channels? | Email is usual. The officer **phones** patients and doctors before a sitting — wants a **checklist to tick off after calling**. |

## Respondents and intake

| # | Question | Answer |
|---|---|---|
| 18 | Multiple respondents? | **Yes**, and different respondents can get **different outcomes**. |
| 19 | Dentist registry? | None exportable today, but wanted — **Excel import** perhaps. |
| 20 | Other intake routes? | Forwarded from **DCI/NDC**, rarely from the **police**. |
| 21 | Outcome list? | Correct as proposed, **plus "referral to medical expert."** (The appeal/reopen part of the question was not understood — post-order handling kept simple and explained in plain words, plan §4.) |
| 22 | Ethical-violation notices? | **A separate category.** The council receives information that a dentist is violating guidelines and sends a **cease-and-desist** notice or a **request for explanation**. No patient complainant. |

## Committee

| # | Question | Answer |
|---|---|---|
| 23 | Composition? | **3 members + a chairperson (the President of the Council).** |
| 24 | Cadence? | **2–4 cases per sitting**, monthly or once in two months depending on member availability. |
| 25 | Will members install an app? | **Yes.** Today they receive printouts of case sheets on arrival. |
| 26 | Member visibility and powers? | See **all complaints**; **recuse, comment, and vote** (dismiss / suspend / more-actions). |
| 27 | What does a sitting produce? | **A sheet per case plus consolidated meeting notes**, typed by the officer. |
| 28 | Scheduling? | **WhatsApp** with members (stays outside the app); the officer records attendance. |
| 29 | Non-responding doctor? | **3 notices, then the committee proceeds ex parte.** |

## Expert referral (GDCRI)

| # | Question | Answer |
|---|---|---|
| 30 | Which expert body? | **GDCRI only.** Multiple referrals are not issued. |
| 31 | After the report? | The **committee** receives it and decides how to proceed. The report is shared with the patient **only after the committee modifies/adds to it and agrees to share**. |
| 32 | Who fixes the examination? | **GDC**, directly with the patient — hence the patient's phone number on the letter. |

## Documents, volume and audit

| # | Question | Answer |
|---|---|---|
| 33 | Formats? | PDFs, phone photos, WhatsApp images, X-rays/OPGs as JPEG. The council **sometimes holds physical originals**. |
| 34 | Backlog? | **~10 cases open/pending**; the officer will enter them. |
| 35 | Volume? | **2–4 complaints per month.** |
| 36 | Audit and RTI? | **Tamper-evident audit** wanted. Also a **separate RTI section** to scan and upload RTI requests and their answers and track them. |
| 37 | Other tools to coexist with? | None — this software should be the whole toolset. WhatsApp coordination with members is acceptable overhead. |

## Technical

| # | Question | Answer |
|---|---|---|
| 38 | The mobile app? | Assumptions confirmed. The app **must let a user choose a council** — it should eventually serve **multiple state councils**. v1 can be phone-browser. |
| 39 | AI assist? | **Yes, with mandatory human review.** |

## Volunteered by the officer

- **End state** of a case is usually a committee decision for **reimbursement or retreatment**, sometimes **suspension**, sometimes **amicable settlement** between patient and doctor.
- Uploaded files must be **stored verbatim**; extracting content into status fields can come later.
- The patient's mobile number on the sample GDCRI letter is **normally typed**; the handwritten one was a one-off.
- Reason for the NestJS + Next.js + React Native split: **separation of concerns, and the ambition to publish the app and approach other state councils** so the software becomes widely adopted. This is a product ambition, not just a personal tool.
- Personal GitHub is acceptable for now; an email from the Registrar to the account address will be arranged.
