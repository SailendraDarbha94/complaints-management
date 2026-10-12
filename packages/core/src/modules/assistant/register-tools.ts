import { sql, type SQL } from 'drizzle-orm';
import { withCouncil, type Tx } from '@ksdc/db';
import type { EngineContext } from '../followups/followup.service.js';
import type { RespondentService } from '../cases/respondent.service.js';
import type { StoragePort } from '../documents/storage.js';
import { Logger } from '../../common/logger.js';
import { pgTextArray } from '../../common/pg-array.js';
import { overEmailBudget, type EmailFilesSent } from './attachment-budget.js';
import {
  canonicalCaseNumber,
  nameHasWords,
  nameWords,
  registrationMatches,
  withoutContacts,
} from './text-rules.js';
import type {
  AttachmentReadRecord,
  AttachmentReadResult,
  CaseDetail,
  CaseSearchHit,
  DentistHit,
  TriageTools,
} from './types.js';

/**
 * The lookups the model may make, answered from the register - and the one file reader.
 *
 * READ-ONLY, all four, and that is the whole of stage 1's safety argument: nothing the
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
 *
 * THE FILE READER (readAttachment) is the one tool whose answer leaves the building: what
 * it returns is sent to Anthropic. So it opens only the files of the ONE message being
 * read - never another's, whatever ref the model writes - and only when the reader is
 * switched on and within its budgets (how many files, and what they add up to), all
 * checked here as well as in the engine, which is meant to stop first. These checks are the floor beneath the engine's, so that a fault
 * there cannot send what the configuration says must not go. Its database lookup is a
 * short scope like the others; the file itself is fetched from the store with NO
 * transaction open, because a twenty-megabyte scan can take seconds to arrive. And what is
 * in a file is never logged - not its text, not its bytes, not its name - only ids.
 */

/** Enough to choose between, few enough that a list of them stays cheap to send. */
export const CASE_SEARCH_LIMIT = 8;
/** Letters on a case shown to the model: the recent ones are what a follow-up answers. */
const RECENT_LETTERS = 10;
/** A query is a name, a number or an address - never an essay. */
const MAX_QUERY = 200;

const log = new Logger('assistant:files');

/** What the file reader needs: whose files, from where, and how much of each. */
export interface AttachmentAccess {
  /** The message being read. Its attachments - and no other message's - can be opened. */
  mailMessageId: string;
  storage: StoragePort;
  /** MAIL_ASSISTANT_ATTACHMENTS=on. Off, every request is refused. */
  enabled: boolean;
  /** MAIL_ASSISTANT_MAX_ATTACHMENT_READS: files handed over for this message, at most. */
  maxReads: number;
  /** MAIL_ASSISTANT_MAX_PDF_PAGES: a longer PDF is cut to this many pages first. */
  maxPdfPages: number;
  /**
   * Told of each file BEFORE it is handed over for the model, and awaited: if it throws,
   * the file is not handed over. The engine reports what it sent; this is how the service
   * records what MAY have gone while the reading is still under way - so a reading cut off
   * part-way, or an engine that throws, still leaves the record of what left.
   */
  onRead?: (record: AttachmentReadRecord) => void | Promise<void>;
}

export function registerTools(
  ctx: EngineContext,
  respondents: RespondentService,
  files: AttachmentAccess,
): TriageTools {
  const scope = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withCouncil({ councilId: ctx.councilId, userId: ctx.userId ?? null }, fn);

  // Files handed over so far, counting one the moment it is asked for: the engine may ask
  // for two at once, and a count taken only after each arrived would let both through at
  // the limit. A request that comes to nothing gives its place back.
  let taken = 0;
  // What the files handed over add up to, against the email's budget - the engine's own
  // rule (attachment-budget.ts), applied BEFORE a file is handed over and written onto the
  // suggestion, so that the reader never passes a file the engine would then refuse.
  const sent: EmailFilesSent = { bytes: 0, pdfPages: 0 };

  return {
    searchCases: (query) => scope((tx) => searchCases(tx, ctx, query)),
    getCase: (caseNumber) => scope((tx) => getCase(tx, ctx, caseNumber)),
    searchDentists: (query) => scope((tx) => searchDentists(tx, ctx, respondents, query)),
    readAttachment: async (ref) => {
      if (!files.enabled) {
        return {
          ok: false,
          reason:
            'Reading attachments is switched off for this installation (MAIL_ASSISTANT_ATTACHMENTS), ' +
            'so only their names can be seen.',
        };
      }
      if (taken >= files.maxReads) {
        return {
          ok: false,
          reason:
            `At most ${files.maxReads} attachment(s) are read for one email, and that many have ` +
            'been read already. Decide on what has been read, or say what is missing.',
        };
      }
      taken++;
      const result = await readAttachment(ctx, scope, files, ref, sent).catch((err: unknown) => {
        log.error(
          `reading an attachment of message ${files.mailMessageId} failed: ${errorKind(err)}`,
        );
        return { ok: false as const, reason: 'That attachment could not be read just now.' };
      });
      if (!result.ok) taken--;
      return result;
    },
  };
}

// ─── Attachments ─────────────────────────────────────────────────────────────

/** One file on a message, as the reader and the service both see it. */
export interface MessageAttachment {
  /** 'a1', 'a2'... - the handle the model asks for it by. See attachmentsOf. */
  ref: string;
  id: string;
  filename: string;
  declaredType: string | null;
  /** Where the bytes wait while the message is in the tray. Stale once documentId is set. */
  stagingKey: string | null;
  documentId: string | null;
  /** Set when the register refused the file at ingest: there are no bytes to read. */
  skippedReason: string | null;
  /** The document's current version, when the file has become a case document. */
  documentKey: string | null;
  documentStatus: string | null;
}

/**
 * The message's attachments, each with its ref - THE one place refs are given out.
 *
 * The service lists these for the model and the reader resolves a ref against the same
 * list, built by this same query, so "a2" is always the same file to both: given out by
 * one rule and looked up by another, a ref could open a different file from the one the
 * model was shown the name of.
 *
 * Ordered by (created_at, id). Stable - the same message always lists the same way - but
 * not necessarily the email's own order: every attachment of a message is written in the
 * one ingest transaction and so shares its created_at, and the id that breaks the tie is
 * random. The model is shown each ref beside its filename, so the order is a convenience
 * and the stability is the rule.
 *
 * Every row, refused ones included, so the model is told a file came even when the
 * register did not keep it - a refused .docx is still a clue that the complaint is in it.
 */
export async function attachmentsOf(
  tx: Tx,
  ctx: EngineContext,
  mailMessageId: string,
): Promise<MessageAttachment[]> {
  const rows = await tx.execute<{
    id: string;
    filename: string;
    declared_type: string | null;
    staging_key: string | null;
    document_id: string | null;
    skipped_reason: string | null;
    document_key: string | null;
    document_status: string | null;
  }>(sql`
    SELECT a.id, a.filename, a.declared_type, a.staging_key, a.document_id, a.skipped_reason,
           dv.storage_key AS document_key, d.status::text AS document_status
    FROM mail_attachment a
    LEFT JOIN document d ON d.id = a.document_id AND d.council_id = a.council_id
    LEFT JOIN document_version dv ON dv.id = d.current_version_id
    WHERE a.council_id = ${ctx.councilId}::uuid AND a.mail_message_id = ${mailMessageId}::uuid
    ORDER BY a.created_at, a.id
  `);
  return rows.rows.map((r, i) => ({
    ref: `a${i + 1}`,
    id: r.id,
    filename: r.filename,
    declaredType: r.declared_type,
    stagingKey: r.staging_key,
    documentId: r.document_id,
    skippedReason: r.skipped_reason,
    documentKey: r.document_key,
    documentStatus: r.document_status,
  }));
}

/**
 * One attachment's contents, for the model - or why not, in words it can pass on.
 *
 * Where the bytes are depends on how far the message has got. In the tray they are at the
 * staging key. Once the message is filed they have MOVED to the case document's own key
 * and the staging key still names where they were - so the document is looked at first,
 * and the staging key only when there is none. That also covers a message back in the
 * tray from a case cancelled as opened in error: its files are documents on that case.
 *
 * Whatever the file turns out to be, prepareAttachment decides whether it can be read - the
 * same function the evaluation uses, so the two can never disagree about what is readable.
 */
async function readAttachment(
  ctx: EngineContext,
  scope: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  files: AttachmentAccess,
  rawRef: unknown,
  sent: EmailFilesSent,
): Promise<AttachmentReadResult> {
  const ref = cleanQuery(rawRef).toLowerCase();

  // The lookup, in its own short scope - and only this message's files are in it.
  const list = await scope((tx) => attachmentsOf(tx, ctx, files.mailMessageId));
  const a = list.find((x) => x.ref === ref);
  if (!a) {
    return {
      ok: false,
      reason:
        list.length === 0
          ? 'This email has no attachments.'
          : `There is no attachment "${ref.slice(0, 20)}" on this email. Its attachments are ` +
            `${list.length === 1 ? 'a1' : `a1 to a${list.length}`}.`,
    };
  }

  if (a.skippedReason) {
    // The register's own words for why, which the model can pass on ("over the 50 MB
    // limit", "another email attached - read it in the mailbox"). Cut short, because for an
    // attached email they quote its subject and sender, which whoever sent it chose.
    return {
      ok: false,
      reason:
        'The register did not keep this file, so it cannot be read. Why: ' +
        a.skippedReason.slice(0, 300),
    };
  }

  let key: string | null;
  if (a.documentId) {
    // Withdrawn as misfiled: the officer said it is not this complainant's, and nothing
    // reads from quarantine - not a case sheet, not a bundle, and not this.
    if (a.documentStatus !== 'stored') {
      return {
        ok: false,
        reason: 'This file was withdrawn from the case as misfiled, so it is not read.',
      };
    }
    key = a.documentKey;
  } else {
    key = a.stagingKey;
  }
  if (!key) {
    return { ok: false, reason: 'The register has no copy of this file to read.' };
  }

  // The store, with no transaction open.
  let bytes: Buffer;
  try {
    bytes = await files.storage.read(key);
  } catch (err) {
    log.warn(`attachment ${a.id} of message ${files.mailMessageId} could not be fetched: ${errorKind(err)}`);
    return {
      ok: false,
      reason: 'This file could not be fetched from the file store just now. Try again later.',
    };
  }

  // Loaded on first use, as the engine is (assistant.service.ts): every route handler
  // constructs these tools' service, and none of them should load a PDF library to do it.
  const { prepareAttachment } = await import('./attachment-prep.js');
  const prepared = await prepareAttachment(bytes, { maxPdfPages: files.maxPdfPages });
  if (!prepared.ok) return prepared;

  // The email's budget, by the engine's own rule - checked and taken in one synchronous
  // step, so two reads in flight cannot both fit into the last of it.
  const file = { bytes: prepared.data.length, pdfPages: prepared.pagesSent };
  const over = overEmailBudget(sent, file);
  if (over) {
    return {
      ok: false,
      reason:
        over === 'bytes'
          ? 'This file is too large to send together with the files already read for this email.'
          : 'This file has too many pages to send together with the files already read for this email.',
    };
  }
  sent.bytes += file.bytes;
  sent.pdfPages += file.pdfPages ?? 0;

  // Recorded first, handed over second: a file whose going cannot be written down does
  // not go (the caller turns the failure into a refusal), and gives its budget back.
  try {
    await files.onRead?.({
      ref: a.ref,
      filename: a.filename,
      pagesSent: prepared.pagesSent,
      pagesTotal: prepared.pagesTotal,
    });
  } catch (err) {
    sent.bytes -= file.bytes;
    sent.pdfPages -= file.pdfPages ?? 0;
    throw err;
  }
  return prepared;
}

/** The kind of an error, never its message: a store's or a parser's can quote the file. */
function errorKind(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return `${err.name}${typeof code === 'string' ? ` ${code}` : ''}`;
  }
  return 'unknown error';
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
