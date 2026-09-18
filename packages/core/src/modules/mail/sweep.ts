import { sql } from 'drizzle-orm';
import { getDb, withCouncil } from '@ksdc/db';
import { parseCouncilConfig, type CouncilConfig } from '@ksdc/config';
import { Logger } from '../../common/logger.js';
import { DomainError } from '../../common/domain-error.js';
import { Mailbox, mailboxConfigFromEnv, mailboxKey } from './mailbox.js';
import { MAIL_ROBOT_USER_ID, type MailIntakeService } from './mail-intake.service.js';

/**
 * One pass of the mailbox.
 *
 * Lives here rather than in the script because two things call it: the long-running reader
 * (`pnpm --filter @ksdc/core mail`) and the "check for new mail now" button on the tray.
 * They must behave identically — in particular they must both write as the mail robot, not
 * as whoever happened to press the button, so the audit trail says what actually happened.
 */

const log = new Logger('mail');

export interface SweepResult {
  fetched: number;
  ingested: number;
  /** How many filed themselves because they quoted a case number. */
  filed: number;
  failed: number;
}

export function mailboxOrThrow() {
  const config = mailboxConfigFromEnv();
  if (!config) {
    throw new DomainError(
      'The mailbox is not configured yet. Add these to .env.dev and apps/web/.env.local, ' +
        'then restart:\n\n' +
        '  MAIL_IMAP_USER=your-intake-address@gmail.com\n' +
        '  MAIL_IMAP_PASSWORD=<a Google app password, not the account password>\n\n' +
        'An app password is created at myaccount.google.com/apppasswords, and that page ' +
        'only appears once 2-step verification is on for the account.',
    );
  }
  return config;
}

/**
 * Which council this mailbox feeds, and that council's own configuration.
 *
 * The obvious query - SELECT id FROM council WHERE code = 'KSDC' - finds NOTHING when run
 * as the application role, and it failed exactly that way the first time the real mailbox
 * was connected. Row-level security on `council` compares against app.council_id, which
 * is unset before a council has been chosen, and choosing one is the whole point of the
 * query. Zero rows, correctly.
 *
 * The daily scheduler hit the identical chicken-and-egg problem, and migration 0004 cut
 * the smallest exception that works: `app.scheduler_scan`, set transaction-locally,
 * unlocks SELECT on council_config and nothing else. This uses the same exception, then
 * scopes into each council in turn to read its code - which also yields the council's
 * STORED configuration rather than the compiled-in seed, so a changed calendar or follow-up
 * rule reaches the mail reader the same way it reaches everything else.
 */
export async function councilForMailbox(
  code: string,
): Promise<{ id: string; config: CouncilConfig }> {
  const configs = await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.scheduler_scan', 'on', true)`);
    return tx.execute<{ council_id: string; config: unknown }>(
      sql`SELECT council_id, config FROM council_config`,
    );
  });

  for (const row of configs.rows) {
    const found = await withCouncil({ councilId: row.council_id }, (tx) =>
      tx.execute<{ code: string }>(
        sql`SELECT code FROM council WHERE id = ${row.council_id}::uuid`,
      ),
    );
    if (found.rows[0]?.code === code) {
      return { id: row.council_id, config: parseCouncilConfig(row.config) };
    }
  }

  throw new DomainError(
    configs.rows.length === 0
      ? 'No council is configured, or the scheduler scan policy is missing (migration 0004).'
      : `No council with the code ${code}. Set MAIL_COUNCIL_CODE.`,
  );
}

export async function sweepMailbox(mail: MailIntakeService): Promise<SweepResult> {
  const config = mailboxOrThrow();
  const council = await councilForMailbox(process.env.MAIL_COUNCIL_CODE ?? 'KSDC');
  const councilId = council.id;

  // Written as the mail robot rather than as nobody. A background write with no actor
  // makes every audit row carry {"unattributed": true}, which migration 0001 describes as
  // the canary for a write that bypassed withCouncil() entirely — so an unattributed
  // ingest would raise an alarm about a bug that is not there, and mask one that is.
  const actor = { councilId, userId: MAIL_ROBOT_USER_ID };
  const ctx = { councilId, userId: MAIL_ROBOT_USER_ID, config: council.config };

  // The same key the messages are stored under - account and folder together. See
  // mailboxKey() for the bug that keying on the folder alone caused.
  const cursor = await withCouncil(actor, (tx) =>
    mail.cursorFor(tx, ctx, mailboxKey(config, config.mailbox)),
  );
  const { messages } = await new Mailbox(config).fetchSince(cursor);

  let ingested = 0;
  let filed = 0;
  let failed = 0;

  for (const message of messages) {
    // One transaction per message. A message that fails — a malformed part, an attachment
    // storage rejects — must not take the rest of the sweep with it. And because the
    // cursor is derived from what was actually written rather than from a stored
    // high-water mark, a failed message is retried next sweep instead of skipped forever.
    try {
      const result = await withCouncil(actor, (tx) =>
        mail.ingest(tx, ctx, message.parsed, {
          mailbox: message.mailbox,
          uid: message.uid,
          uidValidity: message.uidValidity,
          gmMsgId: message.gmMsgId,
          raw: message.raw,
        }),
      );
      if (result.duplicate) continue;
      ingested++;
      if (result.autoFiledTo) filed++;
    } catch (err) {
      failed++;
      log.error(
        `uid ${message.uid} ("${message.parsed.subject ?? '(no subject)'}"): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  if (ingested > 0 || failed > 0) {
    log.log(`${ingested} new, ${filed} filed automatically, ${failed} failed`);
  }
  return { fetched: messages.length, ingested, filed, failed };
}
