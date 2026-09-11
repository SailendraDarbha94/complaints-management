import type { NextRequest } from 'next/server';
import {
  ACCESS_COOKIE,
  identityFromToken,
  tokenFrom,
  UnauthorizedError,
  type RequestIdentity,
  type Services,
} from '@ksdc/core';

/**
 * The one place a request becomes an identity.
 *
 * Every authenticated route handler reaches the database through withAuth(), and
 * withAuth() resolves the caller here. That means switching from the council's own
 * passwordless tokens to Supabase Auth is an edit to this file and nothing else - which is
 * the entire point of it existing as a separate module rather than inline in route.ts.
 *
 * ── What has to be true before the Supabase branch is switched on ──────────────
 *
 * An identity is not just "who"; it is (who, which council, what role). The council is
 * what row-level security filters on, and it is what withCouncil() writes into
 * app.council_id for the span of the transaction. So a Supabase session is only usable
 * here once the council and role are carried in the JWT as custom claims - set by a
 * Supabase custom access token hook that reads council_membership - or looked up here on
 * every request, which costs a query per call.
 *
 * The claims MUST be verified, never merely decoded. Supabase signs with an asymmetric key
 * (or, on older projects, the shared JWT secret); verify against the project's JWKS and
 * check issuer and audience. A decoded-but-unverified JWT is an attacker-supplied council
 * id, and council id is the only thing standing between two councils' case files.
 *
 * ── The React Native app talking to Supabase directly ─────────────────────────
 *
 * That path does not come through here at all, and cannot: there is no server in it to
 * open a transaction or call set_config. Those queries are filtered by policies evaluated
 * against the caller's own JWT instead. That is a second, independent enforcement model
 * over the same tables, and every table the app reads needs a policy written for it -
 * the existing app.council_id policies will return zero rows for a PostgREST caller, not
 * an error, which is a silent empty screen rather than a loud failure.
 *
 * Until those policies exist, the mobile app should call these route handlers with a
 * bearer token, exactly as the current code already supports. See docs/adr/0002.
 */

export type AuthDriver = 'council' | 'supabase';

export function authDriver(): AuthDriver {
  return process.env.AUTH_DRIVER === 'supabase' ? 'supabase' : 'council';
}

export async function identityFromRequest(
  req: NextRequest,
  services: Services,
): Promise<RequestIdentity> {
  if (authDriver() === 'supabase') return supabaseIdentity(req);

  const token = tokenFrom({
    authorization: req.headers.get('authorization'),
    cookie: req.cookies.get(ACCESS_COOKIE)?.value ?? null,
  });
  return identityFromToken(services.tokens, token);
}

/**
 * Not implemented on purpose.
 *
 * Throwing here is the honest state of things: the schema has no custom-claims hook and no
 * JWT-keyed policies yet, so a half-written version of this would authenticate people into
 * a council whose rows they cannot read. It fails loudly the moment AUTH_DRIVER is set,
 * rather than at the first request that matters.
 */
async function supabaseIdentity(_req: NextRequest): Promise<RequestIdentity> {
  throw new UnauthorizedError(
    'AUTH_DRIVER=supabase is not wired up yet. It needs a custom access token hook ' +
      'putting council_id and role into the JWT, and JWKS verification here. Unset ' +
      'AUTH_DRIVER to use the council sign-in that works.',
  );
}
