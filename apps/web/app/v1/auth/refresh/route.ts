import { NextResponse } from 'next/server';
import { REFRESH_COOKIE, identityFromSupabaseToken } from '@ksdc/core';
import { clientIp, withPublic } from '@/lib/route';
import { authDriver, SUPABASE_REFRESH_COOKIE } from '@/lib/auth-adapter';
import { publicShape, setSessionCookies, setSupabaseCookies } from '../cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withPublic(
  'Refresh is reached precisely when the access token has expired, so it cannot require one.',
  async ({ req, services }) => {
    if (authDriver() === 'supabase') {
      const rt = req.cookies.get(SUPABASE_REFRESH_COOKIE)?.value;
      if (!rt) return { signedIn: false };

      const session = await services.supabaseAuth.refresh(rt);
      // A refresh re-runs the access token hook, so this is where a council added since
      // sign-in, or one just linked, actually reaches the token.
      const identity = await identityFromSupabaseToken(session.accessToken).catch(() => null);

      const res = NextResponse.json({
        signedIn: true,
        user: { id: identity?.userId ?? session.user.id, email: session.user.email ?? '', name: identity?.name ?? '' },
        council: identity ? { councilId: identity.councilId, role: identity.role } : null,
        needsRefresh: false,
      });
      setSupabaseCookies(res, session);
      return res;
    }

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
