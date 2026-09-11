import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import type { CorrespondenceKind, MergeContext } from '@ksdc/contracts';
import type { EngineContext } from '../followups/followup.service.js';
import { addDaysByBasis, todayIn, type IsoDate } from '../../common/working-days.js';
import { followupRuleFor } from '@ksdc/config';

/**
 * Assembles the facts a letter merges in.
 *
 * This is built once per draft and snapshotted onto the correspondence row, because a
 * quasi-judicial record must be able to show in 2031 what data produced a 2026 letter.
 * Re-deriving it later would answer a different question: what the data says now.
 */

/** How the council writes a date on a letter: 18 September 2026. */
export function formatLetterDate(iso: IsoDate): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export interface BuildContextArgs {
  caseFileId: string;
  kind: CorrespondenceKind;
  /** Required for the respondent letters. */
  caseRespondentId?: string | null;
  officerName?: string | null;
  now?: Date;
}

/** Which follow-up stage's deadline a letter should quote, if any. */
const DEADLINE_STAGE: Partial<Record<CorrespondenceKind, Parameters<typeof followupRuleFor>[1]>> = {
  request_docs: 'await_patient_docs',
  request_docs_reminder: 'await_patient_docs',
  respondent_explanation_sought: 'await_respondent_explanation',
  respondent_reminder: 'await_respondent_explanation',
  respondent_final_notice: 'await_respondent_explanation',
  ethics_explanation: 'await_ev_explanation',
  ethics_cease_desist: 'await_ev_explanation',
};

export async function buildMergeContext(
  tx: Tx,
  ctx: EngineContext,
  args: BuildContextArgs,
): Promise<MergeContext> {
  const today = todayIn(ctx.config.calendar.timezone, args.now);

  const councilRow = await tx.execute<{
    code: string;
    name: string;
    address_lines: string[];
    phone: string | null;
    official_email: string;
    registrar_name: string;
    registrar_title: string;
    president_title: string;
  }>(sql`
    SELECT code, name, address_lines, phone, official_email, registrar_name,
           registrar_title, president_title
    FROM council WHERE id = ${ctx.councilId}::uuid
  `);
  const council = councilRow.rows[0];
  if (!council) throw new Error('Council not found');

  const caseRow = await tx.execute<{
    case_number: string;
    fiscal_year: string;
    summary: string;
    closure_reason: string | null;
    received_on: string | null;
  }>(sql`
    SELECT c.case_number, c.fiscal_year, c.summary, c.closure_reason,
           (SELECT to_char(m.occurred_at AT TIME ZONE ${ctx.config.calendar.timezone}, 'YYYY-MM-DD')
              FROM case_milestone m
             WHERE m.case_file_id = c.id AND m.milestone = 'received'
             ORDER BY m.occurred_at LIMIT 1) AS received_on
    FROM case_file c WHERE c.id = ${args.caseFileId}::uuid
  `);
  const caseFile = caseRow.rows[0];
  if (!caseFile) throw new Error(`Case ${args.caseFileId} not found`);

  const parties = await tx.execute<{
    role: string;
    full_name: string;
    mobile: string | null;
    email: string | null;
    address_lines: string[] | null;
    age_years: number | null;
    sex: string | null;
    registration_no: string | null;
    clinic_name: string | null;
  }>(sql`
    SELECT cp.role, p.full_name, p.mobile, p.email, p.address_lines, p.age_years, p.sex,
           rd.registration_no, rd.clinic_name
    FROM case_party cp
    JOIN party p ON p.id = cp.party_id
    LEFT JOIN registered_dentist rd ON rd.id = p.registered_dentist_id
    WHERE cp.case_file_id = ${args.caseFileId}::uuid
  `);

  const byRole = (role: string) => parties.rows.find((p) => p.role === role);
  const complainant = byRole('complainant');
  const patient = byRole('patient');

  // The named respondent, when the letter is to one of them.
  let respondent: (typeof parties.rows)[number] | undefined;
  let noticeNumber: number | undefined;
  if (args.caseRespondentId) {
    const r = await tx.execute<{
      full_name: string;
      address_lines: string[] | null;
      registration_no: string | null;
      clinic_name: string | null;
      notice_count: number;
    }>(sql`
      SELECT p.full_name, p.address_lines, rd.registration_no, rd.clinic_name, cr.notice_count
      FROM case_respondent cr
      JOIN case_party cp ON cp.id = cr.case_party_id
      JOIN party p ON p.id = cp.party_id
      LEFT JOIN registered_dentist rd ON rd.id = p.registered_dentist_id
      WHERE cr.id = ${args.caseRespondentId}::uuid
    `);
    const row = r.rows[0];
    if (row) {
      respondent = { role: 'respondent_dentist', mobile: null, email: null, age_years: null, sex: null, ...row };
      // The notice about to go out is the next one, not the last one sent.
      noticeNumber = row.notice_count + 1;
    }
  }

  const stage = DEADLINE_STAGE[args.kind];
  let deadline: { days: number; date: string } | undefined;
  if (stage) {
    const rule = followupRuleFor(ctx.config, stage);
    const dueOn = addDaysByBasis(today, rule.dueInDays, rule.basis, {
      workingWeekdays: ctx.config.calendar.workingWeekdays,
      holidays: ctx.config.calendar.holidays,
    });
    deadline = { days: rule.dueInDays, date: formatLetterDate(dueOn) };
  }

  return {
    council: {
      name: council.name,
      addressLines: council.address_lines,
      phone: council.phone,
      email: council.official_email,
      registrarName: council.registrar_name,
      registrarTitle: council.registrar_title,
      presidentTitle: council.president_title,
    },
    case: {
      number: caseFile.case_number,
      fiscalYear: caseFile.fiscal_year,
      summary: caseFile.summary,
      receivedOn: caseFile.received_on ? formatLetterDate(caseFile.received_on) : null,
    },
    complainant: complainant && {
      name: complainant.full_name,
      mobile: complainant.mobile,
      email: complainant.email,
      addressLines: complainant.address_lines,
    },
    patient: patient && {
      name: patient.full_name,
      age: patient.age_years,
      sex: patient.sex,
      mobile: patient.mobile ?? complainant?.mobile ?? null,
    },
    respondent: respondent && {
      name: respondent.full_name,
      registrationNo: respondent.registration_no,
      clinic: respondent.clinic_name,
      addressLines: respondent.address_lines,
      noticeNumber,
    },
    deadline,
    expert: {
      name: ctx.config.expertBody.name,
      addresseeTitle: `${ctx.config.expertBody.addresseeTitle}, ${ctx.config.expertBody.name}`,
      addressLines: ctx.config.expertBody.addressLines,
      // Numbered exactly as they appear on the scanned original.
      questions: ctx.config.expertBody.referralQuestions.map((q, i) => `${i + 1}. ${q}`),
    },
    letter: {
      date: formatLetterDate(today),
      // The office-wide despatch number is assigned outside this software, so the draft
      // prints a pen-fillable blank and a follow-up chases the officer to type in what
      // the office actually stamped.
      despatchRef: `${council.code}/____/${caseFile.fiscal_year}`,
    },
    closure: { reason: caseFile.closure_reason },
    // Phase 4 fills this from the sitting that decided the case. Until then the closure
    // letter's conditional block simply does not render, which is correct: there is no
    // committee decision to quote yet.
    decision: undefined,
    officer: { name: args.officerName ?? null },
  };
}
