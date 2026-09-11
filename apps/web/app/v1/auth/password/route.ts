import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DomainError, identityFromSupabaseToken } from '@ksdc/core';
import { jsonBody, withPublic } from '@/lib/route';
import { authDriver } from '@/lib/auth-adapter';
import { setSupabaseCookies } from '../cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().email(),
  // No maximum worth enforcing and no composition rules: length is the only property that
  // matters, and a rule that forbids a long passphrase is worse than no rule.
  password: z.string().min(10, 'A password of at least ten characters.'),
});

/**
 * Sign in with a password.
 *
 * One step, unlike the code flow, so it is its own endpoint rather than a second shape
 * /v1/auth/verify has to disambiguate.
 *
 * There is no sign-up endpoint beside this one, and that is deliberate: officers and
 * committee members are appointed, and their accounts are created with the secret key by
 * somebody with authority to appoint them.
 */
export const POST = withPublic(
  'Signing in with a password is what creates the session, so there is none to require.',
  async ({ req, services }) => {
    if (authDriver() !== 'supabase') {
      throw new DomainError('Password sign-in is only available on the Supabase driver.', 404);
    }

    const { email, password } = schema.parse(await jsonBody(req));
    const session = await services.supabaseAuth.signInWithPassword(email, password);

    // First sign-in attaches this Supabase identity to the officer's row. The token just
    // minted was built before that link existed, so the council claim arrives on refresh.
    await services.supabaseAuth.linkUser({ supabaseUserId: session.user.id, email });

    const identity = await identityFromSupabaseToken(session.accessToken).catch(() => null);

    const res = NextResponse.json({
      signedIn: true,
      user: { id: identity?.userId ?? session.user.id, email, name: identity?.name ?? email },
      council: identity ? { councilId: identity.councilId, role: identity.role } : null,
      // Said plainly rather than left to be discovered as an empty register.
      needsRefresh: identity === null,
    });
    setSupabaseCookies(res, session);
    return res;
  },
);
