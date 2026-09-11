import { NextResponse } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@ksdc/core';
import { withPublic } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withPublic(
  'Signing out has to work with an expired or missing access token, which is when it is used.',
  async ({ req, services }) => {
    await services.auth.signOut(req.cookies.get(REFRESH_COOKIE)?.value);
    const res = NextResponse.json({ signedOut: true });
    // The paths must be the ones the cookies were set with, or the browser keeps them and
    // the officer is still signed in on the next request.
    res.cookies.delete({ name: ACCESS_COOKIE, path: '/' });
    res.cookies.delete({ name: REFRESH_COOKIE, path: '/v1/auth' });
    return res;
  },
);
