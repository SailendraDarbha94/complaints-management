import { z } from 'zod';
import {
  CASE_EVENTS,
  CLOSURE_REASONS,
  DATE_SOURCES,
  SERVICE_MODES,
  transitionFor,
  type CaseEvent,
} from '@ksdc/contracts';
import { DomainError, type Services } from '@ksdc/core';
import { isInTheFuture, isRealDate, timestampOfTypedDate } from './typed-date';

/**
 * The request body for recording something on a case (POST /v1/cases/[id]/events/[event]),
 * checked before it reaches the lifecycle engine.
 *
 * Before this the route passed the body straight through, so a notice with a mistyped
 * date became "Invalid Date" on its way to the database, and a missing service mode was
 * refused only once the engine was halfway into the transaction. Here, each is refused
 * with one sentence the officer can act on.
 *
 * Here rather than in the route file because a route module may export only its handlers,
 * and this is worth testing on its own (case-event.test.ts).
 */

/** ApplyEventInput is not on @ksdc/core's index, so it is read off the service. */
type ApplyEventInput = Parameters<Services['lifecycle']['apply']>[2];
export type CaseEventInput = Omit<ApplyEventInput, 'caseFileId'>;

const id = (what: string) => z.string().uuid(`${what} is not one this register knows.`);

/**
 * Every field the engine takes from a request, as the case page sends it today. Strict:
 * a field nobody reads is more likely a misspelling of one that matters (`sentOn` for
 * `sentAt`) than something to ignore quietly.
 */
export function caseEventBody(today: string, now: Date = new Date()) {
  return z
    .object({
      reason: z.string().nullish(),
      caseRespondentId: id('That dentist').nullish(),
      closureReason: z
        .enum(CLOSURE_REASONS, {
          errorMap: () => ({ message: 'Choose why the case is being closed.' }),
        })
        .optional(),
      // A backfilled event: when it happened, and where that date came from.
      occurredAt: z
        .string()
        .refine(isRealDate, 'When it happened is not a date.')
        .refine(
          (s) => !isRealDate(s) || !isInTheFuture(s, today, now),
          'Nothing can be recorded as having happened on a date that has not come yet.',
        )
        .optional(),
      dateSource: z
        .enum(DATE_SOURCES, { errorMap: () => ({ message: 'Say where that date came from.' }) })
        .optional(),
      // For ISSUE_RESPONDENT_NOTICE: the officer's word that the notice actually went out.
      notice: z
        .object({
          serviceMode: z.enum(SERVICE_MODES, {
            errorMap: () => ({
              message:
                'Say how the notice was sent: by email, registered post, speed post, courier, by hand or WhatsApp.',
            }),
          }),
          sentAt: z
            .string({
              required_error: 'Give the date the notice went out.',
              invalid_type_error: 'Give the date the notice went out.',
            })
            .refine(isRealDate, 'The date the notice went out is not a date.')
            .refine(
              (s) => !isRealDate(s) || !isInTheFuture(s, today, now),
              'A notice cannot have gone out on a date that has not come yet.',
            ),
          correspondenceId: id('That letter').nullish(),
          // Not taken here: the engine would file any document's id as the proof of
          // service without checking it is on this case, and proof of service is what an
          // ex parte finding rests on. Refused (strict) until something checks it.
        })
        .strict('The notice has a field this form does not send.')
        .optional(),
    })
    .strict('That request has a field this form does not send.');
}

/**
 * The event and its body, checked and turned into what the engine takes. Throws a
 * DomainError (400) with every problem in plain words, never Zod's field paths.
 */
export function caseEventInput(
  event: string,
  raw: unknown,
  today: string,
  now: Date = new Date(),
): CaseEventInput {
  if (!(CASE_EVENTS as readonly string[]).includes(event)) {
    throw new DomainError(`"${event}" is not something that can be recorded on a case.`);
  }
  // Two events are in the list but are not an officer's to record here. Without this, the
  // first reached the engine and came back as a 500, and the second moved a case to the
  // committee while a dentist was still being waited on, written up as the officer's act.
  const rule = transitionFor(event as CaseEvent);
  if (rule.from === 'CREATE') {
    throw new DomainError('A case is opened from the intake screen, not recorded on one.');
  }
  if (rule.system) {
    throw new DomainError(
      'The register records this itself once every dentist has replied or been dealt with.',
    );
  }
  const parsed = caseEventBody(today, now).safeParse(raw);
  if (!parsed.success) {
    const messages = [...new Set(parsed.error.issues.map((i) => i.message))];
    throw new DomainError(messages.join(' '));
  }
  const body = parsed.data;
  // The same reading of a typed date as "I have sent this": see lib/typed-date.ts.
  const noticeSentAt = body.notice ? timestampOfTypedDate(body.notice.sentAt) : undefined;
  return {
    ...body,
    event: event as CaseEvent,
    // A notice's event happened when the notice went out, as markSent() records it, so the
    // dentist's reply follow-up, the milestone and "days waiting" run from the typed day,
    // not from the day the officer got round to recording it.
    occurredAt: body.occurredAt
      ? new Date(body.occurredAt)
      : event === 'ISSUE_RESPONDENT_NOTICE'
        ? noticeSentAt
        : undefined,
    notice: body.notice && noticeSentAt ? { ...body.notice, sentAt: noticeSentAt } : undefined,
  };
}
