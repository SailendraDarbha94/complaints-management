import { describe, expect, it, vi } from 'vitest';
import { toErrorResponse } from '@ksdc/core';
import { copyQueryOf, councilCopyBody, PLAN_FAILED, planErrorText, sentAtFrom } from './council-copy';
import { errorMessageOf } from './error-message';

/**
 * The route that files a copy of a Council letter (POST /v1/intake/[id]/council-copy) and
 * shows what filing it would mean (GET).
 *
 * The handler is called directly, with withAuth() reduced to the handler itself: what is
 * tested here is the route's own part - who may call it, and what body it accepts - not
 * the sign-in and transaction every route shares (routes.test.ts holds those to account).
 */

vi.mock('@/lib/route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./route')>()),
  withAuth: (handler: unknown) => handler,
}));

type Handler = (c: Record<string, unknown>) => Promise<unknown>;

const MESSAGE = '0b6c3f6e-1111-4111-8111-111111111111';
const CASE = '0b6c3f6e-2222-4222-8222-222222222222';
const DENTIST = '0b6c3f6e-3333-4333-8333-333333333333';

async function route() {
  return (await import('../app/v1/intake/[id]/council-copy/route')) as unknown as {
    GET: Handler;
    POST: Handler;
  };
}

function call(handler: Handler, role: string, body?: unknown, query = '') {
  const fileCouncilCopy = vi.fn(async () => ({ filedAs: 'record_only' }));
  const councilCopyPlan = vi.fn(async () => ({ actions: ['record_only'] }));
  const req = new Request(`http://localhost/v1/intake/${MESSAGE}/council-copy${query}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = handler({
    req,
    params: { id: MESSAGE },
    tx: {},
    ctx: { councilId: 'c', userId: 'u', config: { calendar: { timezone: 'Asia/Kolkata' } } },
    identity: { role },
    services: { mail: { fileCouncilCopy, councilCopyPlan } },
  });
  return { result, fileCouncilCopy, councilCopyPlan };
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    return toErrorResponse(err).status;
  }
}

const valid = { caseFileId: CASE, mode: 'record_sent', sentAt: '2026-10-10', kind: 'request_docs' };

describe('who may file a copy of a Council letter', () => {
  it('refuses a committee member, both reading the plan and filing, with 403', async () => {
    const { GET, POST } = await route();
    const post = call(POST, 'committee_member', valid);
    expect(await status(post.result)).toBe(403);
    expect(post.fileCouncilCopy).not.toHaveBeenCalled();

    const get = call(GET, 'committee_member', undefined, `?caseId=${CASE}`);
    expect(await status(get.result)).toBe(403);
    expect(get.councilCopyPlan).not.toHaveBeenCalled();
  });

  it('lets the officer, and hands the service what was asked', async () => {
    const { GET, POST } = await route();
    const post = call(POST, 'officer', { ...valid, caseRespondentId: DENTIST });
    expect(await status(post.result)).toBe(200);
    expect(post.fileCouncilCopy).toHaveBeenCalledWith(
      {},
      expect.anything(),
      expect.objectContaining({
        mailMessageId: MESSAGE,
        caseFileId: CASE,
        mode: 'record_sent',
        kind: 'request_docs',
        caseRespondentId: DENTIST,
        sentAt: new Date('2026-10-10T06:00:00Z'),
      }),
    );

    const get = call(GET, 'officer', undefined, `?caseId=${CASE}`);
    expect(await status(get.result)).toBe(200);
    expect(get.councilCopyPlan).toHaveBeenCalledWith({}, expect.anything(), {
      mailMessageId: MESSAGE,
      caseFileId: CASE,
    });
  });
});

describe('the body', () => {
  it.each([
    ['an unknown mode', { ...valid, mode: 'open_case' }],
    ['a letter received', { ...valid, kind: 'inbound' }],
    ['a kind that is no letter', { ...valid, kind: 'complaint' }],
    ['a date that has not come yet', { ...valid, sentAt: '2999-01-01' }],
    ['a timestamp that has not come yet', { ...valid, sentAt: '2999-01-01T10:00:00Z' }],
    ['something that is not a date', { ...valid, sentAt: 'last Tuesday' }],
    ['no case', { mode: 'link' }],
    ['a case that is not an id', { ...valid, caseFileId: '0042' }],
  ])('is refused with 400 for %s', async (_what, body) => {
    const { POST } = await route();
    const post = call(POST, 'officer', body);
    expect(await status(post.result)).toBe(400);
    expect(post.fileCouncilCopy).not.toHaveBeenCalled();
  });

  it('refuses a plan request without a case', async () => {
    const { GET } = await route();
    expect(await status(call(GET, 'officer', undefined, '').result)).toBe(400);
  });

  it("passes on which letter the officer said it is, and refuses one that is no letter of the Council's", async () => {
    const { GET } = await route();
    const get = call(GET, 'officer', undefined, `?caseId=${CASE}&kind=summons_respondent`);
    expect(await status(get.result)).toBe(200);
    expect(get.councilCopyPlan).toHaveBeenCalledWith({}, expect.anything(), {
      mailMessageId: MESSAGE,
      caseFileId: CASE,
      kind: 'summons_respondent',
    });
    for (const kind of ['inbound', 'complaint']) {
      const bad = call(GET, 'officer', undefined, `?caseId=${CASE}&kind=${kind}`);
      expect(await status(bad.result), kind).toBe(400);
      expect(bad.councilCopyPlan).not.toHaveBeenCalled();
    }
  });

  it("passes on the officer's word that a copy only the assistant recognised is one", async () => {
    // The page shows the copy panel for a pending "copy of a Council letter" suggestion the
    // register did not detect; without the flag the register refuses it as not a copy.
    const { POST } = await route();
    const post = call(POST, 'officer', { ...valid, asCouncilCopy: true });
    expect(await status(post.result)).toBe(200);
    expect(post.fileCouncilCopy).toHaveBeenCalledWith({}, expect.anything(), expect.objectContaining({ asCouncilCopy: true }));
    const bad = call(POST, 'officer', { ...valid, asCouncilCopy: 'yes' });
    expect(await status(bad.result)).toBe(400);
  });

  it('accepts a bare link, with no date', () => {
    expect(councilCopyBody('2026-10-12').safeParse({ caseFileId: CASE, mode: 'link' }).success).toBe(true);
  });

  it('accepts today, in the council calendar, but not tomorrow', () => {
    const schema = councilCopyBody('2026-10-12', new Date('2026-10-12T03:00:00Z'));
    expect(schema.safeParse({ ...valid, sentAt: '2026-10-12' }).success).toBe(true);
    expect(schema.safeParse({ ...valid, sentAt: '2026-10-13' }).success).toBe(false);
  });
});

describe('the moment a letter is recorded as sent', () => {
  it('is midday in Bengaluru on the day given', () => {
    expect(sentAtFrom('2026-10-10', '2026-10-12').toISOString()).toBe('2026-10-10T06:00:00.000Z');
  });

  it('is never later than now for a letter sent today', () => {
    const now = new Date('2026-10-12T03:00:00Z'); // 08:30 in Bengaluru
    expect(sentAtFrom('2026-10-12', '2026-10-12', now)).toEqual(now);
  });

  it('takes a full timestamp as it is', () => {
    expect(sentAtFrom('2026-10-10T09:15:00Z', '2026-10-12').toISOString()).toBe('2026-10-10T09:15:00.000Z');
  });
});

describe('"It is a reply - add it as received"', () => {
  it("hands the officer's word to the service, and nothing else", async () => {
    const { POST } = (await import('../app/v1/intake/[id]/file/route')) as unknown as { POST: Handler };
    const fileOnCase = vi.fn(async () => ({ documentsFiled: 0 }));
    const run = (body: unknown) =>
      POST({
        req: new Request(`http://localhost/v1/intake/${MESSAGE}/file`, { method: 'POST', body: JSON.stringify(body) }),
        params: { id: MESSAGE },
        tx: {},
        ctx: {},
        identity: { role: 'officer' },
        services: { mail: { fileOnCase } },
      });
    await run({ caseFileId: CASE, asReceived: true });
    expect(fileOnCase).toHaveBeenLastCalledWith({}, {}, { mailMessageId: MESSAGE, caseFileId: CASE, asReceived: true });
    await run({ caseFileId: CASE });
    expect(fileOnCase).toHaveBeenLastCalledWith({}, {}, { mailMessageId: MESSAGE, caseFileId: CASE });
    expect(await status(run({ caseFileId: CASE, asReceived: 'yes' }))).toBe(400);
  });
});

describe('who may file mail on a case, or overrule the register about a copy', () => {
  const ctxOf = (role: string, body: unknown, path: string, services: Record<string, unknown>) => ({
    req: new Request(`http://localhost/v1/intake/${MESSAGE}/${path}`, { method: 'POST', body: JSON.stringify(body) }),
    params: { id: MESSAGE },
    tx: {},
    ctx: {},
    identity: { role },
    services: { mail: services },
  });

  it('refuses a committee member "Add to a case", with or without "it is a reply", with 403', async () => {
    const { POST } = (await import('../app/v1/intake/[id]/file/route')) as unknown as { POST: Handler };
    for (const body of [{ caseFileId: CASE, asReceived: true }, { caseFileId: CASE }]) {
      const fileOnCase = vi.fn(async () => ({ documentsFiled: 0 }));
      expect(await status(POST(ctxOf('committee_member', body, 'file', { fileOnCase })))).toBe(403);
      expect(fileOnCase).not.toHaveBeenCalled();
    }
  });

  it('refuses a committee member "it is a complaint", and passes the officer\'s on', async () => {
    const { POST } = (await import('../app/v1/intake/[id]/open-case/route')) as unknown as { POST: Handler };
    const openCase = vi.fn(async () => ({ caseFileId: CASE }));
    expect(
      await status(POST(ctxOf('committee_member', { asComplaint: true }, 'open-case', { openCase }))),
    ).toBe(403);
    expect(openCase).not.toHaveBeenCalled();

    await POST(ctxOf('officer', { asComplaint: true, complainantName: 'Asha Rao' }, 'open-case', { openCase }));
    expect(openCase).toHaveBeenLastCalledWith({}, {}, {
      mailMessageId: MESSAGE,
      asComplaint: true,
      complainantName: 'Asha Rao',
    });
  });
});

describe('the message page, when the plan cannot be had', () => {
  it('never shows the response, a field name or a server failure', () => {
    expect(planErrorText(500, 'Something went wrong at our end. The failure has been logged.')).toBe(PLAN_FAILED);
    expect(planErrorText(400, "kind: Invalid enum value. Expected 'ack_complaint'")).toBe(PLAN_FAILED);
    expect(planErrorText(404, 'That case is not in the register.')).toBe(PLAN_FAILED);
    expect(planErrorText(null, null)).toBe(PLAN_FAILED);
  });

  it("tells a committee member why, and passes on the register's own refusals", () => {
    expect(planErrorText(403, 'Forbidden')).toBe('Only the dental officer can file mail on a case.');
    expect(planErrorText(409, 'That message is already on a case.')).toBe('That message is already on a case.');
  });

  it('reads the sentence out of a JSON error body, and keeps a body that is not JSON', () => {
    expect(errorMessageOf('{"statusCode":500,"message":"Something went wrong."}', 'Internal Server Error')).toBe(
      'Something went wrong.',
    );
    expect(errorMessageOf('Bad gateway', 'Bad Gateway')).toBe('Bad gateway');
    expect(errorMessageOf('', 'Bad Gateway')).toBe('Bad Gateway');
    expect(errorMessageOf('{"statusCode":500}', 'Internal Server Error')).toBe('{"statusCode":500}');
  });

  it('asks only for what the route will accept, from a hand-edited address', () => {
    expect(copyQueryOf({ case: CASE, kind: 'summons_respondent' })).toEqual({
      caseId: CASE,
      kind: 'summons_respondent',
    });
    // 36 characters of hex and dashes, but no id; a kind that is a letter received.
    expect(copyQueryOf({ case: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa-', kind: 'inbound' })).toEqual({
      caseId: null,
      kind: null,
    });
    expect(copyQueryOf({})).toEqual({ caseId: null, kind: null });
  });
});
