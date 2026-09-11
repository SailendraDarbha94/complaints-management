import { NextResponse } from 'next/server';
import { z } from 'zod';
import { clientIp, jsonBody, withPublic } from '@/lib/route';
import { publicShape, setSessionCookies } from '../cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const verifySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, 'A code is six digits.'),
});

export const POST = withPublic(
  'Exchanging a code for a session is what creates the session, so there is none to require.',
  async ({ req, services }) => {
    const { email, code } = verifySchema.parse(await jsonBody(req));
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
