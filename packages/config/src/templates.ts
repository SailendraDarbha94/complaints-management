import type { CorrespondenceKind } from '@ksdc/contracts';

/**
 * The letters the council sends, as shipped defaults.
 *
 * These are seed data, not code. The officer edits them in the Templates screen and the
 * edits are versioned, because a quasi-judicial record must be able to show which wording
 * produced a given letter — in 2031, about a 2026 letter.
 *
 * The expert referral is transcribed from the one artefact that exists: the scanned
 * KSDC/297/2026-27 letter to the Dean of GDCRI. Its two questions are reproduced word for
 * word, and the template is flagged `isSystem` so editing them warns: they are the terms
 * of reference the expert answers, and the report decides the case.
 */

export interface TemplateSeed {
  kind: CorrespondenceKind;
  name: string;
  /** Wet signature, seal, and a scan back. Only the GDCRI letter, per requirement 12. */
  requiresRegistrarSignature: boolean;
  /** Editing warns: this wording is load-bearing beyond mere politeness. */
  isSystem: boolean;
  subject: string;
  body: string;
}

/** Every outgoing letter carries the complaint number on its own line under the subject. */
const REFERENCE_LINE = 'Ref: Complaint No. {{case.number}}';

const SIGN_OFF = `Thanks & Regards,

Yours faithfully,


{{council.registrarName}}
{{council.registrarTitle}}
{{council.name}}`;

export const KSDC_TEMPLATES: readonly TemplateSeed[] = [
  {
    kind: 'ack_complaint',
    name: 'Acknowledgement to complainant',
    requiresRegistrarSignature: false,
    isSystem: false,
    subject: 'Your complaint has been received - {{case.number}}',
    body: `Dear {{complainant.name}},

${REFERENCE_LINE}

We acknowledge receipt of your complaint dated {{case.receivedOn}}. It has been entered in
the register of the {{council.name}} under the number above. Please quote that number in
any further correspondence.

We will write to you shortly setting out what is needed to take the matter forward.

The information you have sent is held by the Council for the purpose of enquiring into
this complaint under the Dentists Act, and is shared only with the persons and bodies
that enquiry requires.

${SIGN_OFF}`,
  },

  {
    kind: 'request_docs',
    name: 'Request for documents (step 2)',
    requiresRegistrarSignature: false,
    isSystem: false,
    subject: 'Documents required - {{case.number}}',
    body: `Dear {{complainant.name}},

${REFERENCE_LINE}

Thank you for your complaint. Before the matter can be placed before the Ethical
Committee, we require the following. Please send whatever you have; if something is not
available, say so rather than leaving it out.

1. Itemised bills and receipts for the treatment.
2. Prescriptions and any treatment records or discharge summary given to you.
3. Radiographs (IOPA / OPG) or clinical photographs, if any were taken.
4. A dated timeline of what happened, from the first visit onwards.
5. A concise summary of your grievance, in your own words.
6. The dentist's name, qualification, registration number, and the full address of the
   clinic or hospital where the treatment was given.

Please reply within {{deadline.days}} days, that is by {{deadline.date}}. If we do not
hear from you the matter may be closed for want of particulars, and you would have to
begin again.

Scanned copies by email are sufficient. Please keep the originals.

${SIGN_OFF}`,
  },

  {
    kind: 'request_docs_reminder',
    name: 'Reminder to complainant',
    requiresRegistrarSignature: false,
    isSystem: false,
    subject: 'Reminder: documents required - {{case.number}}',
    body: `Dear {{complainant.name}},

${REFERENCE_LINE}

We wrote to you on {{case.receivedOn}} asking for the documents needed to place your
complaint before the Ethical Committee, and have not yet received them.

Please send them by {{deadline.date}}. If any of them cannot be obtained, write and tell
us so - the Committee can consider the matter on what is available, but it cannot consider
it on nothing.

${SIGN_OFF}`,
  },

  {
    kind: 'respondent_explanation_sought',
    name: 'Explanation sought from dentist',
    requiresRegistrarSignature: false,
    isSystem: false,
    subject: 'Explanation called for - {{case.number}}',
    body: `To,
{{respondent.name}}{{#if respondent.registrationNo}}
Registration No. {{respondent.registrationNo}}{{/if}}{{#if respondent.clinic}}
{{respondent.clinic}}{{/if}}
{{respondent.addressLines}}

Respected Doctor,

${REFERENCE_LINE}
Sub: Explanation called for in the complaint of {{complainant.name}}

A complaint has been received by the {{council.name}} from {{complainant.name}} in respect
of treatment stated to have been rendered by you to {{patient.name}}. A copy of the
complaint and the documents filed with it are enclosed.

You are requested to furnish your explanation in the matter, together with copies of the
case records, consent forms, radiographs and billing particulars relating to this patient.

Your reply should reach this office within {{deadline.days}} days, that is by
{{deadline.date}}.

This is an enquiry into the complaint. No finding has been reached, and none will be
reached without considering what you have to say.

${SIGN_OFF}`,
  },

  {
    kind: 'respondent_reminder',
    name: 'Reminder to dentist',
    requiresRegistrarSignature: false,
    isSystem: false,
    subject: 'Reminder - explanation called for - {{case.number}}',
    body: `To,
{{respondent.name}}
{{respondent.addressLines}}

Respected Doctor,

${REFERENCE_LINE}
Sub: Reminder - explanation called for

This office wrote to you calling for your explanation in the above matter. No reply has
been received.

You are requested to send your explanation by {{deadline.date}}. Should no reply be
received, the Ethical Committee may proceed to consider the complaint on the material
before it.

${SIGN_OFF}`,
  },

  {
    kind: 'respondent_final_notice',
    name: 'Final notice to dentist',
    requiresRegistrarSignature: false,
    isSystem: false,
    subject: 'Final notice - {{case.number}}',
    body: `To,
{{respondent.name}}
{{respondent.addressLines}}

Respected Doctor,

${REFERENCE_LINE}
Sub: Final notice - explanation called for

This is the third and final communication in the above matter.
Notice No. {{respondent.noticeNumber}} refers.

If your explanation does not reach this office by {{deadline.date}}, the Ethical Committee
will proceed to consider the complaint ex parte, that is, without your submissions.

${SIGN_OFF}`,
  },

  {
    kind: 'summons_complainant',
    name: 'Hearing notice to complainant',
    requiresRegistrarSignature: false,
    isSystem: false,
    subject: 'Hearing before the Ethical Committee - {{case.number}}',
    body: `Dear {{complainant.name}},

${REFERENCE_LINE}

Your complaint will be taken up by the Ethical Committee of the {{council.name}} on
{{sitting.date}} at {{sitting.time}}, at {{sitting.venue}}.

You are requested to attend in person and to bring the originals of the documents already
filed. If you are unable to attend on that date, please inform this office in advance.

${SIGN_OFF}`,
  },

  {
    kind: 'summons_respondent',
    name: 'Hearing notice to dentist',
    requiresRegistrarSignature: false,
    isSystem: false,
    subject: 'Hearing before the Ethical Committee - {{case.number}}',
    body: `To,
{{respondent.name}}
{{respondent.addressLines}}

Respected Doctor,

${REFERENCE_LINE}

The above complaint will be taken up by the Ethical Committee of the {{council.name}} on
{{sitting.date}} at {{sitting.time}}, at {{sitting.venue}}.

You are requested to attend in person and to bring the original case records relating to
this patient.

${SIGN_OFF}`,
  },

  {
    // Transcribed from the scanned letter KSDC/297/2026-27 to the Dean, GDCRI.
    kind: 'expert_referral_letter',
    name: 'Appointment of an Expert (GDCRI)',
    // The only letter that is printed, signed with wet ink, sealed and scanned back
    // (requirement 12). The scan, not the generated PDF, becomes the record copy.
    requiresRegistrarSignature: true,
    // The two questions below are the terms of reference the expert answers, and the
    // report effectively decides the case. Editing them warns on publish.
    isSystem: true,
    subject: 'Appointment of an Expert in the case of patient named {{patient.name}}',
    body: `To,
{{expert.addresseeTitle}},
{{expert.addressLines}}

Respected Sir,

${REFERENCE_LINE}
Sub: Appointment of an Expert in the case of patient named {{patient.name}}
     Mobile No. {{patient.mobile}}

With reference to the subject mentioned above, the {{council.name}} requests your good
self to conduct an examination of the patient and provide us with a copy of the report
pertaining to the following concerns raised by the patient.

{{expert.questions}}

Kindly provide the {{council.name}} a copy of the report for the purposes of record
maintenance. The relevant files in this case are attached herewith.

${SIGN_OFF}`,
  },

  {
    // Page 2 of the same scanned letter.
    kind: 'expert_referral_copy_to_patient',
    name: 'Expert referral - copy to patient',
    requiresRegistrarSignature: true,
    isSystem: true,
    subject: 'Copy - Appointment of an Expert - {{case.number}}',
    // One deliberate addition to the scanned original: the reference line. Page 2 of the
    // letter carries no complaint number, so once it is separated from page 1 - and it
    // will be, because the patient keeps it and takes it to the hospital - nothing on it
    // says which case it belongs to, or what the patient should quote when they ring.
    body: `${REFERENCE_LINE}

Copy To:

{{patient.name}}

With a request to follow the Guidance of the {{expert.addresseeTitle}} in the matter and
attend the medical examination as and when deemed appropriate by the Doctor.`,
  },

  {
    kind: 'closure_intimation',
    name: 'Closure intimation to complainant',
    requiresRegistrarSignature: false,
    isSystem: false,
    subject: 'Your complaint has been closed - {{case.number}}',
    body: `Dear {{complainant.name}},

${REFERENCE_LINE}

The {{council.name}} has closed the above complaint. The reason recorded in the register
is: {{closure.reason}}.

{{#if decision.operativeText}}The Ethical Committee's decision in the matter is as follows.

{{decision.operativeText}}

{{/if}}If you consider that this matter should be reconsidered, you may write to this
office setting out why.

${SIGN_OFF}`,
  },

  {
    kind: 'ethics_explanation',
    name: 'Ethical violation - explanation sought',
    requiresRegistrarSignature: false,
    isSystem: false,
    subject: 'Explanation called for - {{case.number}}',
    body: `To,
{{respondent.name}}{{#if respondent.registrationNo}}
Registration No. {{respondent.registrationNo}}{{/if}}
{{respondent.addressLines}}

Respected Doctor,

${REFERENCE_LINE}
Sub: Explanation called for regarding observance of the Code of Ethics

Information has come to the notice of the {{council.name}} suggesting that the ethical
guidelines applicable to registered dentists may not have been observed in your case.

You are requested to furnish your explanation in the matter within {{deadline.days}} days,
that is by {{deadline.date}}.

${SIGN_OFF}`,
  },

  {
    kind: 'ethics_cease_desist',
    name: 'Ethical violation - cease and desist',
    // Worth confirming with the Registrar whether this goes out under his signature too;
    // it is seed data, so changing it is one field, not a code change.
    requiresRegistrarSignature: false,
    isSystem: false,
    subject: 'Notice to cease and desist - {{case.number}}',
    body: `To,
{{respondent.name}}
{{respondent.addressLines}}

Respected Doctor,

${REFERENCE_LINE}
Sub: Notice to cease and desist

The {{council.name}} has considered the material before it in the above matter.

You are hereby directed to cease and desist from the practice complained of forthwith, and
to confirm compliance to this office in writing by {{deadline.date}}.

Failure to comply may be placed before the Ethical Committee for such further action as it
considers appropriate.

${SIGN_OFF}`,
  },
];
