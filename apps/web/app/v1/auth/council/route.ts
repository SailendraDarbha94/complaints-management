import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ROLES } from '@ksdc/contracts';
import { ACCESS_COOKIE } from '@ksdc/core';
import { jsonBody, withAuth } from '@/lib/route';
import { accessCookieOptions } from '../cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const switchSchema = z.object({ councilId: z.string().uuid() });

/**
 * Act for another council.
 *
 * Open to every role: a committee member here may be the officer of another council, and
 * switching is how they get to the council where they may use this website. It reads
 * nothing from the register; the service checks the membership, and the role the new
 * token carries decides what every other route lets them do.
 */
export const POST = withAuth(
  async ({ req, identity, services }) => {
    const { councilId } = switchSchema.parse(await jsonBody(req));
    const result = await services.auth.switchCouncil(identity.userId, identity.sessionId, councilId);
    // The refresh token is untouched: switching council re-mints the access token, it
    // does not open a new session.
    const res = NextResponse.json({ council: result.council });
    res.cookies.set(ACCESS_COOKIE, result.accessToken, accessCookieOptions(result.expiresIn));
    return res;
  },
  { roles: ROLES },
);
