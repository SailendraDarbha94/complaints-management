import { supabase } from './supabase';

/**
 * Reading case files, straight from Supabase.
 *
 * No server in the path. These queries are filtered by jwt_council_isolation, which checks
 * the council claim in the caller's token AND re-checks the membership is live on every
 * row - so a member whose term ended this morning reads nothing this morning, not at the
 * top of the hour when their token expires.
 *
 * Eight tables are readable and no more (migration 0010). The absences are deliberate and
 * they shape what the screens can show: no follow-ups, no correspondence, no officer's
 * notes. A member is reading a case file, not operating the register.
 *
 * Everything here is read-only. A phone never writes to the register - audit.append()
 * takes its actor from session settings a direct client never sets, so a direct write
 * would land unattributed and break the chain the legal case rests on.
 */

export interface CaseRow {
  id: string;
  case_number: string;
  summary: string;
  state: string;
  on_hold: boolean;
  hold_reason: string | null;
  held_since: string | null;
  is_backfilled: boolean;
  register_sl_no: number;
  created_at: string;
}

export interface PartyOnCase {
  role: string;
  note: string | null;
  party: {
    full_name: string;
    age_years: number | null;
    sex: string | null;
    kind: string;
  } | null;
}

export interface RespondentRow {
  id: string;
  notice_state: string;
  notice_count: number;
  reply_due_at: string | null;
  first_reply_at: string | null;
  ex_parte_at: string | null;
  ex_parte_reason: string | null;
  dropped_at: string | null;
  dropped_reason: string | null;
  case_party: { party: { full_name: string } | null } | null;
}

export interface MilestoneRow {
  id: string;
  milestone: string;
  occurred_at: string;
  date_source: string;
  note: string | null;
  case_respondent_id: string | null;
}

export interface DocumentRow {
  id: string;
  title: string;
  document_class: string;
  status: string;
}

export interface CaseFile {
  file: CaseRow;
  parties: PartyOnCase[];
  respondents: RespondentRow[];
  milestones: MilestoneRow[];
  documents: DocumentRow[];
}

/** The list. Open cases only, newest first - there are never more than about ten. */
export async function listCases(): Promise<CaseRow[]> {
  const { data, error } = await supabase()
    .from('case_file')
    .select('id, case_number, summary, state, on_hold, hold_reason, held_since, is_backfilled, register_sl_no, created_at')
    .is('closed_at', null)
    .order('register_sl_no', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as CaseRow[];
}

/**
 * One case, in five round trips rather than one join.
 *
 * PostgREST can embed related rows, and for case_party -> party it is used. It is NOT used
 * to pull everything at once, because an embed that hits a table the caller cannot read
 * fails the WHOLE request rather than omitting that branch - and the set of readable
 * tables here is deliberately narrow and will change. Five small requests degrade one
 * section at a time; one large one degrades to a blank screen.
 */
export async function getCase(id: string): Promise<CaseFile> {
  const sb = supabase();

  const [file, parties, respondents, milestones, documents] = await Promise.all([
    sb.from('case_file').select('*').eq('id', id).single(),
    sb
      .from('case_party')
      .select('role, note, party:party_id(full_name, age_years, sex, kind)')
      .eq('case_file_id', id),
    sb
      .from('case_respondent')
      .select(
        'id, notice_state, notice_count, reply_due_at, first_reply_at, ex_parte_at, ex_parte_reason, dropped_at, dropped_reason, case_party:case_party_id(party:party_id(full_name))',
      )
      .eq('case_file_id', id),
    sb
      .from('case_milestone')
      .select('id, milestone, occurred_at, date_source, note, case_respondent_id')
      .eq('case_file_id', id)
      .order('occurred_at', { ascending: true }),
    sb.from('document').select('id, title, document_class, status').eq('case_file_id', id),
  ]);

  if (file.error) throw new Error(file.error.message);

  return {
    file: file.data as CaseRow,
    parties: (parties.data ?? []) as unknown as PartyOnCase[],
    respondents: (respondents.data ?? []) as unknown as RespondentRow[],
    milestones: (milestones.data ?? []) as MilestoneRow[],
    documents: (documents.data ?? []) as DocumentRow[],
  };
}

// ─── Turning stored values into something a dentist reads ────────────────────

/**
 * The milestone vocabulary, in the words a dentist reads.
 *
 * Taken from MILESTONES in @ksdc/contracts rather than invented - the stored values are
 * the register's vocabulary and ADR-0001 locks them. What changes here is only how they
 * are said aloud: `respondent_notice_despatched` is exact and unreadable, and the member
 * is skimming a chronology in a car park.
 */
const MILESTONE_WORDS: Record<string, string> = {
  received: 'Complaint received',
  acknowledged: 'Acknowledged',
  documents_requested: 'Documents requested from the complainant',
  documents_complete: 'Documents complete',
  respondent_notice_despatched: 'Notice dispatched to the dentist',
  respondent_reply_received: 'The dentist replied',
  respondent_declared_ex_parte: 'Dentist declared ex parte',
  case_closed: 'Closed',
  case_reopened: 'Reopened',
  expert_referral_despatched: 'Referred to the dental college for an opinion',
  expert_report_received: 'Expert opinion received',
  expert_report_shared: 'Expert opinion shared with the parties',
  listed_for_sitting: 'Listed for a sitting',
  heard: 'Heard by the committee',
  order_despatched: 'Order dispatched',
};

export function milestoneWords(m: string): string {
  return MILESTONE_WORDS[m] ?? m.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * A respondent's position as a SENTENCE, not a badge.
 *
 * "Awaiting reply · 3" tells a member nothing they can act on. "No reply after three
 * notices, the last on 14 July" is the thing that gets said aloud in the room.
 */
export function respondentPosition(r: RespondentRow): string {
  if (r.dropped_at) {
    return `Dropped${r.dropped_reason ? ` - ${r.dropped_reason}` : ''}.`;
  }
  if (r.ex_parte_at) {
    return `Declared ex parte on ${shortDate(r.ex_parte_at)}${
      r.ex_parte_reason ? ` - ${r.ex_parte_reason}` : ''
    }.`;
  }
  if (r.first_reply_at) {
    return `Replied on ${shortDate(r.first_reply_at)}.`;
  }
  if (r.notice_count === 0) {
    return 'No notice has been sent yet.';
  }
  const n = r.notice_count === 1 ? 'one notice' : `${numberWord(r.notice_count)} notices`;
  return `No reply after ${n}.`;
}

function numberWord(n: number): string {
  return ['no', 'one', 'two', 'three', 'four', 'five', 'six'][n] ?? String(n);
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Months between two dates, for the gap markers in the chronology.
 *
 * The questions a committee asks are usually about the silences - why did nothing happen
 * between April and August - so the silences are drawn rather than left to be inferred
 * from two dates several lines apart.
 */
export function gapMonths(a: string, b: string): number {
  const days = (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
  return days >= 60 ? Math.round(days / 30) : 0;
}

/** A date reconstructed from the paper register is not a recorded fact, and must not read as one. */
export function isReconstructed(dateSource: string): boolean {
  return dateSource !== 'recorded';
}
