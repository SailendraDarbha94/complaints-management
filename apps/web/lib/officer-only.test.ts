import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { allowedRoles, guardKind, OFFICER_ONLY_MESSAGE } from './route';

/**
 * The website is the officer's: every signed-in route, called as each role.
 *
 * routes.test.ts reads the roles each route declares. This calls the routes themselves -
 * through the real withAuth(), with only the sign-in and the database replaced - because a
 * declaration nobody checks is the hole this closes: a committee member signed in on the
 * website could read the officer's case pages, phone numbers and all, and post letters as
 * sent, follow-ups done and RTI decisions, as a database role that may write anything.
 *
 * Who is calling is set per test. The services and the transaction are traps: touching
 * either is recorded and answers 418, so "the handler ran" and "the handler never ran"
 * can both be seen from outside.
 */

const COUNCIL = '0b6c3f6e-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '0b6c3f6e-1111-4111-8111-111111111111';

const state = vi.hoisted(() => ({
  role: 'officer' as string,
  scopes: 0,
  touched: [] as string[],
}));

vi.mock('./auth-adapter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth-adapter')>()),
  identityFromRequest: async () => ({
    councilId: '0b6c3f6e-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: '0b6c3f6e-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    role: state.role,
    sessionId: 'session',
    email: 'member@ksdc.in',
    name: 'A Member',
  }),
}));

vi.mock('@ksdc/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ksdc/core')>();

  /** Any use of it is recorded, and stops the handler with a status no route answers. */
  function trap(name: string): object {
    return new Proxy(
      {},
      {
        get(_target, prop) {
          // Awaiting it, or a matcher looking at it, is not the handler using it.
          if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
          state.touched.push(`${name}.${prop}`);
          throw new actual.DomainError(`reached ${name}.${prop}`, 418);
        },
      },
    );
  }

  return {
    ...actual,
    getServices: async () => trap('services'),
    inCouncilScope: async (
      _identity: unknown,
      _requestId: unknown,
      fn: (tx: unknown, ctx: unknown) => Promise<unknown>,
    ) => {
      state.scopes++;
      return fn(trap('tx'), {
        councilId: COUNCIL,
        userId: 'u',
        config: { calendar: { timezone: 'Asia/Kolkata' } },
      });
    },
  };
});

// ─── The route table ─────────────────────────────────────────────────────────

const V1 = join(process.cwd(), 'app', 'v1');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

type Handler = (req: NextRequest, segment: { params: Promise<Record<string, string>> }) => Promise<Response>;

function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...routeFiles(full));
    else if (entry === 'route.ts') found.push(full);
  }
  return found;
}

interface Endpoint {
  path: string;
  method: (typeof METHODS)[number];
  handler: Handler;
}

async function endpoints(): Promise<Endpoint[]> {
  const out: Endpoint[] = [];
  for (const file of routeFiles(V1)) {
    // A plain posix path, not a file URL: see importRoute in routes.test.ts.
    const mod = (await import(/* @vite-ignore */ file.split(sep).join('/'))) as Record<string, unknown>;
    const path = relative(V1, file).split(sep).slice(0, -1).join('/');
    for (const method of METHODS) {
      if (guardKind(mod[method]) === 'auth') out.push({ path, method, handler: mod[method] as Handler });
    }
  }
  return out;
}

const all = await endpoints();
const officerOnly = all.filter((e) => {
  const roles = allowedRoles(e.handler);
  return roles?.length === 1 && roles[0] === 'officer';
});

/**
 * The spec's representative set, held here so that renaming one of them cannot quietly
 * drop it from the calls below: every write, and the reads that return contact details or
 * the officer's working state.
 */
const MUST_BE_OFFICER_ONLY = [
  'cases/[id]:GET',
  'intake:GET',
  'intake/[id]:GET',
  'queue:GET',
  'register:GET',
  'register/export.csv:GET',
  'rti:GET',
  'cases/[id]/letters:POST', // letters have no read of their own; they come with the case
  'templates:GET',
  'assistant/report:GET',
];

async function call(e: Endpoint, role: string): Promise<{ status: number; body: unknown }> {
  state.role = role;
  const url = `http://localhost/v1/${e.path.replace('[id]', ID).replace('[event]', 'acknowledge')}`;
  const req = new NextRequest(url, {
    method: e.method,
    // No body: a handler that reads one sees {} and refuses it with 400, which is itself
    // proof that it ran. The wrapper never answers 400.
    headers: { 'content-type': 'application/json' },
  });
  const res = await e.handler(req, { params: Promise.resolve({ id: ID, event: 'acknowledge' }) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* a CSV, or empty */
  }
  return { status: res.status, body };
}

beforeEach(() => {
  state.scopes = 0;
  state.touched = [];
});

describe('the route table this suite calls', () => {
  it('has the officer-only routes in it, so a broken walk cannot make it vacuous', () => {
    expect(officerOnly.length).toBeGreaterThan(30);
  });

  it('includes every write and the reads that carry contact details or working state', () => {
    const names = new Set(officerOnly.map((e) => `${e.path}:${e.method}`));
    for (const name of MUST_BE_OFFICER_ONLY) expect(names.has(name), name).toBe(true);
    // Every write route there is: nothing that changes the register is open to a member.
    const writes = all.filter((e) => e.method !== 'GET');
    for (const w of writes) {
      if (w.path === 'auth/council') continue; // re-mints the caller's own token; see routes.test.ts
      expect(names.has(`${w.path}:${w.method}`), `${w.method} /v1/${w.path}`).toBe(true);
    }
  });
});

describe.each(['committee_member', 'auditor'])('a %s on the website', (role) => {
  it.each(officerOnly.map((e) => [`${e.method} /v1/${e.path}`, e] as const))(
    'is refused %s with 403, before the handler runs',
    async (_name, e) => {
      const { status, body } = await call(e, role);
      expect(status).toBe(403);
      expect((body as { message?: string }).message).toBe(OFFICER_ONLY_MESSAGE);
      // No council scope opened, no service or transaction touched.
      expect(state.scopes).toBe(0);
      expect(state.touched).toEqual([]);
    },
  );

  it('may still ask who they are signed in as, which is how the website knows to send them to the phone', async () => {
    const me = all.find((e) => e.path === 'auth/me' && e.method === 'GET')!;
    const { status, body } = await call(me, role);
    expect(status).toBe(200);
    expect(body).toMatchObject({ council: { councilId: COUNCIL, role } });
  });
});

describe('the officer on the website', () => {
  it.each(officerOnly.map((e) => [`${e.method} /v1/${e.path}`, e] as const))(
    'reaches the handler for %s',
    async (_name, e) => {
      const { status } = await call(e, 'officer');
      // 418: the handler reached a service or the transaction. 400: it read the empty
      // request and refused it itself. Either way it ran; 403 would mean it did not.
      expect([400, 418]).toContain(status);
      expect(state.touched.length > 0 || status === 400).toBe(true);
      expect(state.scopes).toBe(1);
    },
  );
});
