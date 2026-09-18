import { withAuth } from '@/lib/route';
import { sweepMailbox } from '@ksdc/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Check for new mail now."
 *
 * The reader normally runs as its own process (`pnpm --filter @ksdc/core mail`), polling
 * every half minute. This is the same sweep on demand, for the moment the officer has just
 * forwarded something and does not want to wait for the timer.
 *
 * It opens its own council scope internally rather than using this request's, because the
 * reader is a background job: it writes as the mail robot so the audit trail says what
 * actually happened, rather than attributing an automatic ingest to whoever pressed the
 * button.
 */
export const POST = withAuth(async ({ services }) => {
  try {
    return await sweepMailbox(services.mail);
  } catch (err) {
    // A missing app password is the overwhelmingly likely cause, and the officer can fix
    // it. Hand them the message rather than a stack trace.
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ message }, { status: 400 });
  }
});
