import type { NextResponse } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE, type AuthService } from '@ksdc/core';

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
