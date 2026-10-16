import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentOpenHref } from './document-link';
import { OFFICER_ONLY_MESSAGE } from './route';

/**
 * Opening a paper from the case page: GET /v1/documents/[id]/download.
 *
 * The route answered every caller with JSON ({ url, expiresAt, filename }), so the case
 * page's "Open" link showed the officer a line of text instead of the file. A link the
 * website renders now carries `?open=1` and is answered with a redirect to the signed
 * link; an API caller that asks without it still gets the JSON.
 *
 * The access-log row is written inside DocumentsService.downloadUrl() (its own test in
 * @ksdc/core reads the row back from the database). What this holds is that every open,
 * in either form, goes through downloadUrl() - with the caller's address and browser, which
 * is what the row records - so no open can skip the log. The service here keeps that log.
 */

const DOC_ID = '0b6c3f6e-3333-4333-8333-333333333333';
const SIGNED = 'https://storage.example.test/object/sign/documents/abc?token=t0k3n';

const state = vi.hoisted(() => ({
  role: 'officer' as string,
  accessLog: [] as Array<{ documentId: string; ip: string | null; userAgent: string | null }>,
}));

vi.mock('./auth-adapter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth-adapter')>()),
  identityFromRequest: async () => ({
    councilId: '0b6c3f6e-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: '0b6c3f6e-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    role: state.role,
    sessionId: 'session',
    email: 'someone@ksdc.in',
    name: 'Someone',
  }),
}));

vi.mock('@ksdc/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ksdc/core')>();
  return {
    ...actual,
    getServices: async () => ({
      documents: {
        // As the real one does: the row is written before the link is handed back.
        downloadUrl: async (
          _tx: unknown,
          _ctx: unknown,
          args: { documentId: string; ip?: string | null; userAgent?: string | null },
        ) => {
          state.accessLog.push({
            documentId: args.documentId,
            ip: args.ip ?? null,
            userAgent: args.userAgent ?? null,
          });
          return {
            url: SIGNED,
            expiresAt: new Date('2026-10-16T06:05:00Z'),
            filename: 'bill.pdf',
          };
        },
      },
    }),
    inCouncilScope: async (
      _identity: unknown,
      _requestId: unknown,
      fn: (tx: unknown, ctx: unknown) => Promise<unknown>,
    ) => fn({}, { councilId: '0b6c3f6e-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId: 'u', config: {} }),
  };
});

const { GET } = await import('@/app/v1/documents/[id]/download/route');

async function open(href: string) {
  const req = new NextRequest(new URL(href, 'http://localhost'), {
    headers: { 'x-forwarded-for': '10.1.2.3', 'user-agent': 'Firefox on the office PC' },
  });
  return GET(req, { params: Promise.resolve({ id: DOC_ID }) });
}

beforeEach(() => {
  state.role = 'officer';
  state.accessLog = [];
});

describe('opening a paper', () => {
  it('sends a browser following the case page link to the file itself', async () => {
    const res = await open(documentOpenHref('', DOC_ID));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(SIGNED);
    // A cached redirect would hand out an expired link, or one never logged for this open.
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('still answers an API caller that does not ask for the file with the JSON', async () => {
    const res = await open(`/v1/documents/${DOC_ID}/download`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: SIGNED,
      expiresAt: '2026-10-16T06:05:00.000Z',
      filename: 'bill.pdf',
    });
  });

  it('logs every open, in either form, with who asked from where', async () => {
    await open(documentOpenHref('', DOC_ID));
    await open(documentOpenHref('', DOC_ID));
    await open(`/v1/documents/${DOC_ID}/download`);
    expect(state.accessLog).toEqual([
      { documentId: DOC_ID, ip: '10.1.2.3', userAgent: 'Firefox on the office PC' },
      { documentId: DOC_ID, ip: '10.1.2.3', userAgent: 'Firefox on the office PC' },
      { documentId: DOC_ID, ip: '10.1.2.3', userAgent: 'Firefox on the office PC' },
    ]);
  });

  it.each(['committee_member', 'auditor'])(
    'refuses a %s with 403, issuing no link and logging nothing',
    async (role) => {
      state.role = role;
      for (const href of [documentOpenHref('', DOC_ID), `/v1/documents/${DOC_ID}/download`]) {
        const res = await open(href);
        expect(res.status).toBe(403);
        expect(res.headers.get('location')).toBeNull();
        expect(((await res.json()) as { message: string }).message).toBe(OFFICER_ONLY_MESSAGE);
      }
      expect(state.accessLog).toEqual([]);
    },
  );
});

describe('documentOpenHref', () => {
  it('asks for the file, on the API address the page was given', () => {
    expect(documentOpenHref('', DOC_ID)).toBe(`/v1/documents/${DOC_ID}/download?open=1`);
    expect(documentOpenHref('https://api.example.test', DOC_ID)).toBe(
      `https://api.example.test/v1/documents/${DOC_ID}/download?open=1`,
    );
  });
});
