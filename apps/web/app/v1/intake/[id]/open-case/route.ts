import { z } from 'zod';
import { INTAKE_SOURCES } from '@ksdc/contracts';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Turn a message into a case.
 *
 * This is the only place in the running system that opens one, and it is deliberately a
 * button a person presses: a case number is a serial in a legal register.
 *
 * Every field is optional. Left alone they come from the forwarded original - the
 * complainant's name and address rather than the officer's - and the officer can correct
 * any of them on the way through.
 */
const schema = z.object({
  summary: z.string().trim().min(1).optional(),
  complainantName: z.string().trim().min(1).optional(),
  complainantEmail: z.string().email().nullish(),
  receivedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD.')
    .optional(),
  intakeSource: z.enum(INTAKE_SOURCES).optional(),
});

export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const body = schema.parse(await jsonBody(req));
  return services.mail.openCase(tx, ctx, { mailMessageId: params.id, ...body });
});
