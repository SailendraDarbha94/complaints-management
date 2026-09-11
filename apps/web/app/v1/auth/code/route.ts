import { z } from 'zod';
import { clientIp, jsonBody, withPublic } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.object({ email: z.string().email() });

export const POST = withPublic(
  'Requesting a sign-in code is the first step of signing in, so the caller has no session yet.',
  async ({ req, services }) => {
    const { email } = requestSchema.parse(await jsonBody(req));
    await services.auth.requestCode(email, { ip: clientIp(req) });
    // Always the same answer. Anything else enumerates the council's officers.
    return { sent: true };
  },
);
