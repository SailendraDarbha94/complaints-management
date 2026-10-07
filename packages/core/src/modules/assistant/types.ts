import type {
  MailSuggestionConfidence,
  MailSuggestionDecision,
  MailSuggestionStatus,
} from '@ksdc/contracts';

/**
 * The mail assistant - stage 1: it suggests, the officer decides.
 *
 * This file is the contract between the parts, written before any of them:
 *
 *   engine.ts            talks to Claude. Knows nothing about the database: it is handed an
 *                        email and three lookup functions, and returns a proposal.
 *   assistant.service.ts the register's side. Builds the email from the tray, answers the
 *                        lookups from the database, stores suggestions, and carries out an
 *                        accepted one through the SAME services the officer's buttons use.
 *   the web screens      show a suggestion and let the officer accept, change or reject it.
 *
 * THE RULE THAT SHAPES ALL OF IT: in stage 1 nothing the model does changes the register.
 * Its tools only read. A suggestion becomes a change only when the officer clicks.
 */

// ─── What the model is shown ─────────────────────────────────────────────────

/**
 * One email, as the assistant sees it - and everything it sees about it.
 *
 * Deliberately narrow. Attachments go by NAME only (stage 1 does not send their contents),
 * and nothing else from the tray row - addresses, the raw source, the HTML - is passed on.
 */
export interface TriageEmail {
  /** The ORIGINAL sender - the unwrapped forward, not the office that forwarded it. */
  fromName: string | null;
  fromAddress: string | null;
  /** Who forwarded it, when it was a forward (often the Council's own office). */
  forwardedBy: string | null;
  subject: string;
  /** As written in the email; a forwarded date carries no timezone, so it stays text. */
  dateText: string | null;
  body: string;
  attachments: Array<{ filename: string; contentType: string | null; stored: boolean }>;
}

/** A case the lookup found, with no contact details - only what matched. */
export interface CaseSearchHit {
  caseNumber: string;
  summary: string;
  state: string;
  openedOn: string;
  closed: boolean;
  complainantName: string | null;
  patientName: string | null;
  respondentNames: string[];
  /** What the query matched, in words: 'case number', 'complainant name', 'phone number'... */
  matchedOn: string[];
}

export interface CaseDetail {
  caseNumber: string;
  summary: string;
  state: string;
  openedOn: string;
  closedOn: string | null;
  complainantName: string | null;
  patientName: string | null;
  respondents: Array<{ name: string; registrationNo: string | null; clinicName: string | null }>;
  /** Subjects and dates only - never letter bodies. */
  recentLetters: Array<{ direction: 'in' | 'out'; subject: string; date: string | null }>;
}

/** A dentist the register knows - previously named on a case, or in the register of dentists. */
export interface DentistHit {
  partyId: string | null;
  registeredDentistId: string | null;
  name: string;
  registrationNo: string | null;
  clinicName: string | null;
  /** Cases this dentist is already named on (cancelled cases not counted). */
  priorCases: number;
  /** 'seen_before' | 'register' - where the match came from. */
  source: string;
}

/** The lookups the model may call. READ-ONLY, all three. */
export interface TriageTools {
  searchCases(query: string): Promise<CaseSearchHit[]>;
  getCase(caseNumber: string): Promise<CaseDetail | null>;
  searchDentists(query: string): Promise<DentistHit[]>;
}

// ─── What the model answers ──────────────────────────────────────────────────

export interface SuggestedRespondent {
  name: string;
  registrationNo: string | null;
  clinicName: string | null;
  /** A clinic or a chain rather than an individual dentist. */
  isEstablishment: boolean;
  /** Set when the model matched a dentist the register knows (from searchDentists). */
  partyId: string | null;
  registeredDentistId: string | null;
}

/** Exactly one of notComplaint / followUp / newComplaint is set, matching `decision`; none for unsure. */
export interface TriageProposal {
  decision: MailSuggestionDecision;
  confidence: MailSuggestionConfidence;
  /** One to four sentences of plain English for the officer: why this, and what it relied on. */
  reasoning: string;
  notComplaint: { reason: string } | null;
  followUp: { caseNumber: string; because: string } | null;
  newComplaint: {
    /** One neutral line, in the register's style. */
    summary: string;
    complainantName: string;
    complainantEmail: string | null;
    respondents: SuggestedRespondent[];
  } | null;
}

export interface TriageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * In both shapes: `model` is the model that produced the LAST reply - not always the one
 * asked for, since a server-side fallback can answer instead - or the one asked for when
 * no reply came. `toolCalls` counts the lookups ATTEMPTED (malformed and failed ones
 * included, because each was paid for); the submission itself is not a lookup.
 */
export type TriageResult =
  | {
      ok: true;
      proposal: TriageProposal;
      model: string;
      usage: TriageUsage;
      costUsd: number;
      toolCalls: number;
    }
  | {
      ok: false;
      /** Plain English, safe to show the officer. Never contains the email's text. */
      error: string;
      model: string;
      usage: TriageUsage;
      costUsd: number;
      toolCalls: number;
    };

export type AssistantEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface TriageOptions {
  model: string;
  effort: AssistantEffort;
  /** The Council's playbook (packages/config). Sent as the cached system prompt. */
  playbook: string;
  /** sha256 of the playbook text, stored with each suggestion so a change can be traced. */
  playbookVersion: string;
  /** Upper bound on lookups per email; the engine stops and fails cleanly beyond it. */
  maxToolCalls: number;
}

/** engine.ts exports a function of this type. */
export type RunTriage = (
  email: TriageEmail,
  tools: TriageTools,
  opts: TriageOptions,
) => Promise<TriageResult>;

// ─── What the screens are given ──────────────────────────────────────────────

export interface MailSuggestionView {
  id: string;
  mailMessageId: string;
  createdAt: string;
  status: MailSuggestionStatus;
  decision: MailSuggestionDecision | null;
  confidence: MailSuggestionConfidence | null;
  reasoning: string | null;
  notComplaint: { reason: string } | null;
  /**
   * caseFileId resolved from the case number; null if that number is not (or no longer) a
   * live case. `closed` is read live too: filing on a closed case is allowed but is a
   * decision the officer must see they are making, so the screens confirm it first.
   */
  followUp: { caseFileId: string | null; caseNumber: string; because: string; closed: boolean } | null;
  newComplaint: TriageProposal['newComplaint'];
  model: string;
  costUsd: number;
  /** Set when status is 'failed'. */
  error: string | null;
  outcome: {
    action: 'opened_case' | 'filed_on_case' | 'set_aside' | 'rejected';
    caseFileId: string | null;
    caseNumber: string | null;
    /**
     * Did what happened match the suggestion? Null for 'unsure' and for rejections - a
     * rejection is not yet an action. (The REPORT still counts a rejection of anything but
     * 'unsure' as a disagreement; see AssistantReport.agreement.)
     */
    agreed: boolean | null;
    note: string | null;
    at: string;
  } | null;
}

/**
 * What the officer may change before accepting. Anything left out keeps the suggestion's
 * value. Any change at all makes the outcome 'edited' rather than 'accepted'.
 */
export interface SuggestionOverrides {
  summary?: string;
  complainantName?: string;
  complainantEmail?: string | null;
  respondents?: SuggestedRespondent[];
  /** For a follow-up: file it on this case instead. */
  caseFileId?: string;
  /** For a non-complaint: the reason recorded when it is set aside. */
  reason?: string;
}

/** GET /v1/assistant/report */
export interface AssistantReport {
  enabled: boolean;
  /** Why it is off, in words for the officer - the setting to fix. Null when it is on. */
  reason: string | null;
  model: string;
  /** YYYY-MM */
  month: string;
  totals: Record<MailSuggestionStatus, number>;
  /**
   * Counted by when the suggestion was made. Agreed: accepted (as it was, or edited
   * without changing the decision - and for a follow-up, the case), or the ordinary
   * buttons doing what it suggested. Disagreed: the ordinary buttons doing something
   * else, a follow-up filed on another case, AND an explicit rejection. 'unsure' is in
   * neither column. recentDisagreements are the chosen month's, newest first.
   */
  agreement: {
    overall: { agreed: number; disagreed: number };
    byDecision: Record<MailSuggestionDecision, { agreed: number; disagreed: number }>;
  };
  costUsd: number;
  recentDisagreements: Array<{
    mailMessageId: string;
    subject: string;
    decision: MailSuggestionDecision | null;
    outcomeAction: string | null;
    note: string | null;
    at: string;
  }>;
}
