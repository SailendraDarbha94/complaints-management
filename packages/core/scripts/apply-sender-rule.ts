/**
 * Apply the sender rule to the mail already waiting in the tray. Run once, after switching
 * the rule on (intakeSenders - see docs/mail-assistant.md, "Which mail reaches the tray").
 *
 *   pnpm --filter @ksdc/core mail:apply-sender-rule                say what it WOULD do, and stop
 *   pnpm --filter @ksdc/core mail:apply-sender-rule -- --confirm   set them aside
 *
 * Without --confirm nothing is written: it prints how many waiting messages it would set
 * aside, counted by the address that sent each one, and stops. Only --confirm changes the
 * tray - and then only messages still waiting there (never one on a case, never one already
 * set aside, never one the officer has put back, never a "could not be read" card) whose
 * sender is not on the list. Each is set aside with a reason, and can be put back from
 * "Set aside" like any other. Safe to run again. See src/modules/mail/sender-rule.ts.
 *
 * Addresses and counts only, never a subject or a word of any message: the output of a
 * command ends up in terminals, logs and chat windows.
 *
 * WHICH DATABASE. Like the mail reader (mail.ts), this loads .env.dev and then
 * apps/web/.env.local, and the second wins: it must change the tray the web app shows,
 * which is the one in apps/web/.env.local. And WHICH LIST: the council's STORED
 * configuration, not the seed file - the rule switched on is the one in the database.
 */
import { closeDb, withCouncil } from '@ksdc/db';
import { councilForMailbox } from '../src/modules/mail/sweep.js';
import { MAIL_ROBOT_USER_ID } from '../src/modules/mail/mail-intake.service.js';
import { applySenderRule, type SenderRuleOutcome } from '../src/modules/mail/sender-rule.js';
import { isMainModule } from './is-main.js';

function usage(): string {
  return [
    'usage: mail:apply-sender-rule [--confirm]',
    'Without --confirm nothing is changed.',
  ].join('\n');
}

/** Anything unrecognised is an error, not ignored: a misspelt --confirm must not be a dry run that looks like a real one, or the reverse. */
export function parseArgs(argv: string[]): { confirm: boolean } {
  let confirm = false;
  for (const a of argv) {
    if (a === '--') continue;
    if (a === '--confirm') confirm = true;
    else if (a === '--help' || a === '-h') {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown option ${a}.\n${usage()}`);
  }
  return { confirm };
}

/** What happened, or would, in lines for the terminal. Addresses and counts only. */
export function describeOutcome(out: SenderRuleOutcome, confirm: boolean): string[] {
  if (out.listed.length === 0) {
    return [
      'No sender rule is switched on for this council (intakeSenders is empty), so there is',
      'nothing to apply. Switch it on first - see docs/mail-assistant.md.',
    ];
  }
  const lines = [`Complaints are taken only from: ${out.listed.join(', ')}`];
  // Never set aside - see sender-rule.ts - but said, so the officer knows they are there.
  const unreadable =
    out.unreadable > 0
      ? [
          `Left in the tray: ${out.unreadable} message(s) that could not be read automatically. ` +
            'Open each in the mailbox; one may be a complaint.',
        ]
      : [];
  if (out.total === 0) {
    lines.push('Nothing waiting in the tray is from any other address. Nothing to do.', ...unreadable);
    return lines;
  }
  const width = String(Math.max(...out.bySender.map((r) => r.messages))).length;
  lines.push(
    confirm
      ? `Set aside ${out.total} waiting message(s) from ${out.bySender.length} other address(es):`
      : `Would set aside ${out.total} waiting message(s) from ${out.bySender.length} other address(es):`,
  );
  for (const r of out.bySender) lines.push(`  ${String(r.messages).padStart(width)}  ${r.sender}`);
  lines.push(...unreadable);
  lines.push(
    confirm
      ? 'Each can be put back from "Set aside" in Inward mail.'
      : 'Nothing was changed. Run again with --confirm to set them aside.',
  );
  return lines;
}

async function main(): Promise<void> {
  const { confirm } = parseArgs(process.argv.slice(2));
  const council = await councilForMailbox(process.env.MAIL_COUNCIL_CODE ?? 'KSDC');
  // As the mail robot, as the rule does on arrival: the audit trail then says the register
  // did this, which it did, on the officer's command.
  const ctx = { councilId: council.id, userId: MAIL_ROBOT_USER_ID, config: council.config };
  const out = await withCouncil({ councilId: council.id, userId: MAIL_ROBOT_USER_ID }, (tx) =>
    applySenderRule(tx, ctx, { confirm }),
  );
  for (const line of describeOutcome(out, confirm)) console.log(line);
}

if (isMainModule(import.meta.url)) {
  main()
    .then(() => closeDb())
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
