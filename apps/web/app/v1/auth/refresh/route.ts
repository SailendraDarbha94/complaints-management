import { NextResponse } from 'next/server';
import { REFRESH_COOKIE } from '@ksdc/core';
import { clientIp, withPublic } from '@/lib/route';
import { publicShape, setSessionCookies } from '../cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withPublic(
  'Refresh is reached precisely when the access token has expired, so it cannot require one.',
  async ({ req, services }) => {
    const token = req.cookies.get(REFRESH_COOKIE)?.value;
    if (!token) {
      // Not an error worth logging: an anonymous visitor's browser tries this once.
      return { signedIn: false };
    }
    const rotated = await services.auth.refresh(token, {
      ip: clientIp(req),
      userAgent: req.headers.get('user-agent'),
    });
    const res = NextResponse.json(publicShape(rotated));
    setSessionCookies(res, rotated);
    return res;
  },
);
