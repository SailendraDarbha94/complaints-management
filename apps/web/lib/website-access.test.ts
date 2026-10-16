import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Session } from './api';
import { WEBSITE_NOTICE, websiteAccess } from './website-access';

/**
 * Who sees the website's pages, and who sees the one page that sends them to the phone.
 *
 * The decision is called with the session the API would give, and the page walk below holds
 * every page to calling it before it fetches anything - so a page added later that forgets
 * is a red build, as a route that forgets is in routes.test.ts.
 */

const fetchSession = vi.hoisted(() => vi.fn<() => Promise<Session>>());

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  fetchSession,
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirected to ${to}`);
  },
}));

function session(role: string, name = 'Dr. A. Member', email = 'member@ksdc.in'): Session {
  return { user: { id: 'u', email, name }, council: { councilId: 'c', role } };
}

// Braces, not an arrow's value: a function returned from beforeEach is run as its teardown.
beforeEach(() => {
  fetchSession.mockReset();
});

describe('the website, for each role', () => {
  it.each(['committee_member', 'auditor'])('shows a %s the notice, and who they are signed in as', async (role) => {
    fetchSession.mockResolvedValue(session(role));
    const access = await websiteAccess();
    expect(access).toMatchObject({
      officer: false,
      notice: WEBSITE_NOTICE,
      signedInAs: 'Dr. A. Member (member@ksdc.in)',
    });
  });

  it('says the notice in the words the Council asked for', () => {
    expect(WEBSITE_NOTICE).toBe(
      "This website is for the Council's dental officer. Committee members read cases in the KSDC phone app.",
    );
  });

  it('turns away a role it does not know, rather than letting it through', async () => {
    fetchSession.mockResolvedValue(session('registrar'));
    expect((await websiteAccess()).officer).toBe(false);
  });

  it('names a member by address alone when that is all there is', async () => {
    fetchSession.mockResolvedValue(session('auditor', '', 'audit@ksdc.in'));
    expect(await websiteAccess()).toMatchObject({ officer: false, signedInAs: 'audit@ksdc.in' });
  });

  it('lets the officer through, with the session the page needs', async () => {
    const officer = session('officer', 'Dr. Officer', 'officer@ksdc.in');
    fetchSession.mockResolvedValue(officer);
    expect(await websiteAccess()).toEqual({ officer: true, session: officer });
  });

  it('sends someone not signed in to /signin, as every page did', async () => {
    fetchSession.mockRejectedValue(new ApiError(401, 'Not signed in.'));
    await expect(websiteAccess()).rejects.toThrow('redirected to /signin');
  });

  it('passes any other failure on to the page', async () => {
    fetchSession.mockRejectedValue(new ApiError(500, 'Something went wrong at our end.'));
    await expect(websiteAccess()).rejects.toThrow('Something went wrong at our end.');
  });
});

// ─── Every page asks first ───────────────────────────────────────────────────

const APP = join(process.cwd(), 'app');

/** Pages that do not call the check, and why. Adding one is the decision. */
const NOT_CHECKED: Record<string, string> = {
  'signin/page.tsx': 'Signing in has to work for everyone, before anyone is known.',
  'page.tsx': 'Only redirects to /today, which is checked; it renders and fetches nothing.',
};

function pages(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'v1') found.push(...pages(full));
    } else if (entry === 'page.tsx') found.push(full);
  }
  return found;
}

const all = pages(APP).map((f) => [relative(APP, f).split(sep).join('/'), f] as const);

describe('every page of the website', () => {
  it('is found, so a broken walk cannot make this vacuous', () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it.each(all.filter(([name]) => !(name in NOT_CHECKED)))(
    '%s turns a non-officer away before it fetches anything',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');
      const body = source.slice(source.indexOf('export default'));
      const gate = body.indexOf('await officerOnly()');
      expect(gate, 'the page never calls officerOnly()').toBeGreaterThan(-1);
      expect(body.slice(gate), 'the notice is not returned').toMatch(/^await officerOnly\(\);[\s\S]*?if \(gate\.notice\) return gate\.notice;/);
      // Nothing from the register is asked for before the check.
      const firstFetch = body.search(/\bfetch[A-Z]\w*\(/);
      if (firstFetch > -1) expect(gate).toBeLessThan(firstFetch);
    },
  );

  it('states a reason for each page that is not checked', () => {
    for (const [page, reason] of Object.entries(NOT_CHECKED)) {
      expect(reason.length, `${page} needs a real reason`).toBeGreaterThan(20);
      expect(all.some(([name]) => name === page), `${page} no longer exists`).toBe(true);
    }
  });
});

// ─── What the code and the docs tell the next person ────────────────────────

describe('pointers to this rule', () => {
  it('names, in website-access.ts, test files that exist', () => {
    // Someone adding a page looks there for the test that guards it. A name that leads
    // nowhere reads as "not enforced", and the gate gets skipped or the walk duplicated.
    const source = readFileSync(join(process.cwd(), 'lib', 'website-access.ts'), 'utf8');
    const named = [...source.matchAll(/[\w./-]+\.test\.ts/g)].map((m) => m[0]);
    expect(named, 'the header no longer says which test guards the pages').toContain(
      'lib/website-access.test.ts',
    );
    for (const name of named) {
      expect(() => statSync(join(process.cwd(), name)), `${name} does not exist`).not.toThrow();
    }
  });

  it('does not tell anyone in the mail guide that committee members read Inward mail here', () => {
    // The officer reads this guide. Telling a member they can review Inward mail on the
    // website sends them to a page that only shows the notice.
    const docs = join(process.cwd(), '..', '..', 'docs');
    const guide = readFileSync(join(docs, 'mail-assistant.md'), 'utf8');
    expect(guide).not.toMatch(/committee member can read everything/i);
    const link = /\]\((adr\/0003-[\w-]+\.md)\)/.exec(guide);
    expect(link, 'the guide no longer points at ADR-0003').not.toBeNull();
    expect(() => statSync(join(docs, link![1]!)), 'the ADR-0003 link does not resolve').not.toThrow();
  });
});
