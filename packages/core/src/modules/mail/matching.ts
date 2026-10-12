import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import { CASE_NUMBER_RE, type CorrespondenceKind, type MailMatchRung } from '@ksdc/contracts';
import type { EngineContext } from '../followups/followup.service.js';
import { pgTextArray } from '../../common/pg-array.js';
import {
  comparableName,
  sameSubject,
  sideOf,
  sideOfRole,
  type CopyDateBasis,
  type CouncilCopyRecipient,
} from './council-copy.js';

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

  const senderNote = bySender.length
    ? `${bySender.length === 1 ? 'One case has' : `${bySender.length} cases have`} this ` +
      'sender on file. Check before filing — the address alone does not prove which.'
    : null;

  // Our own reference, on a case cancelled as opened in error. It is never filed there -
  // casesByNumber leaves cancelled cases out, so nothing above could match it - but it is
  // said, because it is the likeliest reason a reply quoting a perfectly good number did
  // not file itself: the complainant answering the acknowledgement sent from a duplicate.
  const cancelled = await cancelledByNumber(tx, ctx, [...subjectRefs, ...bodyRefs]);
  if (cancelled.length) {
    return {
      autoFile: null,
      candidates: bySender,
      note:
        `This quotes ${cancelled.join(', ')}, which was cancelled as opened in error, so it ` +
        'has not been filed there.' +
        (senderNote ? ` ${senderNote}` : ''),
    };
  }

  const note = foreign.length
    ? `This quotes ${foreign.join(', ')}, which is another authority's reference, not ours.`
    : senderNote;

  return { autoFile: null, candidates: bySender, note };
}

// ─── Copies of the Council's own letters ─────────────────────────────────────

/**
 * How the case number a copy quotes compares with the person the letter went to.
 *
 *   confirmed     the number names a case, and the recipient is on that case
 *   mismatch      the number names one case, the recipient is on another
 *   unverified    the number names a case, the recipient is on file on none
 *   by_recipient  no number of ours; the case was found from the recipient alone
 *   none          neither found anything
 */
export type CouncilCopyCheck = 'confirmed' | 'mismatch' | 'unverified' | 'by_recipient' | 'none';

export interface CouncilCopyMatch {
  /**
   * Set only when the number and the recipient agree on one live, open case. Even then the
   * copy files itself only if that case already records the letter as sent - see
   * MailIntakeService.ingest - so this is a candidate for filing, not a decision.
   */
  autoFileCandidate: { caseFileId: string; rung: MailMatchRung } | null;
  candidates: MatchCandidate[];
  note: string | null;
  check: CouncilCopyCheck;
}

/** "ravi@x.com", "ravi@x.com and s@y.in", "a@x, b@y and c@z". */
function listed(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Find the case a copy of the Council's own letter belongs to.
 *
 * A copy is not a reply, and the ladder above is wrong for it in two ways. Its sender is the
 * Council, so the sender rung finds nothing; the person who identifies the case is the one
 * it was SENT to. And its case number is the officer's own typing, so a slip - 0042 for
 * 0045 - would file the Council's letter on somebody else's case without a question. So
 * the number is checked against the recipient: they agree, and the copy may file itself;
 * they disagree, and the officer is asked, with both cases named. With no number, the
 * recipient alone suggests a case and never files one, for the reason rung 3 never does.
 *
 * Subject before body, and only this council's numbers, exactly as matchMessage.
 */
export async function matchCouncilCopy(
  tx: Tx,
  ctx: EngineContext,
  councilCode: string,
  args: { subject: string; body: string; recipients: string[] },
): Promise<CouncilCopyMatch> {
  const fromSubject = referencesIn(args.subject);
  const fromBody = referencesIn(args.body);
  const ours = (refs: string[]) => refs.filter((r) => r.startsWith(`${councilCode.toUpperCase()}/`));
  const subjectRefs = ours(fromSubject);
  const bodyRefs = ours(fromBody);
  const foreign = [...fromSubject, ...fromBody].filter((r) => !ours([r]).length);

  const sentTo = listed(
    args.recipients.length ? args.recipients.map((a) => a.toLowerCase()) : ['nobody outside the Council'],
  );

  const rungs: Array<{ refs: string[]; rung: MailMatchRung }> = [
    { refs: subjectRefs, rung: 'reference_subject' },
    { refs: bodyRefs, rung: 'reference_body' },
  ];

  for (const { refs, rung } of rungs) {
    if (refs.length === 0) continue;
    const found = await casesByNumber(tx, ctx, refs);
    if (found.length === 0) continue;

    if (found.length > 1) {
      return {
        autoFileCandidate: null,
        candidates: found.map((c) => ({ ...c, because: `quotes ${c.caseNumber}` })),
        note:
          `This copy of a Council letter names ${found.length} different cases (` +
          `${found.map((c) => c.caseNumber).join(', ')}). It has not been filed - open it ` +
          'and say which case it belongs to.',
        check: 'unverified',
      };
    }

    const only = found[0]!;
    const quoted = { ...only, because: `quotes ${only.caseNumber}` };
    // The quoted case is asked about directly, never looked for in a short list of the
    // recipient's cases: a clinic or a dentist written to on many complaints would push it
    // off that list, and the copy would be reported as sent to the wrong person.
    const onIt = await casesByRecipient(tx, ctx, args.recipients, { onlyCaseFileId: only.caseFileId });
    const elsewhere = await casesByRecipient(tx, ctx, args.recipients, { excludeCaseFileId: only.caseFileId });
    // Only a PARTY on another case contradicts the number. An address an earlier letter
    // went to is weaker: an authority or an expert body is written to on many cases and is
    // a party on none, and once one copy to it is filed, every later copy to it would
    // otherwise be reported as quoting the wrong case.
    const partyElsewhere = elsewhere.filter((c) => c.viaParty);

    if (onIt.length > 0) {
      if (only.isClosed) {
        return {
          autoFileCandidate: null,
          candidates: [quoted],
          note:
            `This is a copy of a letter the Council sent to ${listed(onIt.map((c) => c.address))}, ` +
            `on ${only.caseNumber}, which is closed. Filing it will add to a closed case.`,
          check: 'confirmed',
        };
      }
      return {
        autoFileCandidate: { caseFileId: only.caseFileId, rung },
        candidates: [quoted],
        note:
          `This is a copy of a letter the Council sent to ${listed(onIt.map((c) => c.address))}, ` +
          `who is on ${only.caseNumber}.`,
        check: 'confirmed',
      };
    }

    const plain = (cs: typeof elsewhere): MatchCandidate[] =>
      cs.map(({ address: _a, viaParty: _p, ...c }) => c);

    if (partyElsewhere.length > 0) {
      const people = [...new Set(partyElsewhere.map((c) => c.address))];
      const cases = partyElsewhere.map((c) => c.caseNumber);
      return {
        autoFileCandidate: null,
        candidates: [quoted, ...plain(partyElsewhere)],
        note:
          `This is a copy of a letter the Council sent. It quotes ${only.caseNumber}, but it ` +
          `was sent to ${listed(people)}, who ${people.length === 1 ? 'is' : 'are'} on ` +
          `${listed(cases)}. It has not been filed. Check which case it belongs to, and ` +
          'whether the letter went to the right person.' +
          (only.isClosed ? ` ${only.caseNumber} is closed.` : ''),
        check: 'mismatch',
      };
    }

    if (elsewhere.length > 0) {
      const addresses = [...new Set(elsewhere.map((c) => c.address))];
      return {
        autoFileCandidate: null,
        candidates: [quoted, ...plain(elsewhere)],
        note:
          `This is a copy of a letter the Council sent. It quotes ${only.caseNumber}, but ` +
          `${listed(addresses)}, who it was sent to, ${addresses.length > 1 ? 'are' : 'is'} not ` +
          `on file on ${only.caseNumber}. Letters on ${listed(elsewhere.map((c) => c.caseNumber))} ` +
          'went to the same address, though nobody with it is a party there, so the number ' +
          'could not be checked against the person it went to. Open it to check, and file it.' +
          (only.isClosed ? ` ${only.caseNumber} is closed.` : ''),
        check: 'unverified',
      };
    }

    return {
      autoFileCandidate: null,
      candidates: [quoted],
      note:
        `This is a copy of a letter the Council sent. It quotes ${only.caseNumber}, but ` +
        `${sentTo}, who it was sent to, ${args.recipients.length > 1 ? 'are' : 'is'} not on ` +
        'file on any case, so the number could not ' +
        'be checked against the person it went to. Open it to check, and file it.' +
        (only.isClosed ? ` ${only.caseNumber} is closed.` : ''),
      check: 'unverified',
    };
  }

  // No number of ours that resolves. What matchMessage would have said about the numbers
  // it did find is said here too, ahead of what the recipient suggests.
  const cancelled = await cancelledByNumber(tx, ctx, [...subjectRefs, ...bodyRefs]);
  const aboutNumbers = cancelled.length
    ? `This quotes ${cancelled.join(', ')}, which was cancelled as opened in error, so it has ` +
      'not been filed there. '
    : foreign.length
      ? `This quotes ${foreign.join(', ')}, which is another authority's reference, not ours. `
      : '';
  const byRecipient = await casesByRecipient(tx, ctx, args.recipients);
  const candidates = byRecipient.map(({ address: _a, viaParty: _p, ...c }) => c);

  if (byRecipient.length === 1) {
    const s = byRecipient[0]!;
    return {
      autoFileCandidate: null,
      candidates,
      note:
        `${aboutNumbers}This is a copy of a letter the Council sent to ${s.address}, who is on ` +
        `${s.caseNumber}. Open it to check, and file it there.`,
      check: 'by_recipient',
    };
  }
  if (byRecipient.length > 1) {
    return {
      autoFileCandidate: null,
      candidates,
      note:
        `${aboutNumbers}This is a copy of a letter the Council sent to ${sentTo}, who is on ` +
        `${byRecipient.length} cases (${listed(byRecipient.map((c) => c.caseNumber))}). Open it ` +
        'and say which one it belongs to.',
      check: 'by_recipient',
    };
  }
  return {
    autoFileCandidate: null,
    candidates: [],
    note:
      `${aboutNumbers}This is a copy of a letter the Council sent to ${sentTo}. No case has ` +
      'that address on file - open it and choose the case it belongs to.',
    check: 'none',
  };
}

/**
 * Live cases on which one of these addresses is on file: on a party, or as the address an
 * outgoing letter went to. `address` is which of them matched, for the note; `viaParty`
 * says it matched a PARTY, which is what lets a recipient contradict a quoted case number
 * (see matchCouncilCopy).
 *
 * `onlyCaseFileId` asks about one case, uncapped - whether the person is on THAT case must
 * never depend on how many other cases they are on. `excludeCaseFileId` leaves one out. The
 * list otherwise stops at five, for the officer to choose from.
 *
 * Explicit council_id on every table as well as row-level security, as assertCaseLive does.
 * Closed cases are included (and put last): a copy of a closure letter belongs to a closed
 * case, and the officer is told it is closed rather than shown nothing.
 */
export async function casesByRecipient(
  tx: Tx,
  ctx: EngineContext,
  addresses: string[],
  opts: { onlyCaseFileId?: string; excludeCaseFileId?: string } = {},
): Promise<Array<MatchCandidate & { address: string; viaParty: boolean }>> {
  const usable = [...new Set(addresses.filter(Boolean).map((a) => a.toLowerCase()))];
  if (usable.length === 0) return [];
  const only = opts.onlyCaseFileId ?? null;
  const exclude = opts.excludeCaseFileId ?? null;

  const rows = await tx.execute<{
    id: string;
    case_number: string;
    summary: string;
    is_closed: boolean;
    on_hold: boolean;
    address: string;
    via_party: boolean;
  }>(sql`
    SELECT c.id, c.case_number, c.summary,
           (c.closed_at IS NOT NULL) AS is_closed, c.on_hold,
           coalesce(min(src.address) FILTER (WHERE src.party), min(src.address)) AS address,
           bool_or(src.party) AS via_party
    FROM case_file c
    JOIN LATERAL (
      SELECT lower(p.email) AS address, true AS party
      FROM case_party cp JOIN party p ON p.id = cp.party_id
      WHERE cp.case_file_id = c.id
        AND cp.council_id = ${ctx.councilId}::uuid
        AND p.council_id = ${ctx.councilId}::uuid
        AND p.email IS NOT NULL
        AND lower(p.email) = ANY(${pgTextArray(usable)}::text[])
      UNION ALL
      SELECT lower(co.to_email), false
      FROM correspondence co
      WHERE co.case_file_id = c.id
        AND co.council_id = ${ctx.councilId}::uuid
        AND co.direction = 'out'::contact_direction
        AND co.to_email IS NOT NULL
        AND lower(co.to_email) = ANY(${pgTextArray(usable)}::text[])
    ) src ON true
    WHERE c.council_id = ${ctx.councilId}::uuid
      AND c.deleted_at IS NULL
      AND (${only}::uuid IS NULL OR c.id = ${only}::uuid)
      AND (${exclude}::uuid IS NULL OR c.id <> ${exclude}::uuid)
    GROUP BY c.id, c.case_number, c.summary, c.closed_at, c.on_hold, c.waiting_since
    ORDER BY (c.closed_at IS NOT NULL), c.waiting_since DESC NULLS LAST, c.case_number
    LIMIT 5
  `);

  return rows.rows.map((r) => ({
    caseFileId: r.id,
    caseNumber: r.case_number,
    summary: r.summary,
    isClosed: r.is_closed,
    onHold: r.on_hold,
    because: r.via_party
      ? 'the letter was sent to a party on this case'
      : 'an earlier letter on this case went to the same address',
    address: r.address,
    viaParty: r.via_party,
  }));
}

/** An outgoing letter on a case that a copy could be the copy of. */
export interface RecordedLetter {
  id: string;
  kind: CorrespondenceKind;
  subject: string;
  sentAt: Date | null;
  createdAt: Date;
  toName: string | null;
  toEmail: string | null;
  /** A copy of it is already filed (a mail message links to it). */
  copied: boolean;
  /**
   * Whether it went to the person the copy went to: 'yes' when its address or addressee is
   * theirs, 'no' when it went to somebody else on the case, 'unknown' when nothing says.
   */
  addressed: 'yes' | 'no' | 'unknown';
  /**
   * The letter names its addressee on the case - a dentist a notice was counted against, or
   * a party its address or name is on file for. A copy that cannot be placed as that person
   * is never "sure" to be its copy.
   */
  knownAddressee: boolean;
}

/**
 * What a case records of the letter a copy is a copy of.
 *
 *   sent   the letter it is most likely the copy of, and `how` that was decided:
 *            match           recorded as sent around the copy's date, with no copy yet
 *            already_copied  recorded as sent around the copy's date, and a copy of it is
 *                            already on file
 *            earlier         recorded as sent, but well before a copy that only says when it
 *                            was FORWARDED - perhaps this letter, forwarded late; perhaps an
 *                            earlier one. Never for a copy whose date is real (see previous).
 *   sure   `sent` is a match that cannot be another letter: no other letter around the copy's
 *          date fits as well, copied or not; it is the kind the copy is, when that is known;
 *          and when the letter names its addressee, the copy went to that person. Only then
 *          may a copy file itself without the officer.
 *   draft  drafted and never marked sent, best first in `drafts`; recording the copy "as
 *          sent" uses it, so the case does not end up with the draft and a second letter.
 */
export interface RecordedLetterMatch {
  sent: RecordedLetter | null;
  how: 'match' | 'already_copied' | 'earlier' | null;
  sure: boolean;
  /**
   * Why a 'match' or an 'already_copied' letter may not be the one, for the officer - so
   * neither is taken without them: another letter around then fits as well
   * ('several'), it is a different letter that only shares the subject ('other_kind'), or
   * it names an addressee the copy cannot be placed as ('addressee').
   */
  unsure: 'several' | 'other_kind' | 'addressee' | null;
  /**
   * A letter like it, recorded well before a copy whose date is real - for a sentence, never
   * as the letter it is the copy of. A Cc or Bcc copy dated 10 Oct is a letter sent on
   * 10 Oct; the hearing notice for the August sitting is a different letter.
   */
  previous: RecordedLetter | null;
  draft: RecordedLetter | null;
  /** Every same-kind draft, best first; ones addressed to somebody else last. */
  drafts: RecordedLetter[];
}

/** How far before (and, for a real date, after) a copy's date its letter may have gone out. */
const COPY_WINDOW_MS = 14 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

/**
 * The letter on a case that a copy is a copy of, if the case has recorded it.
 *
 * A letter is a candidate when it is outgoing and of the same kind - or, when the kind is
 * not known or differs, carries the same subject once Fwd:/Re:, case and spacing are set
 * aside.
 *
 * WHO IT WENT TO decides between candidates, before anything else. A case can name two
 * dentists, and each gets a notice of the same kind, often on the same day; matched on kind
 * and date alone, the copy of Dr B's notice was attached to Dr A's, as proof of service of
 * the wrong letter. So a letter that went to somebody else on the case is never the one,
 * and one that went to this recipient is preferred to one nothing is known about.
 *
 * WHEN is the copy's date (copyWhenOf), and how far it can be trusted matters:
 *   - a real date: the letter went out within a fortnight either side of it;
 *   - only the date of the forward ('forwarded'): the letter went out then or EARLIER, so
 *     a fortnight before it to a day after.
 * For the second only, a letter recorded earlier than that is still offered (`earlier`),
 * never as a sure match: a request for documents sent in May and another in October are two
 * letters, and an October forward may be either. For a real date it is not: the copy says
 * when its letter went out, and an older letter of the kind is mentioned (`previous`) but
 * never taken for it. One in the window that already has a copy on file is offered
 * (`already_copied`) - a second copy of a recorded letter is still that letter, and must
 * never be mistaken for one the case does not record, which would record it twice.
 */
export async function findRecordedLetter(
  tx: Tx,
  ctx: EngineContext,
  caseFileId: string,
  args: {
    kind: CorrespondenceKind | null;
    subject: string | null;
    date: Date;
    basis?: CopyDateBasis;
    recipients?: ReadonlyArray<CouncilCopyRecipient>;
  },
): Promise<RecordedLetterMatch> {
  const rows = await tx.execute<{
    id: string;
    kind: CorrespondenceKind;
    subject: string;
    sent_at: Date | string | null;
    created_at: Date | string;
    to_name: string | null;
    to_email: string | null;
    copied: boolean;
    notice_parties: string | null;
  }>(sql`
    SELECT co.id, co.kind::text AS kind, co.subject, co.sent_at, co.created_at,
           co.to_name, co.to_email,
           EXISTS (
             SELECT 1 FROM mail_message mm
             WHERE mm.council_id = ${ctx.councilId}::uuid AND mm.correspondence_id = co.id
           ) AS copied,
           (SELECT string_agg(cp.party_id::text, ',')
              FROM respondent_notice rn
              JOIN case_respondent cr ON cr.id = rn.case_respondent_id
              JOIN case_party cp ON cp.id = cr.case_party_id
             WHERE rn.council_id = ${ctx.councilId}::uuid AND rn.correspondence_id = co.id
           ) AS notice_parties
    FROM correspondence co
    WHERE co.council_id = ${ctx.councilId}::uuid
      AND co.case_file_id = ${caseFileId}::uuid
      AND co.direction = 'out'::contact_direction
  `);

  const recipients = args.recipients ?? [];
  const parties = recipients.length ? await partiesOnCase(tx, ctx, caseFileId) : [];
  const partyById = new Map(parties.map((p) => [p.partyId, p]));
  const recipientEmails = new Set(recipients.map((r) => r.email.toLowerCase()));
  const recipientNames = new Set(recipients.map((r) => comparableName(r.name)).filter(Boolean));

  // Each letter's addressees on the case: the dentist a notice was counted against, and
  // whoever on the case has its address or its addressee's name.
  //
  // Its stored to_name and to_email are not always the real addressee. The hearing notice
  // to the dentist was drafted addressed to the complainant (CorrespondenceService's
  // recipientFor sent every kind not starting "respondent_" to the complainant), and rows
  // written that way are still on file. So a letter whose kind says which side it is
  // written to is not taken at its stored addressee when that names somebody on the other
  // side: only its notice record then says who it went to.
  const read = rows.rows.map((r) => {
    const side = sideOf(r.kind);
    const storedEmail = r.to_email?.toLowerCase() ?? null;
    const storedName = comparableName(r.to_name);
    const named = parties.filter(
      (p) => (storedEmail && p.email === storedEmail) || (storedName && comparableName(p.name) === storedName),
    );
    const trusted =
      !side ||
      !named.some((p) => {
        const theirs = sideOfRole(p.role);
        return theirs !== null && theirs !== side;
      });
    const addressees = new Set([
      ...(r.notice_parties ? r.notice_parties.split(',') : []),
      ...(trusted ? named.map((p) => p.partyId) : []),
    ]);
    return { r, side, toEmail: trusted ? storedEmail : null, toName: trusted ? storedName : '', addressees };
  });

  // The people on the case the copy went to: by address, by the name it was sent under, or
  // by an earlier letter to the same address that named them. The register writes a
  // dentist's address only onto the letters recorded from copies, never onto the party, so
  // without the last a second copy to that dentist placed nobody, and every other dentist's
  // letter looked as if it might be its letter.
  const recipientParties = new Set(
    parties
      .filter((p) => (p.email && recipientEmails.has(p.email)) || recipientNames.has(comparableName(p.name)))
      .map((p) => p.partyId),
  );
  for (const x of read) {
    if (x.toEmail && recipientEmails.has(x.toEmail)) for (const id of x.addressees) recipientParties.add(id);
  }
  const recipientSides = new Set(
    [...recipientParties].map((id) => sideOfRole(partyById.get(id)?.role ?? '')).filter((x) => x !== null),
  );

  const asDate = (d: Date | string) => (d instanceof Date ? d : new Date(d));
  const letters: Array<RecordedLetter & { kindMatch: boolean }> = read
    .map(({ r, side, toEmail, toName, addressees }) => {
      let addressed: RecordedLetter['addressed'] = 'unknown';
      if (recipients.length) {
        if (
          (toEmail && recipientEmails.has(toEmail)) ||
          [...addressees].some((id) => recipientParties.has(id)) ||
          (toName && recipientNames.has(toName))
        ) {
          addressed = 'yes';
        } else if (recipientParties.size && addressees.size) {
          addressed = 'no';
        } else if (side && recipientSides.size && !recipientSides.has(side)) {
          // A letter to the dentist, and the copy went only to the complainant's side (or
          // the other way round): whatever its stored addressee, not this letter.
          addressed = 'no';
        }
      }
      return {
        id: r.id,
        kind: r.kind,
        subject: r.subject,
        sentAt: r.sent_at ? asDate(r.sent_at) : null,
        createdAt: asDate(r.created_at),
        toName: r.to_name,
        toEmail: r.to_email,
        copied: Boolean(r.copied),
        addressed,
        knownAddressee: addressees.size > 0,
        kindMatch: args.kind !== null && r.kind === args.kind,
      };
    })
    .filter((l) => l.kindMatch || sameSubject(l.subject, args.subject))
    // Once the copy's kind is known, a letter that only shares its subject and is written to
    // the other side of the case is not a candidate at all. The two hearing notices share a
    // subject word for word; the complainant's, sent, was the one letter the dentist's copy
    // could be filed against, and was - as proof of service of the wrong letter.
    .filter((l) => {
      if (l.kindMatch || args.kind === null) return true;
      const theirs = sideOf(l.kind);
      const ours = sideOf(args.kind);
      return !(theirs && ours && theirs !== ours);
    });

  const when = args.date.getTime();
  const lower = when - COPY_WINDOW_MS;
  const upper = when + (args.basis === 'forwarded' ? DAY_MS : COPY_WINDOW_MS);
  const rank = (l: (typeof letters)[number]) => (l.addressed === 'yes' ? 0 : 2) + (l.kindMatch ? 0 : 1);
  // Who it went to, then the same kind, then nearest the copy's date, then the older row:
  // the same answer every time, whatever order the database returned the rows in.
  const byFit = (a: (typeof letters)[number], b: (typeof letters)[number]) =>
    rank(a) - rank(b) ||
    Math.abs(a.sentAt!.getTime() - when) - Math.abs(b.sentAt!.getTime() - when) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id);
  const strip = (l: (typeof letters)[number] | undefined): RecordedLetter | null => {
    if (!l) return null;
    const { kindMatch: _k, ...letter } = l;
    return letter;
  };

  const sentOnes = letters.filter((l) => l.sentAt && l.addressed !== 'no');
  const inWindow = (l: (typeof letters)[number]) => l.sentAt!.getTime() >= lower && l.sentAt!.getTime() <= upper;
  const before = (l: (typeof letters)[number]) => l.sentAt!.getTime() < lower;

  // A letter outside the window is offered as the one this copies only when the copy's
  // date is the forward's, and the letter may simply have been forwarded late. A Cc or Bcc
  // copy, or a forward whose date line was read, says when its letter went out: an older
  // letter of the same kind is a different letter - the notice for an earlier sitting, an
  // earlier reminder - and taking it for this one refused to record the new letter.
  const tiers: Array<{ how: NonNullable<RecordedLetterMatch['how']>; pick: (l: (typeof letters)[number]) => boolean }> = [
    { how: 'match', pick: (l) => !l.copied && inWindow(l) },
    { how: 'already_copied', pick: (l) => l.copied && inWindow(l) },
    ...(args.basis === 'forwarded' ? [{ how: 'earlier' as const, pick: before }] : []),
  ];
  let sent: (typeof letters)[number] | undefined;
  let how: RecordedLetterMatch['how'] = null;
  for (const tier of tiers) {
    const candidates = sentOnes.filter(tier.pick).sort(byFit);
    if (!candidates.length) continue;
    sent = candidates[0]!;
    how = tier.how;
    break;
  }
  // Sure only when nothing else around the copy's date fits as well - copied or not: a
  // closer letter that already has its copy is still a letter this could be the copy of.
  // Two notices of one kind, to addresses nothing tells apart, are a question for the
  // officer; so is a letter found only by its subject when the copy is known to be another
  // kind, and a letter to a named person the copy cannot be placed as. The same questions
  // are asked of a letter that already has a copy: Dr Alpha's notice, copied once, is not
  // the letter Dr Beta's copy goes with because it was sent the same week.
  const unsure: RecordedLetterMatch['unsure'] =
    (how !== 'match' && how !== 'already_copied') || !sent
      ? null
      : sentOnes.some((c) => c !== sent && inWindow(c) && rank(c) <= rank(sent!))
        ? 'several'
        : !sent.kindMatch && args.kind !== null
          ? 'other_kind'
          : sent.addressed !== 'yes' && sent.knownAddressee
            ? 'addressee'
            : null;
  const sure = how === 'match' && unsure === null;
  const previous = args.basis === 'forwarded' ? undefined : sentOnes.filter(before).sort(byFit)[0];

  const drafts = letters
    .filter((l) => !l.sentAt)
    .sort(
      (a, b) =>
        (a.addressed === 'no' ? 1 : 0) - (b.addressed === 'no' ? 1 : 0) ||
        rank(a) - rank(b) ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  const draft = drafts.find((d) => d.addressed !== 'no');

  return {
    sent: strip(sent),
    how,
    sure,
    unsure,
    previous: strip(previous),
    draft: strip(draft),
    drafts: drafts.map((d) => strip(d)!),
  };
}

/** The people on a case, with the address and name each is on file under. */
export async function partiesOnCase(
  tx: Tx,
  ctx: EngineContext,
  caseFileId: string,
): Promise<Array<{ partyId: string; role: string; email: string | null; name: string }>> {
  const rows = await tx.execute<{ party_id: string; role: string; email: string | null; full_name: string }>(sql`
    SELECT cp.party_id, cp.role::text AS role, lower(p.email) AS email, p.full_name
    FROM case_party cp JOIN party p ON p.id = cp.party_id
    WHERE cp.council_id = ${ctx.councilId}::uuid AND p.council_id = ${ctx.councilId}::uuid
      AND cp.case_file_id = ${caseFileId}::uuid
  `);
  return rows.rows.map((r) => ({ partyId: r.party_id, role: r.role, email: r.email, name: r.full_name }));
}

/** Which of these references belong to cases cancelled as opened in error. */
async function cancelledByNumber(tx: Tx, ctx: EngineContext, refs: string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const rows = await tx.execute<{ case_number: string }>(sql`
    SELECT c.case_number
    FROM case_file c
    WHERE c.council_id = ${ctx.councilId}::uuid
      AND c.case_number = ANY(${pgTextArray(refs)}::text[])
      AND c.deleted_at IS NOT NULL
    ORDER BY c.case_number
  `);
  return rows.rows.map((r) => r.case_number);
}

/**
 * Rung 1 and 2: the reference token. Index hit on case_file_number_uq.
 *
 * Cancelled cases are left out here and in casesBySender: a case opened in error is on no
 * working list, and filing a message onto one - automatically or by a suggestion the
 * officer accepts - would take it out of the tray and put it where nobody looks.
 */
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
