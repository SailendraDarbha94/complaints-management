import { after } from 'next/server';
import { withAuth } from '@/lib/route';
import { Logger, MAIL_ROBOT_USER_ID, sweepMailbox } from '@ksdc/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = new Logger('mail');

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
 *
 * The mail assistant is NOT waited for here. The background reader asks it about what it
 * ingests before its next sweep; this button answers as soon as the mail is in the tray,
 * and asks the assistant only after the response has gone (next/server's after()), so the
 * officer sees the new card at once and its suggestion on the next refresh - rather than
 * watching a spinner, and holding this request's transaction open, while a model reads.
 * Asked as the mail robot too: the suggestion was automatic, not the officer's request.
 */
export const POST = withAuth(async ({ ctx, services }) => {
  try {
    const { newInTray, ...result } = await sweepMailbox(services.mail, { suggest: false });
    if (newInTray.length > 0 && services.assistant.status(ctx).enabled) {
      // This request's council: the tray the officer is looking at is the one the
      // configured mailbox feeds (MAIL_COUNCIL_CODE). If those ever differ, the assistant
      // finds no such message under this council and says so in the log - it cannot
      // reach across councils, because every read it makes is under row-level security.
      const robot = { councilId: ctx.councilId, userId: MAIL_ROBOT_USER_ID, config: ctx.config };
      after(async () => {
        try {
          await services.assistant.suggestAfterSweep(robot, newInTray);
        } catch (err) {
          log.error(
            `mail assistant after "check now": ${err instanceof Error ? err.name : 'error'}`,
          );
        }
      });
    }
    return result;
  } catch (err) {
    // A missing app password is the overwhelmingly likely cause, and the officer can fix
    // it. Hand them the message rather than a stack trace.
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ message }, { status: 400 });
  }
});
