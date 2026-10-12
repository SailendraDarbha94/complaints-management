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
 *                        email, three lookup functions and the attachment reader, and
 *                        returns a proposal.
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
 * Deliberately narrow. Attachments go by NAME; a file's CONTENTS are sent only when the
 * model asks for that one file through readAttachment, and only when the attachment reader
 * is switched on (MAIL_ASSISTANT_ATTACHMENTS=on). Nothing else from the tray row - the
 * raw source, the HTML, the Cc line - is passed on.
 */
export interface TriageEmail {
  /** The ORIGINAL sender - the unwrapped forward, not the office that forwarded it. */
  fromName: string | null;
  fromAddress: string | null;
  /** Who forwarded it, when it was a forward (often the Council's own office). */
  forwardedBy: string | null;
  /**
   * Who the email was written TO, as its To line gives it - the original's when it was a
   * forward, else the message's own; names and addresses as written. Null when there is
   * none.
   *
   * Sent because of copies of the Council's own letters: a letter FROM a Council address
   * is a copy of what the Council sent only if it went to somebody outside the Council, and
   * that somebody - the complainant, the dentist - is how its case is checked. It is the
   * one recipient's address the assistant is shown; see the privacy section of
   * docs/mail-assistant.md.
   */
  to: string | null;
  subject: string;
  /** As written in the email; a forwarded date carries no timezone, so it stays text. */
  dateText: string | null;
  body: string;
  attachments: TriageAttachment[];
}

export interface TriageAttachment {
  /**
   * The handle the model asks for this file by: 'a1', 'a2'... Not the filename - two
   * attachments are often both called "scan.pdf". Given out by ONE rule per side, so the
   * reader resolves a ref to the file the model was shown under it: for the register,
   * attachmentsOf() in register-tools.ts (stable, though not always the email's own order);
   * for the evaluation, the order of the eval set's attachments array.
   */
  ref: string;
  filename: string;
  contentType: string | null;
  /** False when the register refused to keep it (a .docx, a logo): it cannot be read. */
  stored: boolean;
}

/**
 * One attachment's contents, ready for the model - or, in plain words, why not.
 *
 * Prepared by attachment-prep.ts for both the register and the evaluation, so the two can
 * never disagree about what is readable: the type is sniffed from the bytes, a PDF is cut
 * to its first MAIL_ASSISTANT_MAX_PDF_PAGES pages, and anything too large or of a kind the
 * model cannot read is refused with a reason the model passes on to the officer.
 */
export type AttachmentReadResult =
  | {
      ok: true;
      kind: 'pdf' | 'image';
      /** application/pdf, image/jpeg, image/png, image/gif or image/webp - from the bytes. */
      mediaType: string;
      data: Buffer;
      /** PDFs: pages in the file, and pages actually sent. Null for an image. */
      pagesTotal: number | null;
      pagesSent: number | null;
    }
  | { ok: false; reason: string };

/** What was sent to the model, recorded with every suggestion. Successful reads only. */
export interface AttachmentReadRecord {
  ref: string;
  filename: string;
  pagesSent: number | null;
  pagesTotal: number | null;
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

/** The lookups the model may call. READ-ONLY, all four. */
export interface TriageTools {
  searchCases(query: string): Promise<CaseSearchHit[]>;
  getCase(caseNumber: string): Promise<CaseDetail | null>;
  searchDentists(query: string): Promise<DentistHit[]>;
  /** One attachment's contents, by its ref. Offered to the model only when readAttachments is on. */
  readAttachment(ref: string): Promise<AttachmentReadResult>;
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

/**
 * Exactly one of notComplaint / followUp / newComplaint / councilCopy is set, matching
 * `decision`; none for unsure.
 */
export interface TriageProposal {
  decision: MailSuggestionDecision;
  confidence: MailSuggestionConfidence;
  /** One to four sentences of plain English for the officer: why this, and what it relied on. */
  reasoning: string;
  notComplaint: { reason: string } | null;
  followUp: { caseNumber: string; because: string } | null;
  /**
   * A copy of a letter the Council itself sent - not a complaint, not a reply. The case it
   * belongs to (a number a lookup returned, as for a follow-up), which letter it is in a
   * few plain words ("documents request"), and what ties the two together - the number it
   * quotes AND the person it was sent to.
   */
  councilCopy: { caseNumber: string; letter: string; because: string } | null;
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
      /** Attachments whose contents were sent to the model - shown to the officer. */
      attachmentsRead: AttachmentReadRecord[];
    }
  | {
      ok: false;
      /** Plain English, safe to show the officer. Never contains the email's text. */
      error: string;
      model: string;
      usage: TriageUsage;
      costUsd: number;
      toolCalls: number;
      /** Attachments whose contents were sent to the model - shown to the officer. */
      attachmentsRead: AttachmentReadRecord[];
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
  /** Offer read_attachment to the model at all (MAIL_ASSISTANT_ATTACHMENTS=on). */
  readAttachments: boolean;
  /**
   * Upper bound on attachments read per email (MAIL_ASSISTANT_MAX_ATTACHMENT_READS) - a
   * budget of its own, because one PDF can cost more than every lookup together.
   */
  maxAttachmentReads: number;
}

/** engine.ts exports a function of this type. */
export type RunTriage = (
  email: TriageEmail,
  tools: TriageTools,
  opts: TriageOptions,
) => Promise<TriageResult>;

// ─── What the screens are given ──────────────────────────────────────────────

/** One file whose contents went to Anthropic, as the officer is shown it: by name, never by ref. */
export interface SuggestionFileSent {
  filename: string;
  pagesSent: number | null;
  pagesTotal: number | null;
}

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
  /** As followUp: the case resolved live, closed or not, and null when it is not a live case. */
  councilCopy: {
    caseFileId: string | null;
    caseNumber: string;
    letter: string;
    because: string;
    closed: boolean;
  } | null;
  newComplaint: TriageProposal['newComplaint'];
  /** Attachments whose contents the assistant read (and so were sent to Anthropic). */
  attachmentsRead: SuggestionFileSent[];
  /**
   * Files this message's OTHER readings sent to Anthropic - a failed or replaced "ask
   * again", or one still under way - that attachmentsRead does not already name, oldest
   * first, each once. The screens show one reading per message (the pending one when there
   * is one), so without this a file sent by any other reading would be on no screen at all.
   */
  otherReadingsSent: SuggestionFileSent[];
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
  /** For a follow-up or a copy of a Council letter: file it on this case instead. */
  caseFileId?: string;
  /** For a non-complaint: the reason recorded when it is set aside. */
  reason?: string;
}

/** GET /v1/assistant/report */
export interface AssistantReport {
  enabled: boolean;
  /** Reads new mail by itself (MAIL_ASSISTANT=on), or only when asked (=ask). */
  automatic: boolean;
  /** May open attached files when the email alone is not enough (MAIL_ASSISTANT_ATTACHMENTS=on). */
  readsAttachments: boolean;
  /** Why it is off, in words for the officer - the setting to fix. Null when it is on. */
  reason: string | null;
  model: string;
  /** YYYY-MM */
  month: string;
  totals: Record<MailSuggestionStatus, number>;
  /**
   * Counted by when the suggestion was made. Agreed: accepted (as it was, or edited
   * without changing the decision - and for a follow-up or a copy, the case), or the
   * ordinary buttons doing what it suggested. Disagreed: the ordinary buttons doing
   * something else, a follow-up or a copy filed on another case, AND an explicit
   * rejection. 'unsure' is in neither column. recentDisagreements are the chosen month's,
   * newest first.
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
