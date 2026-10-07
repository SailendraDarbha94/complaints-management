import { sql, type SQL } from 'drizzle-orm';
import { withCouncil, type Tx } from '@ksdc/db';
import type { EngineContext } from '../followups/followup.service.js';
import type { RespondentService } from '../cases/respondent.service.js';
import { pgTextArray } from '../../common/pg-array.js';
import {
  canonicalCaseNumber,
  nameHasWords,
  nameWords,
  registrationMatches,
  withoutContacts,
} from './text-rules.js';
import type { CaseDetail, CaseSearchHit, DentistHit, TriageTools } from './types.js';

/**
 * The three lookups the model may make, answered from the register.
 *
 * READ-ONLY, all three, and that is the whole of stage 1's safety argument: nothing the
 * model can call changes a row. It can find out what the register knows; only the officer
 * can change it.
 *
 * WHAT THEY NEVER RETURN: an email address or a phone number. The model can search BY
 * one - "is this sender already a complainant?" is the most useful question it can ask -
 * and is told only that the match was on an email address. Handing back the contact
 * details of every person on a matching case would put other complainants' addresses in
 * front of a model reading an email anybody on the internet could have written, and the
 * model has no use for them: it suggests, and the officer's screen already shows them.
 * No contact FIELD is ever selected; and the free text that is returned - case summaries,
 * the subjects of earlier letters, which senders wrote and often put a number in - goes
 * through withoutContacts() first, the same rule the evaluation's lookups keep.
 *
 * WHAT THEY NEVER RETURN, EITHER: a case cancelled as opened in error. It was never a
 * complaint, so it is not a case anything can follow up, and the tray's own matcher
 * leaves it out for the same reason. Closed cases ARE returned, marked closed: a reply on
 * a closed case is real and the officer has to decide what to do with it.
 *
 * EACH LOOKUP RUNS IN ITS OWN SHORT TRANSACTION. The model thinks between calls, for
 * seconds at a time; a transaction held open across that would pin a pooled connection
 * idle-in-transaction for the length of the conversation. So each call opens a scope,
 * reads, and closes it.
 */

/** Enough to choose between, few enough that a list of them stays cheap to send. */
export const CASE_SEARCH_LIMIT = 8;
/** Letters on a case shown to the model: the recent ones are what a follow-up answers. */
const RECENT_LETTERS = 10;
/** A query is a name, a number or an address - never an essay. */
const MAX_QUERY = 200;

export function registerTools(ctx: EngineContext, respondents: RespondentService): TriageTools {
  const scope = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withCouncil({ councilId: ctx.councilId, userId: ctx.userId ?? null }, fn);

  return {
    searchCases: (query) => scope((tx) => searchCases(tx, ctx, query)),
    getCase: (caseNumber) => scope((tx) => getCase(tx, ctx, caseNumber)),
    searchDentists: (query) => scope((tx) => searchDentists(tx, ctx, respondents, query)),
  };
}

function cleanQuery(q: unknown): string {
  // The engine passes what the model wrote. It is meant to be a string; it is not
  // trusted to be one.
  return (typeof q === 'string' ? q : String(q ?? '')).replace(/\u0000/g, '').trim().slice(0, MAX_QUERY);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Every word of the query must appear in the name, in any order.
 *
 * Not one substring: the model writes "Devi Kavitha" as readily as "Kavitha Devi", and
 * the register holds whichever the complainant typed. Honorifics and punctuation are
 * dropped (nameWords, in text-rules.ts) so "Dr. Ramesh" finds "Ramesh Bhat" as well as
 * "Dr Ramesh Bhat".
 */
function nameMatch(column: SQL, words: string[]): SQL {
  if (words.length === 0) return sql`false`;
  return sql.join(
    words.map((w) => sql`${column} ILIKE ${`%${escapeLike(w)}%`}`),
    sql` AND `,
  );
}

export async function searchCases(
  tx: Tx,
  ctx: EngineContext,
  rawQuery: unknown,
): Promise<CaseSearchHit[]> {
  const q = cleanQuery(rawQuery);
  if (q.length < 2) return [];
  const tz = ctx.config.calendar.timezone;

  // What the query could be. Each reading is tried only where it makes sense, so a phone
  // number is not also matched against names and a name is not matched against serials.
  const isEmail = q.includes('@');
  const isPhoneLike = /^[\d\s()+\-.]+$/.test(q);
  const digits = q.replace(/\D/g, '');

  // A bare serial - "12", "0012" - is the end of a case number, not anywhere in it: '12'
  // as a substring would also match 0112, 0120 and 1200.
  const numberCond: SQL =
    /^\d{1,4}$/.test(q)
      ? sql`c.case_number LIKE ${`%/${q.padStart(4, '0')}`}`
      : /\d/.test(q) && !isEmail
        ? sql`upper(c.case_number) LIKE ${`%${escapeLike(q.toUpperCase())}%`}`
        : sql`false`;

  const words = isEmail || isPhoneLike ? [] : nameWords(q);
  const email = isEmail ? q.toLowerCase() : '';
  // The last ten digits: '+91 98450 12345' and '9845012345' are the same telephone, and
  // mobile_normalised holds whichever was typed, digits only.
  const phone = isPhoneLike && digits.length >= 7 ? digits.slice(-10) : '';

  const partyOnCase = (role: SQL, cond: SQL): SQL => sql`EXISTS (
    SELECT 1 FROM case_party cp JOIN party p ON p.id = cp.party_id
     WHERE cp.case_file_id = c.id AND ${role} AND (${cond}))`;

  const rows = await tx.execute<{
    case_number: string;
    summary: string;
    state: string;
    opened_on: string;
    closed: boolean;
    complainant_name: string | null;
    patient_name: string | null;
    respondent_names: string[] | null;
    on_number: boolean;
    on_complainant: boolean;
    on_patient: boolean;
    on_dentist: boolean;
    on_email: boolean;
    on_phone: boolean;
  }>(sql`
    SELECT h.*,
           (SELECT p.full_name FROM case_party cp JOIN party p ON p.id = cp.party_id
             WHERE cp.case_file_id = h.id AND cp.role = 'complainant'
             ORDER BY cp.created_at LIMIT 1) AS complainant_name,
           (SELECT p.full_name FROM case_party cp JOIN party p ON p.id = cp.party_id
             WHERE cp.case_file_id = h.id AND cp.role = 'patient'
             ORDER BY cp.created_at LIMIT 1) AS patient_name,
           (SELECT coalesce(array_agg(p.full_name ORDER BY cr.created_at), '{}')
              FROM case_respondent cr
              JOIN case_party cp ON cp.id = cr.case_party_id
              JOIN party p ON p.id = cp.party_id
             WHERE cr.case_file_id = h.id) AS respondent_names
    FROM (
      SELECT c.id, c.case_number, c.summary, c.state::text AS state, c.created_at,
             to_char(coalesce(rcv.occurred_at, c.created_at) AT TIME ZONE ${tz}, 'YYYY-MM-DD')
               AS opened_on,
             (c.state = 'closed' OR c.closed_at IS NOT NULL) AS closed,
             (${numberCond}) AS on_number,
             ${partyOnCase(sql`cp.role = 'complainant'`, nameMatch(sql`p.full_name`, words))} AS on_complainant,
             ${partyOnCase(sql`cp.role = 'patient'`, nameMatch(sql`p.full_name`, words))} AS on_patient,
             ${partyOnCase(
               sql`cp.role IN ('respondent_dentist', 'respondent_establishment')`,
               nameMatch(sql`p.full_name`, words),
             )} AS on_dentist,
             (${email} <> '' AND ${partyOnCase(
               sql`true`,
               sql`p.email IS NOT NULL AND lower(p.email) = ${email}`,
             )}) AS on_email,
             (${phone} <> '' AND ${partyOnCase(
               sql`true`,
               sql`p.mobile_normalised LIKE ${`%${phone}`}`,
             )}) AS on_phone
      FROM case_file c
      LEFT JOIN LATERAL (
        SELECT m.occurred_at FROM case_milestone m
         WHERE m.case_file_id = c.id AND m.milestone = 'received'
         ORDER BY m.occurred_at LIMIT 1
      ) rcv ON true
      WHERE c.council_id = ${ctx.councilId}::uuid
        -- Cancelled as opened in error: never a complaint, never followed up.
        AND c.deleted_at IS NULL
    ) h
    WHERE h.on_number OR h.on_complainant OR h.on_patient OR h.on_dentist
       OR h.on_email OR h.on_phone
    -- Open cases first: a follow-up is far likelier to belong to one. Then newest.
    ORDER BY h.closed, h.created_at DESC
    LIMIT ${CASE_SEARCH_LIMIT}
  `);

  return rows.rows.map((r) => ({
    caseNumber: r.case_number,
    summary: withoutContacts(r.summary),
    state: r.state,
    openedOn: r.opened_on,
    closed: r.closed,
    complainantName: r.complainant_name,
    patientName: r.patient_name,
    respondentNames: r.respondent_names ?? [],
    matchedOn: [
      r.on_number && 'case number',
      r.on_complainant && 'complainant name',
      r.on_patient && 'patient name',
      r.on_dentist && 'dentist name',
      r.on_email && 'email address',
      r.on_phone && 'phone number',
    ].filter((m): m is string => Boolean(m)),
  }));
}

export async function getCase(
  tx: Tx,
  ctx: EngineContext,
  rawCaseNumber: unknown,
): Promise<CaseDetail | null> {
  const asWritten = cleanQuery(rawCaseNumber).toUpperCase();
  if (!asWritten) return null;
  // Exactly as written, or failing that in the register's own form: the numbers that reach
  // the assistant are the loosely written ones (see canonicalCaseNumber).
  const candidates = [...new Set([asWritten, canonicalCaseNumber(asWritten) ?? asWritten])];
  const tz = ctx.config.calendar.timezone;

  const found = await tx.execute<{
    id: string;
    case_number: string;
    summary: string;
    state: string;
    opened_on: string;
    closed_on: string | null;
    complainant_name: string | null;
    patient_name: string | null;
  }>(sql`
    SELECT c.id, c.case_number, c.summary, c.state::text AS state,
           to_char(coalesce(rcv.occurred_at, c.created_at) AT TIME ZONE ${tz}, 'YYYY-MM-DD')
             AS opened_on,
           to_char(c.closed_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS closed_on,
           (SELECT p.full_name FROM case_party cp JOIN party p ON p.id = cp.party_id
             WHERE cp.case_file_id = c.id AND cp.role = 'complainant'
             ORDER BY cp.created_at LIMIT 1) AS complainant_name,
           (SELECT p.full_name FROM case_party cp JOIN party p ON p.id = cp.party_id
             WHERE cp.case_file_id = c.id AND cp.role = 'patient'
             ORDER BY cp.created_at LIMIT 1) AS patient_name
    FROM case_file c
    LEFT JOIN LATERAL (
      SELECT m.occurred_at FROM case_milestone m
       WHERE m.case_file_id = c.id AND m.milestone = 'received'
       ORDER BY m.occurred_at LIMIT 1
    ) rcv ON true
    WHERE c.council_id = ${ctx.councilId}::uuid
      AND upper(c.case_number) = ANY(${pgTextArray(candidates)}::text[])
      -- A cancelled case is answered exactly as an unknown one. See the header.
      AND c.deleted_at IS NULL
    LIMIT 1
  `);
  const c = found.rows[0];
  if (!c) return null;

  // The clinic lives on the register of dentists when the dentist is in it, and otherwise
  // on the case_party note, where RespondentService.add() records it until the registry
  // import gives it a home. Read from both, so a clinic the officer typed is not lost here.
  const respondents = await tx.execute<{
    full_name: string;
    registration_no: string | null;
    clinic_name: string | null;
  }>(sql`
    SELECT p.full_name, rd.registration_no,
           coalesce(rd.clinic_name, nullif(btrim(substring(cp.note from 'Clinic: (.+)$')), ''))
             AS clinic_name
    FROM case_respondent cr
    JOIN case_party cp ON cp.id = cr.case_party_id
    JOIN party p ON p.id = cp.party_id
    LEFT JOIN registered_dentist rd ON rd.id = p.registered_dentist_id
    WHERE cr.case_file_id = ${c.id}::uuid
    ORDER BY cr.created_at
  `);

  // Subjects and dates only - never bodies. An outbound draft that never went is not a
  // letter the case has seen, so it is left out rather than shown undated.
  const letters = await tx.execute<{ direction: 'in' | 'out'; subject: string; date: string | null }>(sql`
    SELECT co.direction::text AS direction, co.subject,
           coalesce(to_char(coalesce(co.received_at, co.sent_at) AT TIME ZONE ${tz}, 'YYYY-MM-DD'),
                    to_char(co.despatch_date, 'YYYY-MM-DD')) AS date
    FROM correspondence co
    WHERE co.council_id = ${ctx.councilId}::uuid AND co.case_file_id = ${c.id}::uuid
      AND (co.direction = 'in' OR co.sent_at IS NOT NULL OR co.despatch_date IS NOT NULL)
    ORDER BY coalesce(co.received_at, co.sent_at, co.despatch_date::timestamptz, co.created_at) DESC
    LIMIT ${RECENT_LETTERS}
  `);

  return {
    caseNumber: c.case_number,
    summary: withoutContacts(c.summary),
    state: c.state,
    openedOn: c.opened_on,
    closedOn: c.closed_on,
    complainantName: c.complainant_name,
    patientName: c.patient_name,
    respondents: respondents.rows.map((r) => ({
      name: r.full_name,
      registrationNo: r.registration_no,
      clinicName: r.clinic_name,
    })),
    recentLetters: letters.rows.map((l) => ({
      direction: l.direction,
      // A subject is whatever the sender typed, and "please call 98450 12345" is a common
      // one. See the header.
      subject: withoutContacts(l.subject),
      date: l.date,
    })),
  };
}

/**
 * Dentists the register knows, through the same search the officer's "name a dentist"
 * box uses - so the model is offered exactly the people the officer would be, and picking
 * one joins this complaint to that dentist's history in the same way.
 *
 * READ AS A NAME FIRST. The officer's search is one "contains" over the whole string,
 * which suits a person typing "Gowda" into a box and does not suit a model, which writes
 * names as the playbook tells it to: "Dr Prashanth Gowda", or "Gowda Prashanth" when the
 * email put the surname first. Passed through as they stand, both find nothing, the
 * suggestion carries no match, and accepting it creates a SECOND record for a dentist the
 * register already holds - splitting their history, so "the third complaint against this
 * dentist" is never put in front of the committee. So a query with no digit in it is read
 * the way searchCases reads names: honorifics and punctuation dropped, the most telling
 * word (the longest) searched for, and only the candidates whose name holds every word
 * kept. A query with a digit is a registration number, written however the email wrote
 * it ("KA 12345" for "KA-12345"): its longest run of digits is searched for, and only the
 * candidates whose number holds the query's letters and digits are kept. Both rules are
 * text-rules.ts's, which the evaluation's lookups use too.
 *
 * The candidate's email and mobile are dropped here; see the header.
 */
export async function searchDentists(
  tx: Tx,
  ctx: EngineContext,
  respondents: RespondentService,
  rawQuery: unknown,
): Promise<DentistHit[]> {
  const q = cleanQuery(rawQuery);
  let found: Awaited<ReturnType<RespondentService['search']>>;
  if (/\d/.test(q)) {
    const run = (q.match(/\d+/g) ?? []).reduce((a, b) => (b.length > a.length ? b : a), '');
    if (run.length < 3) return [];
    found = (await respondents.search(tx, ctx, run)).filter((r) => registrationMatches(q, r.registrationNo));
  } else {
    const words = nameWords(q);
    if (words.length === 0) return [];
    const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
    found = (await respondents.search(tx, ctx, longest)).filter((r) => nameHasWords(r.fullName, words));
  }
  return found.map((r) => ({
    // RespondentService marks a register-only entry with an empty partyId: there is no
    // person row yet, and one is created when the officer names them.
    partyId: r.partyId || null,
    registeredDentistId: r.registeredDentistId,
    name: r.fullName,
    registrationNo: r.registrationNo,
    clinicName: r.clinicName,
    priorCases: r.priorCases,
    source: r.partyId ? 'seen_before' : 'register',
  }));
}
