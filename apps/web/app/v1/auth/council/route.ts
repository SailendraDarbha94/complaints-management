import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ACCESS_COOKIE } from '@ksdc/core';
import { jsonBody, withAuth } from '@/lib/route';
import { accessCookieOptions } from '../cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const switchSchema = z.object({ councilId: z.string().uuid() });

export const POST = withAuth(async ({ req, identity, services }) => {
  const { councilId } = switchSchema.parse(await jsonBody(req));
  const result = await services.auth.switchCouncil(identity.userId, identity.sessionId, councilId);
  // The refresh token is untouched: switching council re-mints the access token, it
  // does not open a new session.
  const res = NextResponse.json({ council: result.council });
  res.cookies.set(ACCESS_COOKIE, result.accessToken, accessCookieOptions(result.expiresIn));
  return res;
});
