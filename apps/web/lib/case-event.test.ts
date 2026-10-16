import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { caseEventInput } from './case-event';
import { isRealDate, timestampOfTypedDate } from './typed-date';

/**
 * Recording something on a case: POST /v1/cases/[id]/events/[event].
 *
 * "Issue a notice" was refused every time, because the form sent no `notice` and the
 * engine will not move a dentist's notice count without the officer's word on how and
 * when it went out. The form now asks; this holds the route to checking what it is given
 * before the engine sees it - a mistyped date is a sentence for the officer, never
 * "Invalid Date" on its way to the database.
 *
 * The route is called through the real withAuth(), with the sign-in and the services
 * replaced, as officer-only.test.ts does: the lifecycle service records what reached it.
 */

const CASE_ID = '0b6c3f6e-1111-4111-8111-111111111111';
const RESPONDENT_ID = '0b6c3f6e-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({ applied: [] as unknown[] }));

vi.mock('./auth-adapter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth-adapter')>()),
  identityFromRequest: async () => ({
    councilId: '0b6c3f6e-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: '0b6c3f6e-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    role: 'officer',
    sessionId: 'session',
    email: 'officer@ksdc.in',
    name: 'The Officer',
  }),
}));

vi.mock('@ksdc/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ksdc/core')>();
  return {
    ...actual,
    getServices: async () => ({
      lifecycle: {
        apply: async (_tx: unknown, _ctx: unknown, input: unknown) => {
          state.applied.push(input);
          return { from: 'under_scrutiny', to: 'awaiting_respondent_reply' };
        },
      },
    }),
    inCouncilScope: async (
      _identity: unknown,
      _requestId: unknown,
      fn: (tx: unknown, ctx: unknown) => Promise<unknown>,
    ) =>
      fn(
        {},
        {
          councilId: '0b6c3f6e-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          userId: 'u',
          config: { calendar: { timezone: 'Asia/Kolkata' } },
        },
      ),
  };
});

const { POST } = await import('@/app/v1/cases/[id]/events/[event]/route');

/** Today, as the Council's calendar has it - the date input's default. */
function todayInKolkata(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

async function post(event: string, body: unknown) {
  const req = new NextRequest(`http://localhost/v1/cases/${CASE_ID}/events/${event}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(req, { params: Promise.resolve({ id: CASE_ID, event }) });
  return { status: res.status, body: (await res.json()) as { message?: string } };
}

beforeEach(() => {
  state.applied = [];
});

describe('issuing a notice sent outside the software', () => {
  it('passes a notice with a service mode and a date through to the engine', async () => {
    const { status } = await post('ISSUE_RESPONDENT_NOTICE', {
      caseRespondentId: RESPONDENT_ID,
      notice: { serviceMode: 'speed_post', sentAt: '2026-10-12' },
    });
    expect(status).toBe(200);
    expect(state.applied).toHaveLength(1);
    expect(state.applied[0]).toMatchObject({
      caseFileId: CASE_ID,
      event: 'ISSUE_RESPONDENT_NOTICE',
      caseRespondentId: RESPONDENT_ID,
      // A bare date read exactly as "I have sent this" reads it.
      notice: { serviceMode: 'speed_post', sentAt: timestampOfTypedDate('2026-10-12') },
    });
    const applied = state.applied[0] as { notice: { sentAt: Date }; occurredAt?: Date };
    const sentAt = applied.notice.sentAt;
    expect(sentAt).toBeInstanceOf(Date);
    expect(sentAt.toISOString()).toBe('2026-10-12T06:00:00.000Z');
    // The event itself happened that day too, as "I have sent this" records it, so the
    // dentist's reply follow-up runs from 12 October, not from the day it was typed in.
    expect(applied.occurredAt?.toISOString()).toBe('2026-10-12T06:00:00.000Z');
  });

  it('takes a notice dated today in the Council calendar, whatever the hour in UTC', async () => {
    const { status } = await post('ISSUE_RESPONDENT_NOTICE', {
      caseRespondentId: RESPONDENT_ID,
      notice: { serviceMode: 'email', sentAt: todayInKolkata() },
    });
    expect(status).toBe(200);
  });

  it.each([
    ['no service mode', { sentAt: '2026-10-12' }, /how the notice was sent/i],
    [
      'a service mode that does not exist',
      { serviceMode: 'pigeon', sentAt: '2026-10-12' },
      /how the notice was sent/i,
    ],
    ['no date', { serviceMode: 'email' }, /date the notice went out/i],
    ['a date that is not one', { serviceMode: 'email', sentAt: 'yesterday' }, /not a date/i],
    ['30 February', { serviceMode: 'email', sentAt: '2026-02-30' }, /not a date/i],
    [
      'a date that has not come yet',
      { serviceMode: 'email', sentAt: todayInKolkata(2) },
      /not come yet/i,
    ],
  ])(
    'refuses a notice with %s, in words, before the engine sees it',
    async (_name, notice, message) => {
      const { status, body } = await post('ISSUE_RESPONDENT_NOTICE', {
        caseRespondentId: RESPONDENT_ID,
        notice,
      });
      expect(status).toBe(400);
      expect(body.message).toMatch(message);
      // Plain English: no field path, no Zod vocabulary, no "Invalid Date".
      expect(body.message).not.toMatch(/notice\.|Invalid|Expected|Required/);
      expect(state.applied).toHaveLength(0);
    },
  );
});

describe('the other events', () => {
  it('passes what the case page sends for each through unchanged', async () => {
    expect((await post('REQUEST_DOCUMENTS', {})).status).toBe(200);
    expect((await post('PUT_ON_HOLD', { reason: 'Matter before the High Court' })).status).toBe(
      200,
    );
    expect(
      (await post('RECORD_RESPONDENT_REPLY', { caseRespondentId: RESPONDENT_ID })).status,
    ).toBe(200);
    expect(
      (await post('CLOSE', { reason: 'Withdrawn in writing', closureReason: 'withdrawn' })).status,
    ).toBe(200);
    expect(state.applied).toHaveLength(4);
    expect(state.applied[3]).toMatchObject({
      event: 'CLOSE',
      reason: 'Withdrawn in writing',
      closureReason: 'withdrawn',
    });
  });

  it('refuses an event that does not exist, a field nobody sends, and a bad closure reason', async () => {
    const unknown = await post('acknowledge', {});
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toMatch(/not something that can be recorded/);

    const extra = await post('REQUEST_DOCUMENTS', { sentOn: '2026-10-12' });
    expect(extra.status).toBe(400);
    expect(extra.body.message).toMatch(/field this form does not send/);

    const closure = await post('CLOSE', { reason: 'x reason', closureReason: 'bored' });
    expect(closure.status).toBe(400);
    expect(closure.body.message).toMatch(/why the case is being closed/);

    expect(state.applied).toHaveLength(0);
  });

  it('refuses opening a case and the engine-only "every dentist resolved", in words', async () => {
    const intake = await post('LOG_INTAKE', {});
    expect(intake.status).toBe(400);
    expect(intake.body.message).toMatch(/opened from the intake screen/);

    const resolved = await post('ALL_RESPONDENTS_RESOLVED', {});
    expect(resolved.status).toBe(400);
    expect(resolved.body.message).toMatch(/records this itself/);

    expect(state.applied).toHaveLength(0);
  });
});

describe('caseEventInput', () => {
  const now = new Date('2026-10-16T03:30:00Z'); // 9am in Bengaluru
  const today = '2026-10-16';

  it('takes a notice sent today even though 06:00 UTC today is still ahead of the clock', () => {
    const input = caseEventInput(
      'ISSUE_RESPONDENT_NOTICE',
      { caseRespondentId: RESPONDENT_ID, notice: { serviceMode: 'email', sentAt: today } },
      today,
      now,
    );
    expect(input.notice?.sentAt.toISOString()).toBe('2026-10-16T06:00:00.000Z');
  });

  it('refuses tomorrow, and a full timestamp later than now', () => {
    for (const sentAt of ['2026-10-17', '2026-10-16T05:00:00Z']) {
      expect(() =>
        caseEventInput(
          'ISSUE_RESPONDENT_NOTICE',
          { caseRespondentId: RESPONDENT_ID, notice: { serviceMode: 'email', sentAt } },
          today,
          now,
        ),
      ).toThrow(/not come yet/);
    }
  });

  it('refuses a backfilled date that is not one, rather than writing Invalid Date', () => {
    expect(() =>
      caseEventInput('REQUEST_DOCUMENTS', { occurredAt: 'last Tuesday' }, today, now),
    ).toThrow(/not a date/);
    expect(() =>
      caseEventInput('REQUEST_DOCUMENTS', { occurredAt: '2026-10-17' }, today, now),
    ).toThrow(/not come yet/);
    const backfilled = caseEventInput(
      'REQUEST_DOCUMENTS',
      { occurredAt: '2026-08-04', dateSource: 'from_physical_register' },
      today,
      now,
    );
    expect(backfilled.occurredAt?.toISOString()).toBe('2026-08-04T00:00:00.000Z');
    expect(backfilled.dateSource).toBe('from_physical_register');
  });

  it('refuses a proof-of-service document it cannot check belongs to the case', () => {
    expect(() =>
      caseEventInput(
        'ISSUE_RESPONDENT_NOTICE',
        {
          caseRespondentId: RESPONDENT_ID,
          notice: {
            serviceMode: 'email',
            sentAt: '2026-10-12',
            serviceProofDocumentId: '0b6c3f6e-4444-4444-8444-444444444444',
          },
        },
        today,
        now,
      ),
    ).toThrow(/field this form does not send/);
  });

  it('refuses the empty choice the form starts on, in words', () => {
    expect(() =>
      caseEventInput(
        'ISSUE_RESPONDENT_NOTICE',
        { caseRespondentId: RESPONDENT_ID, notice: { serviceMode: '', sentAt: '2026-10-12' } },
        today,
        now,
      ),
    ).toThrow(/Say how the notice was sent/);
  });
});

describe('isRealDate', () => {
  it('takes real days and timestamps and nothing else', () => {
    expect(isRealDate('2026-10-12')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-10-12T06:00:00Z')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2026-13-01')).toBe(false);
    expect(isRealDate('')).toBe(false);
    expect(isRealDate('soon')).toBe(false);
  });
});
