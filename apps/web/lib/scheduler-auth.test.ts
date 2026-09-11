import { describe, expect, it } from 'vitest';
import { assertScheduler } from './scheduler-auth';

/**
 * Who may run the council's daily job.
 *
 * A security audit found this accepting ANY header starting with "Bearer " - confirmed
 * against the running app: 403 with no header, 200 with "Bearer totally-made-up". The
 * reasoning had been that Cloud Run terminates OIDC before the request arrives, which is
 * true of exactly one deployment and was stated in a comment as though the code checked
 * the token. It did not.
 */

import type { NextRequest } from 'next/server';

/** Only the headers matter, so this is all a NextRequest needs to be here. */
const req = (headers: Record<string, string>) =>
  ({ headers: new Headers(headers) }) as unknown as NextRequest;

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const before = { ...process.env };
  Object.assign(process.env, vars);
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  try {
    fn();
  } finally {
    process.env = before;
  }
}

describe('with a scheduler secret configured', () => {
  const SECRET = 'a-real-secret-value-9f3c2a';

  it('accepts the right secret in the dedicated header', () => {
    withEnv({ SCHEDULER_SECRET: SECRET }, () => {
      expect(() => assertScheduler(req({ 'x-scheduler-secret': SECRET }))).not.toThrow();
    });
  });

  it('accepts it as a bearer token, for callers that only send Authorization', () => {
    withEnv({ SCHEDULER_SECRET: SECRET }, () => {
      expect(() => assertScheduler(req({ authorization: `Bearer ${SECRET}` }))).not.toThrow();
    });
  });

  it.each([
    ['an arbitrary bearer token', { authorization: 'Bearer totally-made-up' }],
    ['a bare Bearer prefix', { authorization: 'Bearer ' }],
    ['the wrong secret', { 'x-scheduler-secret': 'not-it' }],
    ['a prefix of the secret', { 'x-scheduler-secret': SECRET.slice(0, 10) }],
    ['the secret plus a suffix', { 'x-scheduler-secret': SECRET + 'x' }],
    ['no header at all', {}],
    ['the development bypass', { 'x-dev-scheduler': '1' }],
  ])('refuses %s', (_label, headers) => {
    withEnv({ SCHEDULER_SECRET: SECRET }, () => {
      expect(() => assertScheduler(req(headers))).toThrow(/scheduler, not by a person/i);
    });
  });
});

describe('with no scheduler secret configured', () => {
  it('refuses outright in production rather than falling open', () => {
    withEnv({ SCHEDULER_SECRET: undefined, NODE_ENV: 'production' }, () => {
      expect(() => assertScheduler(req({ authorization: 'Bearer anything' }))).toThrow(
        /SCHEDULER_SECRET is not set/i,
      );
    });
  });

  it('still refuses an arbitrary bearer token in development', () => {
    withEnv({ SCHEDULER_SECRET: undefined, NODE_ENV: 'development' }, () => {
      expect(() => assertScheduler(req({ authorization: 'Bearer totally-made-up' }))).toThrow();
    });
  });

  it('allows the explicit development header, which production never reaches', () => {
    withEnv({ SCHEDULER_SECRET: undefined, NODE_ENV: 'development' }, () => {
      expect(() => assertScheduler(req({ 'x-dev-scheduler': '1' }))).not.toThrow();
    });
  });
});
