import type { NextResponse } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE, type AuthService, type SupabaseSession } from '@ksdc/core';
import { SUPABASE_COOKIE, SUPABASE_REFRESH_COOKIE } from '@/lib/auth-adapter';

/**
 * The session cookies, and the body sign-in answers with.
 *
 * Shared by the three endpoints that mint a token - verify, refresh and council - so that
 * the options are written once. The paths in particular have to match the ones signout
 * clears with: a cookie cleared at the wrong path is not cleared at all.
 */

/** What the service hands back when a session opens. */
type SignedIn = Awaited<ReturnType<AuthService['verifyCode']>>;

export function publicShape(s: SignedIn) {
  // The tokens themselves stay in HttpOnly cookies. Returning them in the body as well
  // would put them within reach of any script on the page, which is the thing HttpOnly
  // exists to prevent.
  return { user: s.user, council: s.council, memberships: s.memberships, signedIn: true };
}

export function accessCookieOptions(expiresIn: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Lax, not Strict: the officer following a link from the digest email should land
    // signed in. Lax still blocks the cross-site POSTs that matter.
    sameSite: 'lax' as const,
    path: '/',
    maxAge: expiresIn,
  };
}

export function setSessionCookies(res: NextResponse, signedIn: SignedIn): void {
  res.cookies.set(ACCESS_COOKIE, signedIn.accessToken, accessCookieOptions(signedIn.expiresIn));
  res.cookies.set(REFRESH_COOKIE, signedIn.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    // Scoped to the auth routes: the refresh token is not sent on every ordinary request,
    // so the surface where it could leak is one endpoint rather than all of them.
    path: '/v1/auth',
    maxAge: 30 * 24 * 60 * 60,
  });
}

// ─── The Supabase session ────────────────────────────────────────────────────

/**
 * Same shape, different issuer.
 *
 * Kept as separate cookies rather than reusing ksdc_at/ksdc_rt so that flipping
 * AUTH_DRIVER does not leave a browser holding a token the other verifier will reject on
 * every request with no way back. A stale cookie from the other driver is simply ignored.
 *
 * The access token still never reaches script: the mobile app gets its session from
 * supabase-js directly and sends a bearer header, and the browser never needs to see one.
 */
export function setSupabaseCookies(res: NextResponse, s: SupabaseSession): void {
  res.cookies.set(SUPABASE_COOKIE, s.accessToken, accessCookieOptions(s.expiresIn));
  res.cookies.set(SUPABASE_REFRESH_COOKIE, s.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/v1/auth',
    maxAge: 30 * 24 * 60 * 60,
  });
}

export function clearAllSessionCookies(res: NextResponse): void {
  // Both drivers, always. Signing out must work whichever one minted the session, and
  // whichever one is configured now - otherwise a driver change strands a live cookie.
  res.cookies.delete({ name: ACCESS_COOKIE, path: '/' });
  res.cookies.delete({ name: REFRESH_COOKIE, path: '/v1/auth' });
  res.cookies.delete({ name: SUPABASE_COOKIE, path: '/' });
  res.cookies.delete({ name: SUPABASE_REFRESH_COOKIE, path: '/v1/auth' });
}
