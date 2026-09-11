import { UnauthorizedError } from '../../common/domain-error.js';
import type { RequestIdentity } from '../../context/council-context.js';
import type { TokenService } from './token.service.js';

/**
 * Turning a bearer token into an identity.
 *
 * This was the Nest guard. It is now a function, because the App Router has no global
 * guard to register and a function can be called from a route wrapper, a server action or
 * a test without booting anything.
 *
 * Defaulting to closed still matters more than usual here: an endpoint added in six months
 * and forgotten about should be unreachable, not open. On a legal register the cost of
 * forgetting is not a bug report, it is a disclosure. Nest gave that for free with a
 * global guard; the web app has to buy it back, and it does - see withAuth() in
 * apps/web/lib/route.ts, and the test that asserts every route file uses it.
 */

export const ACCESS_COOKIE = 'ksdc_at';
export const REFRESH_COOKIE = 'ksdc_rt';

export async function identityFromToken(
  tokens: TokenService,
  token: string | null | undefined,
): Promise<RequestIdentity> {
  if (!token) throw new UnauthorizedError('Not signed in.');

  try {
    const claims = await tokens.verifyAccessToken(token);
    return {
      councilId: claims.councilId,
      userId: claims.sub,
      role: claims.role,
      sessionId: claims.sid,
      email: claims.email,
      name: claims.name,
    };
  } catch {
    // Never distinguish expired from forged from malformed. The client's answer is the
    // same in all three cases: refresh, then sign in.
    throw new UnauthorizedError('Session expired.');
  }
}

/**
 * The cookie is the browser's path; the Authorization header is for the mobile app and
 * for curl. Both carry the same token.
 *
 * Takes the two values rather than a request object, so it does not care whether it is
 * being handed a Fetch Request, a Fastify request or a test fixture.
 */
export function tokenFrom(args: {
  authorization?: string | null;
  cookie?: string | null;
}): string | null {
  if (args.authorization?.startsWith('Bearer ')) {
    return args.authorization.slice('Bearer '.length).trim() || null;
  }
  return args.cookie ?? null;
}
