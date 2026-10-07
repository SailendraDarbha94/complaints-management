import { z } from 'zod';
import { MAIL_STATUSES } from '@ksdc/contracts';
import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const query = z.enum(MAIL_STATUSES).catch('unfiled');

/**
 * The inward tray.
 *
 * Everything the officer forwarded that has not yet been turned into a case or set aside.
 * A message is not a case: nothing here has spent a serial from the register.
 *
 * Each card carries the mail assistant's latest suggestion for it, or null - in the same
 * request, so the tray is still one round trip however many cards it shows.
 */
export const GET = withAuth(async ({ req, tx, ctx, services }) => {
  const status = query.parse(new URL(req.url).searchParams.get('status') ?? 'unfiled');
  const messages = await services.mail.tray(tx, ctx, status);
  const suggestions = await services.assistant.latestFor(
    tx,
    ctx,
    messages.map((m) => m.id),
  );
  return {
    status,
    messages: messages.map((m) => ({ ...m, suggestion: suggestions.get(m.id) ?? null })),
  };
});
