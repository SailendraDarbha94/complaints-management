import type { RtiDecision, RtiExemptionSection } from './enums.js';

/**
 * What the Right to Information Act, 2005 requires of this register.
 *
 * Researched and re-checked against the bare Act, the Karnataka Rules, DoPT guidance and
 * CIC/KIC decisions; the working is in docs/rti-mechanics-2026-09-11.md. This file is the
 * part of that research the software has to obey, in one place, so a deadline or a ground
 * is never re-derived at a call site.
 *
 * THE REASON THIS MODULE IS BUILT THE WAY IT IS:
 *
 * s.20(1) fixes the penalty for delay at Rs 250 for each day, capped at Rs 25,000, and it
 * is imposed on the Public Information Officer personally and recovered from their
 * salary. The burden of showing they acted reasonably and diligently is on them. So the
 * software is not protecting an institution from an abstract risk; it is protecting a
 * named person from a deduction they will feel, and the evidence that discharges that
 * burden is exactly what a dated, audited workflow produces.
 *
 * NOT LEGAL ADVICE. Where the law is genuinely unsettled the code says so and asks rather
 * than choosing a default; those points are listed in the research note and want the
 * Registrar's view.
 */

/** s.20(1). Personal, on the officer, recovered from salary. The cap arrives at 100 days. */
export const RTI_PENALTY = { rupeesPerDay: 250, capRupees: 25_000 } as const;

/**
 * Every period the Act fixes, in days, from the point each one actually runs from.
 *
 * The two origins do not coincide and that is the trap: the 5-day notice and the 40-day
 * outer limit both run from the council's receipt of the APPLICATION, while the third
 * party's 10 days runs from THEIR receipt of the NOTICE — a date the council does not
 * control and cannot know until the acknowledgement card comes back.
 */
export const RTI_DAYS = {
  /** s.7(1). From the authority's own inward date. */
  reply: 30,
  /** s.11(3). Replaces the 30 where s.11 applies — a net gain of ten days only. */
  replyWithThirdParty: 40,
  /** s.6(3). A late transfer keeps the transferring officer's personal exposure. */
  transfer: 5,
  /** s.11(1). From receipt of the application. */
  thirdPartyNotice: 5,
  /** s.11(2). From the third party's receipt of the notice, not from its despatch. */
  thirdPartyRepresentation: 10,
  /** s.19(1). Condonable, so a file must stay re-openable well past it. */
  firstAppeal: 30,
  /** s.19(6). Two anchors, both of which must be held. */
  firstAppealDecision: 30,
  firstAppealDecisionFromFiling: 45,
  /** s.11(4). And disclosure must be HELD until that appeal is decided. */
  thirdPartyAppeal: 30,
} as const;

/** s.7(1) proviso. Only on demonstrably proven danger, and the officer's reasoning is recorded. */
export const RTI_LIFE_OR_LIBERTY_HOURS = 48;

/**
 * The grounds, with the statutory words.
 *
 * `text` is the clause, abridged only by dropping provisos that do not change what the
 * clause covers. It is shown to the officer at the moment they pick a ground and it is
 * quoted into the refusal, because a refusal that does not say which clause and why is
 * appealable on its face (s.7(8)).
 *
 * `commonHere` marks the four that actually arise on a dental council's files. The other
 * seven stay on the list because a refusal citing a clause that is not offered is a
 * refusal the officer writes by hand outside the system, which is the failure mode this
 * module exists to remove.
 */
export interface RtiExemption {
  section: RtiExemptionSection;
  /** As it is cited in the reply: "Section 8(1)(j) of the Right to Information Act, 2005". */
  cite: string;
  text: string;
  commonHere: boolean;
  /** Set where the clause has a live caveat the officer must know before relying on it. */
  caution?: string;
}

export const RTI_EXEMPTIONS: readonly RtiExemption[] = [
  {
    section: 's8_1_a',
    cite: 'Section 8(1)(a)',
    text:
      'information, disclosure of which would prejudicially affect the sovereignty and ' +
      'integrity of India, the security, strategic, scientific or economic interests of ' +
      'the State, relation with foreign State or lead to incitement of an offence',
    commonHere: false,
  },
  {
    section: 's8_1_b',
    cite: 'Section 8(1)(b)',
    text:
      'information which has been expressly forbidden to be published by any court of law ' +
      'or tribunal or the disclosure of which may constitute contempt of court',
    commonHere: false,
    caution:
      'This needs an actual order of a court forbidding publication. A matter merely being ' +
      'sub judice is not this clause.',
  },
  {
    section: 's8_1_c',
    cite: 'Section 8(1)(c)',
    text:
      'information, the disclosure of which would cause a breach of privilege of Parliament ' +
      'or the State Legislature',
    commonHere: false,
  },
  {
    section: 's8_1_d',
    cite: 'Section 8(1)(d)',
    text:
      'information including commercial confidence, trade secrets or intellectual property, ' +
      'the disclosure of which would harm the competitive position of a third party, unless ' +
      'the competent authority is satisfied that larger public interest warrants the ' +
      'disclosure of such information',
    commonHere: true,
  },
  {
    section: 's8_1_e',
    cite: 'Section 8(1)(e)',
    text:
      'information available to a person in his fiduciary relationship, unless the competent ' +
      'authority is satisfied that the larger public interest warrants the disclosure of ' +
      'such information',
    commonHere: true,
    caution:
      'A treatment record held by a regulator is the usual argument here. It is arguable, ' +
      'and it is not the strongest ground available on these files — 8(1)(j) is.',
  },
  {
    section: 's8_1_f',
    cite: 'Section 8(1)(f)',
    text: 'information received in confidence from foreign Government',
    commonHere: false,
  },
  {
    section: 's8_1_g',
    cite: 'Section 8(1)(g)',
    text:
      'information, the disclosure of which would endanger the life or physical safety of ' +
      'any person or identify the source of information or assistance given in confidence ' +
      'for law enforcement or security purposes',
    commonHere: false,
  },
  {
    section: 's8_1_h',
    cite: 'Section 8(1)(h)',
    text:
      'information which would impede the process of investigation or apprehension or ' +
      'prosecution of offenders',
    commonHere: true,
    caution:
      'An enquiry that is genuinely still running. It is not a standing answer for every ' +
      'open file: the officer must be able to say what step the disclosure would impede.',
  },
  {
    section: 's8_1_i',
    cite: 'Section 8(1)(i)',
    text:
      'cabinet papers including records of deliberations of the Council of Ministers, ' +
      'Secretaries and other officers',
    commonHere: false,
  },
  {
    section: 's8_1_j',
    cite: 'Section 8(1)(j)',
    // The whole clause, as substituted by s.44(3) of the Digital Personal Data Protection
    // Act, 2023, which commenced on 13 November 2025 (G.S.R. 843(E)). It is live now.
    text: 'information which relates to personal information',
    commonHere: true,
    caution:
      'This is the amended clause, in force since 13 November 2025. The public-activity ' +
      'test, the unwarranted-invasion test and the internal public-interest override are ' +
      'all gone: it is now a flat exemption. The only remaining route to disclosure is ' +
      's.8(2), which is a discretion of the authority and not a duty — and it is ' +
      'exercised, if at all, in writing.',
  },
  {
    section: 's9',
    cite: 'Section 9',
    text:
      'a request for information may be rejected where such a request for providing access ' +
      'would involve an infringement of copyright subsisting in a person other than the State',
    commonHere: false,
  },
];

export function exemptionFor(section: RtiExemptionSection): RtiExemption {
  const found = RTI_EXEMPTIONS.find((e) => e.section === section);
  if (!found) throw new Error(`No exemption defined for "${section}"`);
  return found;
}

/**
 * Which decisions must be supported by a section, and which must NOT be.
 *
 * Both directions matter. A refusal with no ground is defective; but a ground attached to
 * "we do not hold this" or "that is a question, not a record" is equally wrong, because it
 * asserts the council holds something it is withholding.
 */
export function requiresExemption(decision: RtiDecision): boolean {
  return decision === 'refused' || decision === 'partly_supplied';
}

export function forbidsExemption(decision: RtiDecision): boolean {
  return (
    decision === 'information_supplied' ||
    decision === 'information_not_held' ||
    decision === 'transferred' ||
    decision === 'query_not_information'
  );
}

/** The reference line on an RTI reply. Not "Complaint No." — it is a different register. */
export function rtiReferenceLine(rtiNo: string): string {
  return `Ref: RTI Application No. ${rtiNo}`;
}

/**
 * s.7(8): what a refusal must carry, or it is appealable on its face.
 *
 * Kept as a checklist rather than enforced silently, so the officer sees WHICH of the
 * three is missing before the letter goes out — most often it is the third, because
 * nobody has recorded who the First Appellate Authority is.
 */
export const REFUSAL_REQUIREMENTS = [
  'the reasons for the rejection',
  'the period within which an appeal against such rejection may be preferred',
  'the particulars of the appellate authority',
] as const;

/**
 * The two offices the Act names, as they are recorded in council_office_holder.
 *
 * Who holds them at KSDC is NOT decided here. The officer has said the RTI work is handled
 * by them together with the Registrar, which does not by itself say which of the two is
 * the PIO and which is the First Appellate Authority — and the Act requires them to be
 * different people, because the appeal lies to an officer senior in rank to the PIO
 * (s.19(1)). Until that is confirmed with the Registrar the composer renders a visible
 * blank and says the refusal is defective, rather than guessing and printing a name.
 */
export const RTI_OFFICES = {
  pio: 'rti_pio',
  firstAppellateAuthority: 'rti_first_appellate_authority',
} as const;
