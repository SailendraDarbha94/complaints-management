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
  /** Written down as unreadable: a card in the tray says so. */
  failed: number;
  /** Failed this time and will be tried again; the sweep stopped at it. */
  deferred: number;
  /**
   * The messages this sweep put in the tray - new, and neither filed by a case number nor
   * set aside as an account notice. What the mail assistant is asked about.
   */
  newInTray: string[];
}

export interface SweepOptions {
  /**
   * Hand the new messages to the mail assistant (the default, and what the background
   * reader does). It is NOT waited for: the sweep returns as soon as the mail is in the
   * tray, and the assistant reads in its own time (AssistantService.suggestAfterSweep). The
   * "check now" button passes false and asks after its response has gone, through Next's
   * after(), which a hosting platform can be told to wait for.
   */
  suggest?: boolean;
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

export async function sweepMailbox(
  mail: MailIntakeService,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const config = mailboxOrThrow();
  const council = await councilForMailbox(process.env.MAIL_COUNCIL_CODE ?? 'KSDC');
  const councilId = council.id;

  // Written as the mail robot rather than as nobody. A background write with no actor
  // makes every audit row carry {"unattributed": true}, which migration 0001 describes as
  // the canary for a write that bypassed withCouncil() entirely — so an unattributed
  // ingest would raise an alarm about a bug that is not there, and mask one that is.
  const actor = { councilId, userId: MAIL_ROBOT_USER_ID };
  const ctx = { councilId, userId: MAIL_ROBOT_USER_ID, config: council.config };

  // Attachments of filed messages that did not reach their case last time - a moment when
  // the file store did not answer. First, and in its own transaction: it must not depend
  // on the mailbox being reachable, and nothing it does can undo an ingest.
  try {
    await withCouncil(actor, (tx) => mail.fileHeldAttachments(tx, ctx));
  } catch (err) {
    log.error(`held attachments: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The same key the messages are stored under - account and folder together. See
  // mailboxKey() for the bug that keying on the folder alone caused.
  const cursor = await withCouncil(actor, (tx) =>
    mail.cursorFor(tx, ctx, mailboxKey(config, config.mailbox)),
  );
  const { messages } = await new Mailbox(config).fetchSince(cursor);

  let ingested = 0;
  let filed = 0;
  let failed = 0;
  let deferred = 0;
  const newInTray: string[] = [];

  for (const message of messages) {
    const meta = {
      mailbox: message.mailbox,
      uid: message.uid,
      uidValidity: message.uidValidity,
      gmMsgId: message.gmMsgId,
      raw: message.raw,
    };
    const key = `${message.mailbox}#${message.uidValidity}#${message.uid}`;
    const subject = message.parsed?.subject ?? '(no subject)';

    const writeDown = async (reason: string): Promise<boolean> => {
      try {
        await withCouncil(actor, (tx) =>
          mail.recordUnreadable(tx, ctx, message.parsed, meta, reason),
        );
        failed++;
        return true;
      } catch (err) {
        log.error(
          `uid ${message.uid} could not even be recorded as unreadable: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        return false;
      }
    };

    // Not parseable at all. That will not change by waiting, so it is written down now.
    if (!message.parsed) {
      log.error(`uid ${message.uid}: ${message.parseError ?? 'could not be parsed'}`);
      if (!(await writeDown(message.parseError ?? 'could not be parsed'))) break;
      continue;
    }
    const parsed = message.parsed;

    try {
      const result = await withCouncil(actor, (tx) => mail.ingest(tx, ctx, parsed, meta));
      failures.delete(key);
      if (result.duplicate) continue;
      ingested++;
      if (result.autoFiledTo) filed++;
      // Only what is waiting for the officer. A reply that filed itself by its case number
      // and an account notice set aside automatically are already decided; asking a model
      // about them would spend money on a question nobody has.
      if (result.status === 'unfiled') newInTray.push(result.mailMessageId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const seen = failures.get(key) ?? { count: 0, since: Date.now() };
      seen.count++;
      failures.set(key, seen);
      log.error(`uid ${message.uid} ("${subject}"), attempt ${seen.count}: ${reason}`);

      if (!givesUp(seen, Date.now())) {
        // Stop the sweep HERE and try again next time. The cursor is the highest UID in
        // the tray, so ingesting any later message would move it past this one for good -
        // which is how a failed complaint used to vanish. Most failures are a moment when
        // the database or the file store did not answer, and are gone by the next check.
        deferred++;
        break;
      }

      // Failing for long enough, and on nothing else, to be about this message itself.
      // Written down, so it cannot vanish and so the mail behind it can be read.
      if (!(await writeDown(reason))) break;
      failures.delete(key);
    }
  }

  if (ingested > 0 || failed > 0 || deferred > 0) {
    log.log(
      `${ingested} new, ${filed} filed automatically, ${failed} could not be read` +
        (deferred ? ', 1 to try again' : ''),
    );
  }

  // The mail assistant, LAST, and NOT AWAITED. After every message of this sweep is safely
  // in the tray - and then without waiting for it, so nothing it does can delay the next
  // ingest: a model reading five emails takes minutes on a slow day, and in those minutes
  // the reader must go on fetching mail, replies that file themselves by case number above
  // all. The assistant queues what it is given and reads one at a time (see
  // AssistantService.suggestAfterSweep); it is off unless configured, and decides for
  // itself how many to read. Its failures are logged and swallowed: a sweep that reported
  // failure over a suggestion would make the reader retry mail it has already read
  // perfectly well. Nothing from the email is logged here.
  const assistant = mail.assistantHook;
  if (opts.suggest !== false && assistant && newInTray.length > 0) {
    void Promise.resolve()
      .then(() => assistant.suggestAfterSweep(ctx, newInTray))
      .catch((err: unknown) =>
        log.error(
          `mail assistant: no suggestions this sweep (${err instanceof Error ? err.name : 'error'})`,
        ),
      );
  }

  return { fetched: messages.length, ingested, filed, failed, deferred, newInTray };
}

/**
 * Messages that failed to ingest, by mailbox + UIDVALIDITY + UID, for as long as this
 * process runs. Held in memory on purpose: after a restart a message simply gets its full
 * allowance of attempts again, which errs towards reading it rather than giving up on it.
 */
const failures = new Map<string, { count: number; since: number }>();

/**
 * When a message that keeps failing is written down as unreadable rather than retried.
 *
 * Both limits, not either: ten attempts is five minutes at the default poll, and an outage
 * of the database or the file store can last longer than that. Giving up during an outage
 * would turn every message that arrived in it into an empty "could not be read" card; the
 * cost of waiting is only that mail behind a genuinely broken message waits ten minutes.
 */
export function givesUp(seen: { count: number; since: number }, now: number): boolean {
  return seen.count >= 10 && now - seen.since >= 10 * 60_000;
}
