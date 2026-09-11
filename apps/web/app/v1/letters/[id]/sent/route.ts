import { z } from 'zod';
import { SERVICE_MODES } from '@ksdc/contracts';
import { jsonBody, withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sentSchema = z.object({
  sentAt: z.string().min(4),
  serviceMode: z.enum(SERVICE_MODES).optional(),
  caseRespondentId: z.string().uuid().nullish(),
});

/** The click that starts the clock. */
export const POST = withAuth<{ id: string }>(async ({ req, params, tx, ctx, services }) => {
  const input = sentSchema.parse(await jsonBody(req));
  // A bare date means "that day", read in the council's own calendar rather than the
  // browser's: an officer in Bengaluru confirming at 11pm meant today, not tomorrow.
  const sentAt = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(input.sentAt) ? `${input.sentAt}T06:00:00Z` : input.sentAt,
  );
  if (Number.isNaN(sentAt.getTime())) {
    throw new Error(`"${input.sentAt}" is not a date.`);
  }
  return services.correspondence.markSent(tx, ctx, {
    correspondenceId: params.id,
    sentAt,
    serviceMode: input.serviceMode,
    caseRespondentId: input.caseRespondentId ?? null,
  });
});
