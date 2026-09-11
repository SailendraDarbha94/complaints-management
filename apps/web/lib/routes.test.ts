import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guardKind } from './route';

/**
 * The default-closed test.
 *
 * NestJS registered one global guard, so every endpoint was authenticated unless it said
 * @Public(). The App Router has no equivalent: a file called route.ts is live the moment
 * it exists, authenticated only if its author remembered. That inverts the default from
 * closed to open, and on a legal register the cost of forgetting is a disclosure rather
 * than a bug report.
 *
 * This is what buys it back. It walks app/v1, imports every route file, and fails if any
 * exported HTTP method did not come out of withAuth() or withPublic(). An endpoint added
 * in six months and forgotten about is therefore a red build, not an open door.
 *
 * The second test is the one that matters more: it enumerates every public endpoint, so
 * making something public is a visible, reviewed diff to a list in this file rather than a
 * quiet decision inside a route nobody reads again.
 */

const V1 = join(process.cwd(), 'app', 'v1');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/**
 * Every endpoint that may be reached without a session, and why.
 *
 * Adding a line here is the decision. If this list and the code disagree, the test fails
 * in whichever direction the disagreement runs: an unlisted public route, or a listed one
 * that is no longer public.
 */
const EXPECTED_PUBLIC: Record<string, string> = {
  'auth/code:POST': 'Requesting a sign-in code: there is no session yet, by definition.',
  'auth/verify:POST': 'Exchanging a code for a session.',
  'auth/password:POST': 'Signing in with a password is what creates the session.',
  'auth/refresh:POST': 'Rotating a session on the refresh cookie alone.',
  'auth/signout:POST': 'Must work even when the access token has already expired.',
  'storage/local:PUT': 'A signed URL carries its own authority; local-disk driver only.',
  'storage/local:GET': 'A signed URL carries its own authority; local-disk driver only.',
  'internal/jobs/daily:POST': 'Called by Cloud Scheduler with its own OIDC credential.',
};

/**
 * Import a route file by absolute path.
 *
 * NOT via pathToFileURL: that percent-encodes the square brackets in a dynamic segment, so
 * app/v1/cases/[id]/route.ts becomes .../cases/%5Bid%5D/route.ts and the resolver cannot
 * find it. Vite takes a plain posix-style absolute path, brackets and all - which means
 * the dynamic routes, the ones most worth checking, are the ones that would silently
 * disappear from this suite if it used a file URL.
 */
async function importRoute(file: string): Promise<Record<string, unknown>> {
  return (await import(/* @vite-ignore */ file.split(sep).join('/'))) as Record<string, unknown>;
}

function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...routeFiles(full));
    else if (entry === 'route.ts') found.push(full);
  }
  return found;
}

/** 'app/v1/cases/[id]/letters/route.ts' -> 'cases/[id]/letters' */
function routePath(file: string): string {
  return relative(V1, file).split(sep).slice(0, -1).join('/');
}

const files = routeFiles(V1);

describe('the route table', () => {
  it('has route files at all, so a broken glob cannot make this suite vacuous', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(files.map((f) => [routePath(f), f]))(
    '/v1/%s exports only guarded handlers',
    async (path, file) => {
      const mod = await importRoute(file);
      const exported = METHODS.filter((m) => typeof mod[m] === 'function');

      expect(exported.length, `${path}/route.ts exports no HTTP method`).toBeGreaterThan(0);

      for (const method of exported) {
        expect(
          guardKind(mod[method]),
          `${method} /v1/${path} was not created by withAuth() or withPublic(). Every ` +
            'handler must go through one of them - that is what keeps endpoints closed ' +
            'by default.',
        ).not.toBeNull();
      }
    },
  );
});

describe('what is reachable without signing in', () => {
  it('is exactly the endpoints listed in this file', async () => {
    const actual: string[] = [];

    for (const file of files) {
      const mod = await importRoute(file);
      for (const method of METHODS) {
        if (typeof mod[method] !== 'function') continue;
        if (guardKind(mod[method]) === 'public') actual.push(`${routePath(file)}:${method}`);
      }
    }

    // Sorted comparison so the failure message names the offending endpoint rather than
    // showing two shuffled lists.
    expect(actual.sort()).toEqual(Object.keys(EXPECTED_PUBLIC).sort());
  });

  it('states a reason for each, because someone has to review them', () => {
    for (const [endpoint, reason] of Object.entries(EXPECTED_PUBLIC)) {
      expect(reason.length, `${endpoint} needs a real reason`).toBeGreaterThan(20);
    }
  });
});
