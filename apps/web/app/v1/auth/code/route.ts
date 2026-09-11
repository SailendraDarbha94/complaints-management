import { z } from 'zod';
import { clientIp, jsonBody, withPublic } from '@/lib/route';
import { authDriver } from '@/lib/auth-adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.object({ email: z.string().email() });

export const POST = withPublic(
  'Requesting a sign-in code is the first step of signing in, so the caller has no session yet.',
  async ({ req, services }) => {
    const { email } = requestSchema.parse(await jsonBody(req));

    if (authDriver() === 'supabase') {
      // Supabase sends the mail and applies its own rate limits. shouldCreateUser is false
      // in the service, so an unknown address gets no account.
      await services.supabaseAuth.requestCode(email);
    } else {
      await services.auth.requestCode(email, { ip: clientIp(req) });
    }

    // Always the same answer. Anything else enumerates the council's officers.
    return { sent: true };
  },
);
