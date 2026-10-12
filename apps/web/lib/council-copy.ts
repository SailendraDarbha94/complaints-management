import { z } from 'zod';
import { CORRESPONDENCE_KINDS, type CorrespondenceKind } from '@ksdc/contracts';

/**
 * The request body for filing a copy of a Council letter (POST /v1/intake/[id]/council-copy),
 * and turning its date into the moment the letter is recorded as sent.
 *
 * Here rather than in the route file because a route module may export only its handlers,
 * and these are worth testing on their own.
 */

export const COUNCIL_COPY_MODES = ['link', 'record_sent', 'record_only'] as const;

/** The letters the Council sends. Never 'inbound': a copy of our letter is not one received. */
export const OUTGOING_KINDS = CORRESPONDENCE_KINDS.filter(
  (k): k is Exclude<CorrespondenceKind, 'inbound'> => k !== 'inbound',
) as [Exclude<CorrespondenceKind, 'inbound'>, ...Array<Exclude<CorrespondenceKind, 'inbound'>>];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The body, checked against today in the council's own calendar. A bare date may be today
 * or earlier; a full timestamp may not be later than now.
 */
export function councilCopyBody(today: string, now: Date = new Date()) {
  return z.object({
    caseFileId: z.string().uuid(),
    mode: z.enum(COUNCIL_COPY_MODES),
    sentAt: z
      .string()
      .refine(
        (s) => (DATE_ONLY.test(s) ? !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) : !Number.isNaN(Date.parse(s))),
        'A date as YYYY-MM-DD.',
      )
      .refine(
        (s) => (DATE_ONLY.test(s) ? s <= today : Date.parse(s) <= now.getTime()),
        'A letter cannot have been sent on a date that has not come yet.',
      )
      .optional(),
    kind: z.enum(OUTGOING_KINDS).optional(),
    caseRespondentId: z.string().uuid().nullish(),
    // A copy only the assistant recognised: the register's own addresses did not show it
    // was one, and the officer is filing it as one from the panel all the same.
    asCouncilCopy: z.boolean().optional(),
  });
}

/**
 * The moment a letter is recorded as sent. A bare date means "that day", read in the
 * council's own calendar as the "I have sent this" route reads it (06:00 UTC, midday in
 * Bengaluru) - except that a letter sent today cannot be recorded as sent later than now.
 */
export function sentAtFrom(value: string, today: string, now: Date = new Date()): Date {
  if (!DATE_ONLY.test(value)) return new Date(value);
  const at = new Date(`${value}T06:00:00Z`);
  return value === today && at.getTime() > now.getTime() ? now : at;
}

/**
 * What the message page asks the plan for, from its own address: the case chosen for the
 * copy and the letter the officer said it is - each only when it is something the route
 * will accept. A hand-edited address falls back to the suggested case, rather than reaching
 * the officer as a refusal in field names.
 */
export function copyQueryOf(query: { case?: string; kind?: string }): {
  caseId: string | null;
  kind: Exclude<CorrespondenceKind, 'inbound'> | null;
} {
  const caseId = query.case && z.string().uuid().safeParse(query.case).success ? query.case : null;
  const kind = (OUTGOING_KINDS as readonly string[]).includes(query.kind ?? '')
    ? (query.kind as Exclude<CorrespondenceKind, 'inbound'>)
    : null;
  return { caseId, kind };
}

/** When the plan could not be worked out: never a field name and never the response itself. */
export const PLAN_FAILED =
  'What filing it on that case would mean could not be worked out. Reload the page, or choose the case again.';

/**
 * The line the message page shows when the plan could not be had. Only a refusal the
 * register words for the officer (409, 422) is passed on as it came; a refused committee
 * member is told why; anything else - a malformed request, a failure at our end - is one
 * plain sentence.
 */
export function planErrorText(status: number | null, message: string | null): string {
  if (status === 403) return 'Only the dental officer can file mail on a case.';
  if ((status === 409 || status === 422) && message?.trim()) return message;
  return PLAN_FAILED;
}
