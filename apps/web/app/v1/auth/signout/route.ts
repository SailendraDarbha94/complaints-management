import { NextResponse } from 'next/server';
import { REFRESH_COOKIE } from '@ksdc/core';
import { withPublic } from '@/lib/route';
import { SUPABASE_COOKIE } from '@/lib/auth-adapter';
import { clearAllSessionCookies } from '../cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withPublic(
  'Signing out has to work with an expired or missing access token, which is when it is used.',
  async ({ req, services }) => {
    // Revoke on BOTH drivers rather than on the configured one. A browser can be holding
    // a session minted before AUTH_DRIVER changed, and the one thing sign-out must never
    // do is leave a live session behind because the setting moved underneath it.
    await Promise.allSettled([
      services.auth.signOut(req.cookies.get(REFRESH_COOKIE)?.value),
      services.supabaseAuth.signOut(req.cookies.get(SUPABASE_COOKIE)?.value),
    ]);

    const res = NextResponse.json({ signedOut: true });
    // The paths must be the ones the cookies were set with, or the browser keeps them and
    // the officer is still signed in on the next request.
    clearAllSessionCookies(res);
    return res;
  },
);
