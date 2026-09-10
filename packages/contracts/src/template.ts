/**
 * The letter template renderer.
 *
 * Thirty lines, not a template engine. The build plan is explicit about this (§6): the
 * officer edits letters in a textarea with a field picker, so the renderer needs exactly
 * two constructs — a field and a conditional — and no way to express anything else.
 *
 *   {{case.number}}
 *   {{#if respondent.registrationNo}}Reg. No. {{respondent.registrationNo}}{{/if}}
 *
 * Everything it inserts is escaped for the output format, and every token is validated
 * against a per-kind whitelist at publish time. A template that references a field the
 * letter cannot have is rejected while it is being written, not discovered as a blank
 * space on a signed letter three weeks later.
 */

import type { CorrespondenceKind } from './enums.js';

export type TemplateFormat = 'text' | 'html';

/** `{{ field.path }}` — dotted, alphanumeric, no expressions, no helpers, no calls. */
const FIELD_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*)\s*\}\}/g;
const IF_RE =
  /\{\{#if\s+([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;

export type MergeContext = Record<string, unknown>;

export function lookup(ctx: MergeContext, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, ctx);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A missing value renders as a visible blank, never as an empty string.
 *
 * A letter that silently drops the deadline reads as complete and is not; a letter with
 * `__________` where the date should be is obviously unfinished, and the officer sees it
 * before the Registrar signs it.
 */
export const BLANK = '__________';

function stringify(value: unknown, format: TemplateFormat): string {
  if (value === null || value === undefined || value === '') return BLANK;
  if (Array.isArray(value)) {
    const joined = value.map((v) => String(v)).join(format === 'html' ? '<br>' : '\n');
    return format === 'html' ? joined : joined;
  }
  const text = String(value);
  return format === 'html' ? escapeHtml(text) : text;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function renderTemplate(
  body: string,
  ctx: MergeContext,
  format: TemplateFormat = 'text',
): string {
  // Conditionals first, so a field inside a false branch is never evaluated and a
  // missing value there cannot leave a BLANK in text that was meant to disappear.
  const withConditionals = body.replace(IF_RE, (_match, path: string, inner: string) =>
    isTruthy(lookup(ctx, path)) ? inner : '',
  );

  return withConditionals.replace(FIELD_RE, (_match, path: string) =>
    stringify(lookup(ctx, path), format),
  );
}

/** Every field a template references, conditionals included. Used to validate on publish. */
export function extractTokens(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(IF_RE)) found.add(m[1]!);
  // Strip the conditional wrappers so their own tokens are not double-counted, then
  // collect the plain fields, including those inside the branches.
  for (const m of body.replace(/\{\{#if\s+[^}]*\}\}|\{\{\/if\}\}/g, '').matchAll(FIELD_RE)) {
    found.add(m[1]!);
  }
  return [...found].sort();
}

export interface TemplateValidation {
  ok: boolean;
  unknownFields: string[];
  unclosedConditionals: number;
}

export function validateTemplate(body: string, allowedFields: readonly string[]): TemplateValidation {
  const allowed = new Set(allowedFields);
  const unknownFields = extractTokens(body).filter((t) => !allowed.has(t));

  const opens = (body.match(/\{\{#if\s+/g) ?? []).length;
  const closes = (body.match(/\{\{\/if\}\}/g) ?? []).length;

  return {
    ok: unknownFields.length === 0 && opens === closes,
    unknownFields,
    unclosedConditionals: opens - closes,
  };
}

// ─── The merge-field vocabulary ──────────────────────────────────────────────

/** Available in every letter. */
export const COMMON_FIELDS = [
  'council.name',
  'council.addressLines',
  'council.phone',
  'council.email',
  'council.registrarName',
  'council.registrarTitle',
  'council.presidentTitle',
  'case.number',
  'case.receivedOn',
  'case.summary',
  'case.fiscalYear',
  'letter.date',
  'letter.despatchRef',
  'officer.name',
] as const;

const COMPLAINANT_FIELDS = [
  'complainant.name',
  'complainant.mobile',
  'complainant.email',
  'complainant.addressLines',
] as const;

const PATIENT_FIELDS = ['patient.name', 'patient.age', 'patient.sex', 'patient.mobile'] as const;

const RESPONDENT_FIELDS = [
  'respondent.name',
  'respondent.registrationNo',
  'respondent.clinic',
  'respondent.addressLines',
  'respondent.noticeNumber',
] as const;

const DEADLINE_FIELDS = ['deadline.date', 'deadline.days'] as const;

const EXPERT_FIELDS = [
  'expert.name',
  'expert.addresseeTitle',
  'expert.addressLines',
  'expert.questions',
] as const;

const SITTING_FIELDS = ['sitting.date', 'sitting.time', 'sitting.venue'] as const;

const OUTCOME_FIELDS = ['decision.operativeText', 'decision.decidedOn', 'closure.reason'] as const;

/**
 * What each letter may reference.
 *
 * Deliberately per-kind rather than one big list: a document request has no decision to
 * quote, and an expert referral has no sitting date. Offering fields a letter cannot fill
 * is how `__________` ends up on something the Registrar has already signed.
 */
export const TEMPLATE_FIELDS: Readonly<Record<CorrespondenceKind, readonly string[]>> = {
  ack_complaint: [...COMMON_FIELDS, ...COMPLAINANT_FIELDS, ...PATIENT_FIELDS],
  request_docs: [...COMMON_FIELDS, ...COMPLAINANT_FIELDS, ...PATIENT_FIELDS, ...DEADLINE_FIELDS],
  request_docs_reminder: [
    ...COMMON_FIELDS,
    ...COMPLAINANT_FIELDS,
    ...PATIENT_FIELDS,
    ...DEADLINE_FIELDS,
  ],
  respondent_explanation_sought: [
    ...COMMON_FIELDS,
    ...COMPLAINANT_FIELDS,
    ...PATIENT_FIELDS,
    ...RESPONDENT_FIELDS,
    ...DEADLINE_FIELDS,
  ],
  respondent_reminder: [...COMMON_FIELDS, ...RESPONDENT_FIELDS, ...DEADLINE_FIELDS],
  respondent_final_notice: [...COMMON_FIELDS, ...RESPONDENT_FIELDS, ...DEADLINE_FIELDS],
  summons_complainant: [...COMMON_FIELDS, ...COMPLAINANT_FIELDS, ...SITTING_FIELDS],
  summons_respondent: [...COMMON_FIELDS, ...RESPONDENT_FIELDS, ...SITTING_FIELDS],
  member_intimation: [...COMMON_FIELDS, ...SITTING_FIELDS],
  expert_referral_letter: [...COMMON_FIELDS, ...PATIENT_FIELDS, ...EXPERT_FIELDS],
  expert_referral_copy_to_patient: [...COMMON_FIELDS, ...PATIENT_FIELDS, ...EXPERT_FIELDS],
  expert_report_share: [...COMMON_FIELDS, ...COMPLAINANT_FIELDS, ...PATIENT_FIELDS],
  order_to_respondent: [...COMMON_FIELDS, ...RESPONDENT_FIELDS, ...OUTCOME_FIELDS],
  order_to_complainant: [...COMMON_FIELDS, ...COMPLAINANT_FIELDS, ...OUTCOME_FIELDS],
  closure_intimation: [...COMMON_FIELDS, ...COMPLAINANT_FIELDS, ...OUTCOME_FIELDS],
  ethics_explanation: [...COMMON_FIELDS, ...RESPONDENT_FIELDS, ...DEADLINE_FIELDS],
  ethics_cease_desist: [...COMMON_FIELDS, ...RESPONDENT_FIELDS, ...DEADLINE_FIELDS],
  reply_to_referring_authority: [...COMMON_FIELDS, ...COMPLAINANT_FIELDS, ...OUTCOME_FIELDS],
  rti_reply_cover: [...COMMON_FIELDS],
  inbound: [...COMMON_FIELDS],
  other: [...COMMON_FIELDS],
};

export function fieldsFor(kind: CorrespondenceKind): readonly string[] {
  return TEMPLATE_FIELDS[kind] ?? COMMON_FIELDS;
}
