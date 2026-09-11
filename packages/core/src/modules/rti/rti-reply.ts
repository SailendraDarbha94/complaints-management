import {
  BLANK,
  RTI_DAYS,
  exemptionFor,
  forbidsExemption,
  requiresExemption,
  rtiReferenceLine,
  type RtiDecision,
  type RtiExemptionSection,
} from '@ksdc/contracts';
import type { IsoDate } from '../../common/working-days.js';
import type { RtiClock } from './rti-clock.js';

/**
 * The reply composer, which cannot produce a defective refusal.
 *
 * Every other letter in this system comes out of an editable template, and that is right:
 * the wording of an acknowledgement belongs to the council. This one does not, and the
 * difference is the whole reason this file exists rather than a nineteenth template row.
 *
 * s.7(8) says a rejection must communicate three things: the reasons, the period within
 * which an appeal may be preferred, and the particulars of the appellate authority. A
 * refusal missing any of them is appealable on its face. If the appeal paragraph were a
 * line in a textarea, then one day, at half past six, someone tidying up a letter would
 * delete it — and the defect would not surface until the Commission said so, with a
 * penalty attached to a named officer.
 *
 * So the statutory furniture is assembled here, in code, and the officer's own words go
 * only where the Act asks for their judgement: the reasons for each ground relied on, and
 * the substance of the answer.
 *
 * The second thing this file does is REFUSE TO BE SILENT. It never withholds a letter; it
 * renders a visible blank and returns a `defects` list saying, in the officer's language,
 * exactly what is wrong with the letter in front of them. A letter that will not compose
 * teaches people to write the letter somewhere else.
 */

export interface RtiReplyCouncil {
  name: string;
  addressLines: string[];
  officialEmail: string | null;
}

export interface RtiReplyRequest {
  rtiNo: string;
  receivedOn: IsoDate;
  applicantName: string;
  applicantAddressLines: string[];
  requestText: string;
  decision: RtiDecision | null;
  decisionReasons: string | null;
  transferredTo: string | null;
  transferredOn: IsoDate | null;
  thirdPartyName: string | null;
  thirdPartyObjected: boolean | null;
  thirdPartyRepresentationOn: IsoDate | null;
  isBpl: boolean;
}

export interface RtiOfficeHolder {
  fullName: string;
  designation: string | null;
  addressLines?: string[];
}

export interface RtiReplyInput {
  council: RtiReplyCouncil;
  rti: RtiReplyRequest;
  exemptions: Array<{ section: RtiExemptionSection; appliesTo: string; reasoning: string }>;
  /** From council_office_holder. Null until somebody records who holds the office. */
  pio: RtiOfficeHolder | null;
  firstAppellateAuthority: RtiOfficeHolder | null;
  clock: RtiClock;
  letterDate: IsoDate;
}

export interface RtiReplyDraft {
  subject: string;
  body: string;
  /**
   * Why this letter is defective AS IT STANDS. Empty means it is complete.
   *
   * Shown above the draft, not hidden behind a validation error, because the officer is
   * the one who can fix every item on it and they are reading the letter anyway.
   */
  defects: string[];
}

const DECISION_OPENING: Record<RtiDecision, string> = {
  information_supplied:
    'The information sought is furnished as set out below and in the enclosures to this letter.',
  partly_supplied:
    'Part of the information sought is furnished as set out below. The remainder is withheld ' +
    'for the reasons given under the heading that follows.',
  refused: 'The information sought is not furnished, for the reasons given below.',
  information_not_held:
    'The information sought is not held by this office. Under section 2(f) of the Act, ' +
    'information means material held in some record by the public authority, and no such ' +
    'record is held here.',
  transferred:
    'The subject matter of your application is more closely connected with the functions of ' +
    'another public authority. Your application has accordingly been transferred under ' +
    'section 6(3) of the Act, and you are informed of the transfer below.',
  query_not_information:
    'Your application asks a question rather than seeking access to a record. Under section ' +
    '2(f) of the Act, information means material held in some record; the Act does not ' +
    'require a public authority to create an answer, an opinion or an explanation that does ' +
    'not already exist in its records. That part of your application is answered on that basis.',
};

export function composeRtiReply(input: RtiReplyInput): RtiReplyDraft {
  const { council, rti, exemptions, clock } = input;
  const defects: string[] = [];

  const subject =
    `Reply under the Right to Information Act, 2005 - ${rti.rtiNo}`;

  const lines: string[] = [];

  lines.push('To,');
  lines.push(rti.applicantName || BLANK);
  for (const l of rti.applicantAddressLines) lines.push(l);
  lines.push('');
  lines.push(`Date: ${input.letterDate}`);
  lines.push(rtiReferenceLine(rti.rtiNo));
  lines.push(
    'Sub: Your application under the Right to Information Act, 2005, received in this ' +
      `office on ${rti.receivedOn}`,
  );
  lines.push('');
  lines.push('Sir / Madam,');
  lines.push('');
  lines.push(
    `Your application under the Right to Information Act, 2005 was received in this office ` +
      `on ${rti.receivedOn} and registered as ${rti.rtiNo}. The decision of the Public ` +
      'Information Officer on it is communicated below.',
  );
  lines.push('');

  // --- What was asked. Quoted, so the scope of what was answered is on the face of the
  // --- reply and cannot be argued about afterwards.
  lines.push('Information sought:');
  lines.push('');
  for (const l of rti.requestText.split('\n')) lines.push(`    ${l}`);
  lines.push('');

  // --- The decision.
  if (!rti.decision) {
    defects.push('No decision has been recorded on this application, so this letter says nothing.');
    lines.push('Decision:');
    lines.push('');
    lines.push(BLANK);
    lines.push('');
  } else {
    lines.push('Decision:');
    lines.push('');
    lines.push(DECISION_OPENING[rti.decision]);
    lines.push('');

    if (rti.decisionReasons?.trim()) {
      for (const l of rti.decisionReasons.trim().split('\n')) lines.push(l);
      lines.push('');
    } else if (needsSubstance(rti.decision)) {
      defects.push(
        'Nothing has been written under the decision. Section 7(1) requires the decision to ' +
          'be communicated with reasons, and the standard opening above is not reasons.',
      );
      lines.push(BLANK);
      lines.push('');
    }

    if (rti.decision === 'transferred') {
      lines.push(
        `Transferred to: ${rti.transferredTo?.trim() || BLANK}` +
          (rti.transferredOn ? `, on ${rti.transferredOn}.` : '.'),
      );
      lines.push(
        'That authority will deal with your application and communicate its decision to you ' +
          'directly.',
      );
      lines.push('');
      if (!rti.transferredTo?.trim()) {
        defects.push(
          'A transfer under s.6(3) has to name the authority it went to. The letter cannot ' +
            'say the application was transferred without saying where.',
        );
      }
    }
  }

  // --- The grounds, one paragraph each, with the clause quoted and the officer's reasons.
  if (exemptions.length > 0) {
    lines.push('Grounds on which information is withheld:');
    lines.push('');
    exemptions.forEach((e, i) => {
      const clause = exemptionFor(e.section);
      lines.push(`${i + 1}. ${clause.cite} of the Right to Information Act, 2005, which exempts`);
      lines.push(`   "${clause.text}".`);
      lines.push('');
      lines.push(`   Applied to: ${e.appliesTo.trim() || BLANK}`);
      lines.push('');
      for (const l of (e.reasoning.trim() || BLANK).split('\n')) lines.push(`   ${l}`);
      lines.push('');
      if (!e.reasoning.trim()) {
        defects.push(
          `${clause.cite} is cited with no reasons. Section 7(8)(i) requires the reasons for ` +
            'the rejection, and naming the clause is not a reason.',
        );
      }
      if (!e.appliesTo.trim()) {
        defects.push(
          `${clause.cite} is cited without saying which part of the request it answers. On a ` +
            'partial reply the applicant cannot tell what was withheld.',
        );
      }
    });
  }

  // --- s.7(6): where the period ran out, the information is free. Said by the council
  // --- rather than discovered by the applicant, because it is the law either way and a
  // --- council that says it first is in a better position than one that is told.
  if (clock.deemedRefusal || clock.penaltyExposureRupees > 0) {
    lines.push(
      `This reply is issued after the period allowed by section 7(1), which expired on ` +
        `${clock.dueOn}. Under section 7(6) of the Act, the information is therefore ` +
        'furnished free of any further charge.',
    );
    lines.push('');
  }

  // --- s.11(4). If a third party objected and the council is disclosing anyway, the
  // --- disclosure is held until their appeal period runs out. Missing this is how a
  // --- council ends up disclosing something a court then says it should not have.
  if (rti.thirdPartyObjected && isDisclosing(rti.decision)) {
    lines.push(
      `A third party was consulted under section 11 and objected on ` +
        `${rti.thirdPartyRepresentationOn ?? BLANK}. Under section 11(4), where a decision is ` +
        'taken to disclose information over such an objection, the disclosure is not made ' +
        `until the period of ${RTI_DAYS.thirdPartyAppeal} days allowed to that third party ` +
        'for an appeal under section 19 has expired, or, where an appeal is preferred, until ' +
        'it is decided.',
    );
    lines.push('');
    defects.push(
      `${rti.thirdPartyName ?? 'The third party'} objected to disclosure. Section 11(4) means ` +
        'the information must NOT actually be sent until their thirty days for an appeal have ' +
        'run out. Send this letter; hold the material.',
    );
  }

  // --- s.7(5) proviso.
  if (rti.isBpl) {
    lines.push(
      'No fee is charged, the applicant having stated that they are below the poverty line ' +
        '(proviso to section 7(5)).',
    );
    lines.push('');
  }

  // --- The appeal. On EVERY reply, not only on a rejection: s.19(1) allows an appeal
  // --- against a reply the applicant says is incomplete or misleading, so the route
  // --- belongs on all of them, and a council that volunteers it looks like one with
  // --- nothing to hide.
  const faa = input.firstAppellateAuthority;
  lines.push('Appeal:');
  lines.push('');
  lines.push(
    `If you are not satisfied with this decision you may prefer an appeal under section ` +
      `19(1) of the Act within ${RTI_DAYS.firstAppeal} days of the receipt of this ` +
      'communication, to the First Appellate Authority:',
  );
  lines.push('');
  lines.push(`    ${faa?.fullName ?? BLANK}`);
  lines.push(`    ${faa?.designation ?? BLANK}`);
  for (const l of faa?.addressLines?.length ? faa.addressLines : council.addressLines) {
    lines.push(`    ${l}`);
  }
  lines.push('');
  lines.push(
    'The Appellate Authority may admit an appeal after that period if satisfied that you ' +
      'were prevented by sufficient cause from filing in time.',
  );
  lines.push('');

  if (!faa) {
    defects.push(
      'No First Appellate Authority is recorded for this council, so the letter cannot name ' +
        'one. Section 7(8)(iii) requires the particulars of the appellate authority; a ' +
        'refusal without them is appealable on its face. The Act also requires the appellate ' +
        'authority to be an officer senior in rank to the Public Information Officer, so the ' +
        'two cannot be the same person - this is the point to settle with the Registrar.',
    );
  }

  // --- Signature. The Act attaches the decision to a named officer, and the penalty
  // --- follows the same name, so an unsigned reply serves nobody.
  lines.push('Yours faithfully,');
  lines.push('');
  lines.push('');
  lines.push(input.pio?.fullName ?? BLANK);
  lines.push(input.pio?.designation ?? 'Public Information Officer');
  lines.push(council.name);
  for (const l of council.addressLines) lines.push(l);
  if (council.officialEmail) lines.push(council.officialEmail);

  if (!input.pio) {
    defects.push(
      'No Public Information Officer is recorded for this council, so the letter cannot be ' +
        'signed in that capacity. Record who holds the office before this goes out.',
    );
  }

  // --- Structural defects: a ground where none may be cited, or none where one must be.
  if (rti.decision && requiresExemption(rti.decision) && exemptions.length === 0) {
    defects.push(
      'Information is being withheld with no section cited. Information may be withheld only ' +
        'under section 8(1) or section 9; a refusal that names no clause is defective and ' +
        'will be set aside on appeal.',
    );
  }
  if (rti.decision && forbidsExemption(rti.decision) && exemptions.length > 0) {
    defects.push(
      'A section 8 or 9 ground is cited on a decision that withholds nothing. That tells the ' +
        'applicant the Council is holding something back, which is not what this decision ' +
        'says. Remove the ground or change the decision.',
    );
  }

  return { subject, body: lines.join('\n'), defects };
}

/** Decisions whose substance is the officer's to write; the standard opening is not enough. */
function needsSubstance(decision: RtiDecision): boolean {
  return (
    decision === 'information_supplied' ||
    decision === 'partly_supplied' ||
    decision === 'query_not_information'
  );
}

function isDisclosing(decision: RtiDecision | null): boolean {
  return decision === 'information_supplied' || decision === 'partly_supplied';
}
