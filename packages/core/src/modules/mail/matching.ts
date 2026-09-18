import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import { CASE_NUMBER_RE, type MailMatchRung } from '@ksdc/contracts';
import type { EngineContext } from '../followups/followup.service.js';
import { pgTextArray } from '../../common/pg-array.js';

/**
 * Deciding what a forwarded message belongs to.
 *
 * Three rungs, and only the first may act without a person.
 *
 *   1. A case number in the SUBJECT.  Files itself.
 *   2. A case number in the BODY.     Files itself.
 *   3. An address the register knows. SUGGESTS, and never more than that.
 *
 * Rung 3 is capped at a suggestion for a reason that is in the schema rather than in
 * policy: `CaseIntakeService.addParty` inserts a fresh `party` row for every case, so one
 * complainant with two complaints has two party rows carrying the same address, and
 * nothing distinguishes them. There is no ranking to be had. On top of that a `From`
 * address is trivially forged and nothing here checks SPF or DKIM, so auto-filing on the
 * sender would let an outsider write into a quasi-judicial record by guessing an address.
 *
 * It is also, honestly, the rung least likely to help: intake only ever records an email
 * for the complainant and the patient, so a respondent dentist's reply — the message this
 * was most wanted for — has no address on file to match against at all.
 */

export interface MatchCandidate {
  caseFileId: string;
  caseNumber: string;
  summary: string;
  isClosed: boolean;
  onHold: boolean;
  /** Why this case is being offered. Shown on the card. */
  because: string;
}

export interface MatchResult {
  /** Set only when the ladder is willing to act on its own. */
  autoFile: { caseFileId: string; rung: MailMatchRung } | null;
  /** Offered to the officer, best first. May be non-empty even when autoFile is set. */
  candidates: MatchCandidate[];
  /** Plain English, for the card. Null when there is nothing worth saying. */
  note: string | null;
}

/**
 * Every distinct case reference in a piece of text.
 *
 * A NEW RegExp each call. `CASE_NUMBER_RE_G` is a module-level object with the `g` flag,
 * and `.exec()` or `.test()` on a global regex advances `lastIndex` on that shared object —
 * so the second message scanned in the same process would start mid-string and silently
 * find nothing. `matchAll` is safe because it clones; `exec` is not.
 */
export function referencesIn(text: string): string[] {
  if (!text) return [];
  return [...new Set([...text.matchAll(new RegExp(CASE_NUMBER_RE.source, 'g'))].map((m) => m[0]))];
}

/**
 * Run the ladder.
 *
 * `subject` and `body` are searched separately and in that order, because the subject is
 * the stronger signal by a distance: in a reply the first token in the BODY is usually the
 * one inside the quoted original, and in a forwarded chain that has touched two matters it
 * can belong to a different case entirely.
 */
export async function matchMessage(
  tx: Tx,
  ctx: EngineContext,
  councilCode: string,
  args: { subject: string; body: string; senderAddresses: string[] },
): Promise<MatchResult> {
  const fromSubject = referencesIn(args.subject);
  const fromBody = referencesIn(args.body);

  // Only this council's references. CASE_NUMBER_RE accepts any council code, so a
  // reference from the Dental Council of India shaped 'NDC/COMP/2026-27/0042' parses as
  // structurally valid — and reporting that as a case of ours we cannot find would be a
  // confusing lie. Somebody else's reference is simply not a match.
  const ours = (refs: string[]) => refs.filter((r) => r.startsWith(`${councilCode.toUpperCase()}/`));
  const subjectRefs = ours(fromSubject);
  const bodyRefs = ours(fromBody);

  const foreign = [...fromSubject, ...fromBody].filter((r) => !ours([r]).length);

  // Subject before body, and the order is the whole point: in a reply the first token in
  // the BODY is usually the one inside the quoted original.
  const rungs: Array<{ refs: string[]; rung: MailMatchRung }> = [
    { refs: subjectRefs, rung: 'reference_subject' },
    { refs: bodyRefs, rung: 'reference_body' },
  ];

  for (const { refs, rung } of rungs) {
    if (refs.length === 0) continue;

    const found = await casesByNumber(tx, ctx, refs);
    if (found.length === 0) continue;

    // More than one DIFFERENT case named in one message is not a match, it is a question.
    // It happens: a respondent forwards the Council's letter about case A while writing
    // about case B, and whichever token the regex reached first would win.
    if (found.length > 1) {
      return {
        autoFile: null,
        candidates: found.map((c) => ({ ...c, because: `quotes ${c.caseNumber}` })),
        note:
          `This message names ${found.length} different cases (${found
            .map((c) => c.caseNumber)
            .join(', ')}). It has not been filed anywhere — say which one it belongs to.`,
      };
    }

    const only = found[0]!;

    // The token is right; the case is finished. Filing onto it would append to a record
    // the officer considers closed, and reopening it is their decision, not the matcher's.
    if (only.isClosed) {
      return {
        autoFile: null,
        candidates: [{ ...only, because: `quotes ${only.caseNumber}` }],
        note: `This quotes ${only.caseNumber}, which is closed. Filing it will add to a closed case.`,
      };
    }

    return {
      autoFile: { caseFileId: only.caseFileId, rung },
      candidates: [{ ...only, because: `quotes ${only.caseNumber}` }],
      note:
        rung === 'reference_subject'
          ? `Filed automatically: the subject quotes ${only.caseNumber}.`
          : `Filed automatically: the message quotes ${only.caseNumber}.`,
    };
  }

  // ── Rung 3. Suggestion only. ──────────────────────────────────────────────
  const bySender = await casesBySender(tx, ctx, args.senderAddresses);

  const note = foreign.length
    ? `This quotes ${foreign.join(', ')}, which is another authority's reference, not ours.`
    : bySender.length
      ? `${bySender.length === 1 ? 'One case has' : `${bySender.length} cases have`} this ` +
        'sender on file. Check before filing — the address alone does not prove which.'
      : null;

  return { autoFile: null, candidates: bySender, note };
}

/** Rung 1 and 2: the reference token. Index hit on case_file_number_uq. */
async function casesByNumber(
  tx: Tx,
  ctx: EngineContext,
  refs: string[],
): Promise<MatchCandidate[]> {
  const rows = await tx.execute<{
    id: string;
    case_number: string;
    summary: string;
    is_closed: boolean;
    on_hold: boolean;
  }>(sql`
    SELECT c.id, c.case_number, c.summary,
           (c.closed_at IS NOT NULL) AS is_closed, c.on_hold
    FROM case_file c
    WHERE c.council_id = ${ctx.councilId}::uuid
      AND c.case_number = ANY(${pgTextArray(refs)}::text[])
      AND c.deleted_at IS NULL
  `);
  return rows.rows.map((r) => ({
    caseFileId: r.id,
    caseNumber: r.case_number,
    summary: r.summary,
    isClosed: r.is_closed,
    onHold: r.on_hold,
    because: '',
  }));
}

/**
 * Rung 3: an address the register has seen, either on a party or on a letter.
 *
 * `lower()` on both sides because `party.email` is stored exactly as it was typed at
 * intake — there is no normalisation and no unique constraint — so 'Kdevi@Example.in'
 * and 'kdevi@example.in' are two different strings to Postgres. Migration 0013 adds the
 * matching expression index.
 */
async function casesBySender(
  tx: Tx,
  ctx: EngineContext,
  addresses: string[],
): Promise<MatchCandidate[]> {
  const usable = addresses.filter(Boolean).map((a) => a.toLowerCase());
  if (usable.length === 0) return [];

  const rows = await tx.execute<{
    id: string;
    case_number: string;
    summary: string;
    is_closed: boolean;
    on_hold: boolean;
    why: string;
  }>(sql`
    SELECT c.id, c.case_number, c.summary,
           (c.closed_at IS NOT NULL) AS is_closed, c.on_hold,
           min(src.why) AS why
    FROM case_file c
    JOIN LATERAL (
      SELECT 'is a party on this case'::text AS why
      FROM case_party cp JOIN party p ON p.id = cp.party_id
      WHERE cp.case_file_id = c.id
        AND p.email IS NOT NULL
        AND lower(p.email) = ANY(${pgTextArray(usable)}::text[])
      UNION ALL
      SELECT 'has written on this case before'::text
      FROM correspondence co
      WHERE co.case_file_id = c.id
        AND (lower(co.from_email) = ANY(${pgTextArray(usable)}::text[])
          OR lower(co.to_email)   = ANY(${pgTextArray(usable)}::text[]))
    ) src ON true
    WHERE c.council_id = ${ctx.councilId}::uuid
      AND c.deleted_at IS NULL
    GROUP BY c.id, c.case_number, c.summary, c.closed_at, c.on_hold
    ORDER BY (c.closed_at IS NOT NULL), c.waiting_since DESC
    LIMIT 5
  `);

  return rows.rows.map((r) => ({
    caseFileId: r.id,
    caseNumber: r.case_number,
    summary: r.summary,
    isClosed: r.is_closed,
    onHold: r.on_hold,
    because: r.why,
  }));
}
