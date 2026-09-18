/**
 * The mail reader, as a command.
 *
 *   pnpm --filter @ksdc/core mail --check    does the app password work?
 *   pnpm --filter @ksdc/core mail --once     one sweep, then exit. For a scheduled task.
 *   pnpm --filter @ksdc/core mail            watch, every MAIL_POLL_SECONDS. Ctrl-C stops.
 *
 * The sweep itself lives in src/modules/mail/sweep.ts, because the "check for new mail
 * now" button on the tray calls exactly the same code. This file is the command line and
 * nothing else.
 *
 * Read-only throughout: EXAMINE rather than SELECT, BODY.PEEK on every fetch. The mailbox
 * is left exactly as the officer sees it - which matters, because that mailbox and not
 * this database is the verbatim copy of what the Council was sent.
 *
 * WHICH DATABASE. The `mail` script loads .env.dev and then apps/web/.env.local, and the
 * second wins. That order is the fix for a bug found on the day the real mailbox was
 * connected: .env.dev points at the local development database and local-disk storage,
 * while the web app points at Supabase for both. Run from .env.dev alone, this reader
 * would have filled a tray that nothing displays, and staged attachments somewhere the
 * web app could never commit them from. The reader has to write to exactly the database
 * and storage the tray reads from, so it takes the tray's configuration.
 */
import { closeDb } from '@ksdc/db';
import { getServices } from '../src/services.js';
import { Mailbox } from '../src/modules/mail/mailbox.js';
import { mailboxOrThrow, sweepMailbox } from '../src/modules/mail/sweep.js';
import { Logger } from '../src/common/logger.js';
import { isMainModule } from './is-main.js';

const log = new Logger('mail');

async function check(): Promise<void> {
  const config = mailboxOrThrow();
  const out = await new Mailbox(config).check();
  log.log(
    `connected to ${config.user} - ${out.mailbox} holds ${out.messages} message(s). ` +
      'Nothing was marked read or moved.',
  );
}

async function once(): Promise<void> {
  const services = await getServices();
  const r = await sweepMailbox(services.mail);
  log.log(`${r.fetched} fetched, ${r.ingested} new, ${r.filed} filed automatically`);
  if (r.failed > 0) throw new Error(`${r.failed} message(s) could not be ingested`);
}

async function watch(): Promise<void> {
  const seconds = Number(process.env.MAIL_POLL_SECONDS ?? 30);
  const services = await getServices();
  log.log(`watching ${mailboxOrThrow().user}, every ${seconds}s. Ctrl-C to stop.`);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    try {
      await sweepMailbox(services.mail);
    } catch (err) {
      // A dropped connection is expected on a laptop that sleeps. Log it and carry on;
      // the next sweep reconnects from a clean client and the cursor has not moved.
      log.error(err instanceof Error ? err.message : String(err));
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
  log.log('stopped.');
}

if (isMainModule(import.meta.url)) {
  const mode = process.argv.includes('--check')
    ? check
    : process.argv.includes('--once')
      ? once
      : watch;

  mode()
    .then(() => closeDb())
    .catch(async (err) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      await closeDb().catch(() => {});
      // A failed sweep must not exit 0, or a scheduled task records a success on a morning
      // when no mail was read and nobody is told the tray stopped filling.
      process.exit(1);
    });
}

