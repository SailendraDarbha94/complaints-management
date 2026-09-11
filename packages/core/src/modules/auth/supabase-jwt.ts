import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { UnauthorizedError } from '../../common/domain-error.js';
import type { Role } from '@ksdc/contracts';
import type { RequestIdentity } from '../../context/council-context.js';

/**
 * Verifying a Supabase access token.
 *
 * Four things here are load-bearing, and three of them fail silently if you get them
 * wrong - which is why each is spelled out rather than left to a reader's assumption.
 *
 *   ISSUER AND AUDIENCE ARE NOT OPTIONAL. jose skips both checks when the option is
 *   absent, and the happy path still returns a payload, so the mistake is invisible in
 *   testing. Without the audience check this would accept a token minted for `anon`.
 *
 *   THE ALGORITHM LIST EXCLUDES HS256 ON PURPOSE. This project's tokens are ES256, signed
 *   with a key published at the JWKS endpoint. Allowing a symmetric algorithm alongside an
 *   asymmetric key set is the classic algorithm-confusion shape: an attacker signs with
 *   the public key as if it were a shared secret. Verified against the live project on
 *   2026-09-11: alg ES256, kid from /auth/v1/.well-known/jwks.json.
 *
 *   THE KEY SET IS BUILT ONCE PER PROCESS. createRemoteJWKSet keeps its cache in closure
 *   state; constructing it inside a request handler means a network fetch on every call
 *   and defeats its own rate limiting.
 *
 *   THE COUNCIL COMES FROM app_metadata, NEVER user_metadata. A signed-in user can write
 *   their own user_metadata through the Auth API. A council_id there would be a tenant
 *   identifier chosen by the tenant, which is the whole ball game - row-level security
 *   filters on exactly this value. app_metadata is writable only with the secret key.
 *
 * The claims themselves are put there by public.custom_access_token_hook, a Postgres
 * function GoTrue calls while minting the token. See migration 0006.
 */

interface SupabaseClaims extends JWTPayload {
  email?: string;
  app_metadata?: {
    council_id?: string;
    council_role?: string;
    app_user_id?: string;
  };
  user_metadata?: { full_name?: string };
  session_id?: string;
}

const ROLES = new Set<Role>(['officer', 'committee_member', 'auditor']);

/** Derived from one value, so the issuer and the JWKS URL cannot drift apart. */
function projectUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error('AUTH_DRIVER=supabase needs SUPABASE_URL (https://<ref>.supabase.co).');
  }
  return url.replace(/\/+$/, '');
}

let cached: { issuer: string; jwks: ReturnType<typeof createRemoteJWKSet> } | undefined;

function keys() {
  if (cached) return cached;
  const base = projectUrl();
  cached = {
    issuer: `${base}/auth/v1`,
    jwks: createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`)),
  };
  return cached;
}

/** Test seam. The key set caches in closure state, so it has to be rebuildable. */
export function resetSupabaseKeyCache(): void {
  cached = undefined;
}

export async function identityFromSupabaseToken(token: string): Promise<RequestIdentity> {
  const { issuer, jwks } = keys();

  let claims: SupabaseClaims;
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: 'authenticated',
      algorithms: ['ES256', 'RS256'],
      requiredClaims: ['sub', 'exp', 'iat'],
      // Cloud Run and Supabase are not on the same clock to the millisecond.
      clockTolerance: 5,
    });
    claims = payload as SupabaseClaims;
  } catch {
    // Expired, forged and malformed all get the same answer. The difference is useful
    // only to somebody probing.
    throw new UnauthorizedError('Session expired.');
  }

  const meta = claims.app_metadata ?? {};

  if (!meta.council_id || !meta.app_user_id) {
    // Signed in to Supabase, but not a member of any council this register knows about -
    // or a member of two with no active one chosen. Either way there is no tenant to act
    // for, and guessing one is how a complaint lands in the wrong council's register.
    throw new UnauthorizedError(
      'That account is not an active member of any council in this register.',
    );
  }

  const role = meta.council_role;
  if (!role || !ROLES.has(role as Role)) {
    throw new UnauthorizedError('That account has no recognised role in this council.');
  }

  return {
    councilId: meta.council_id,
    userId: meta.app_user_id,
    role: role as Role,
    // Supabase's session id, so signing out of a session still means something here.
    sessionId: claims.session_id ?? (claims.sub as string),
    email: claims.email ?? '',
    name: claims.user_metadata?.full_name ?? claims.email ?? 'Unknown',
  };
}
