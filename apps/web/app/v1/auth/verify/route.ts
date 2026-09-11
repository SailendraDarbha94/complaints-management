import { NextResponse } from 'next/server';
import { z } from 'zod';
import { identityFromSupabaseToken } from '@ksdc/core';
import { clientIp, jsonBody, withPublic } from '@/lib/route';
import { authDriver } from '@/lib/auth-adapter';
import { publicShape, setSessionCookies, setSupabaseCookies } from '../cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The code length is not the same on both drivers.
 *
 * The council's own flow issues six digits. A Supabase project issues whatever its Auth
 * settings say, and eight is the default - so a hard /^\d{6}$/ would reject every real
 * Supabase code with "a code is six digits", which is a maddening thing to debug when the
 * code in the email plainly is the code. Accept the range and let the issuer decide.
 */
const schema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6,8}$/, 'A code is six to eight digits.'),
});

export const POST = withPublic(
  'Exchanging a code for a session is what creates the session, so there is none to require.',
  async ({ req, services }) => {
    const { email, code } = schema.parse(await jsonBody(req));

    if (authDriver() === 'supabase') {
      const session = await services.supabaseAuth.verifyCode(email, code);

      // First sign-in links the Supabase identity to the officer's row. The token just
      // minted does NOT yet carry a council if this was the linking run - the hook read
      // the row before it was linked - so the client refreshes to pick the claims up.
      await services.supabaseAuth.linkUser({ supabaseUserId: session.user.id, email });

      const identity = await identityFromSupabaseToken(session.accessToken).catch(() => null);

      const res = NextResponse.json({
        signedIn: true,
        user: { id: identity?.userId ?? session.user.id, email, name: identity?.name ?? email },
        council: identity
          ? { councilId: identity.councilId, role: identity.role }
          : null,
        // Told plainly rather than left to be discovered as an empty register.
        needsRefresh: identity === null,
      });
      setSupabaseCookies(res, session);
      return res;
    }

    const signedIn = await services.auth.verifyCode(email, code, {
      ip: clientIp(req),
      userAgent: req.headers.get('user-agent'),
    });
    // A constructed response rather than a plain object, because the session cookies are
    // the point of this endpoint and only a response we hold can carry them.
    const res = NextResponse.json(publicShape(signedIn));
    setSessionCookies(res, signedIn);
    return res;
  },
);
