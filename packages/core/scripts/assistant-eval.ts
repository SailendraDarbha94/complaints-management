/**
 * Score the mail assistant against emails whose right answer is known.
 *
 *   pnpm --filter @ksdc/core assistant:eval                       say what it WOULD do, and stop
 *   pnpm --filter @ksdc/core assistant:eval -- --confirm          run it (this spends money)
 *   ... -- --confirm --only eval-03,eval-11                       just these emails
 *   ... -- --confirm --model claude-sonnet-5-5 --effort low       try another setting
 *   ... -- --confirm --attachments off                            names of files only, as with the reader off
 *   ... -- --concurrency 2                                        emails in flight at once (default 3)
 *
 * EVERY RUN COSTS REAL MONEY. Each email is one to several paid requests to the Anthropic
 * API, billed to the credits the officer bought. So by default this prints the plan - how
 * many emails, which model, roughly what it will cost - and sends NOTHING. Only --confirm
 * spends. That is the whole safety mechanism, and it is deliberately the first thing the
 * code checks after reading the plan.
 *
 * The emails and the register they are triaged against are invented (packages/config,
 * src/assistant/eval-set.ts) and answered by in-memory lookups (eval-tools.ts): no
 * database is opened, and nothing real is sent to the API.
 *
 * Each email is scored on what an officer would care about (eval-score.ts):
 *   - the decision (new complaint / follow-up / not a complaint / unsure);
 *   - for a follow-up, the case number;
 *   - for a new complaint, that exactly the dentists and clinics the answer key names were
 *     named - none missing, none extra - compared loosely (case, punctuation, spacing and
 *     a leading "Dr" do not count), and by name only, never by the clinic a dentist works
 *     at; that a namesake the key says must stay unlinked was not linked to the register;
 *     and the complainant's email address when the key gives one.
 * And, beside the score rather than in it, how many attachments each email had opened:
 * an email whose key says it needed no file is FLAGGED when one was opened anyway, and
 * one whose key says it needs a file is flagged when none was. Neither fails the email -
 * the flags are about the reading habit, which a pass rate alone would hide.
 *
 * The attachment reader is ON here, whatever MAIL_ASSISTANT_ATTACHMENTS says; its two
 * limits come from the configuration as the running assistant would have them. That
 * switch is about real complainants' papers leaving the office, and these files are
 * invented - the eval set's page texts, drawn into PDFs (eval-tools.ts) and cut exactly as
 * the register's reader would cut them - while the playbook's Attachments section is part
 * of what is under test. Following the switch instead would have the documented command,
 * run while the reader is off for real mail, mark five emails wrong for want of a file,
 * and send the officer to the playbook for a fault that is a setting.
 *
 * --attachments off measures the assistant as it reads real mail with the reader off. The
 * emails whose right answer needs a file (readsAttachment: true) are then LEFT OUT, and
 * the run says so: with names only they can only come back unsure, and counting that as
 * wrong would only blur the score of the rest.
 *
 * Results go to the screen and, in full, to var/assistant-eval/<timestamp>.json in this
 * package (var/ is gitignored), so two settings can be compared afterwards.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_EVAL_CASES, ASSISTANT_EVAL_SEED, type EvalCase } from '@ksdc/config';
import { MAIL_SUGGESTION_DECISIONS, type MailSuggestionDecision } from '@ksdc/contracts';
import { ASSISTANT_EFFORTS, assistantConfigFromEnv } from '../src/modules/assistant/config.js';
import { runTriage } from '../src/modules/assistant/engine.js';
import {
  createEvalTools,
  evalTriageEmail,
  type EvalAttachmentLike,
  type EvalEmailLike,
} from '../src/modules/assistant/eval-tools.js';
import {
  scoreCase as scoreExpected,
  type EvalExpectedLike,
  type Score,
} from '../src/modules/assistant/eval-score.js';
import { priceOf, roundUsd } from '../src/modules/assistant/pricing.js';
import { ENGINE_INSTRUCTIONS, renderEmail, triageTools } from '../src/modules/assistant/prompt.js';
import type { AssistantEffort, TriageOptions, TriageResult } from '../src/modules/assistant/types.js';
import { isMainModule } from './is-main.js';

// ─── Options ─────────────────────────────────────────────────────────────────

interface Options {
  confirm: boolean;
  model: string;
  effort: AssistantEffort;
  /** The attachment reader's switch: on unless --attachments off (see the header). */
  attachments: boolean;
  only: string[] | null;
  concurrency: number;
}

function usage(): string {
  return [
    `usage: assistant:eval [--confirm] [--model ID] [--effort ${ASSISTANT_EFFORTS.join('|')}]`,
    '                      [--attachments on|off] [--only id1,id2] [--concurrency N]',
    'Without --confirm nothing is sent and nothing is spent.',
  ].join('\n');
}

/** "--flag value" and "--flag=value" both work; anything unrecognised is an error, not ignored. */
function parseArgs(argv: string[], defaults: { model: string; effort: AssistantEffort; attachments: boolean }): Options {
  const opts: Options = {
    confirm: false,
    model: defaults.model,
    effort: defaults.effort,
    attachments: defaults.attachments,
    only: null,
    concurrency: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === '--') continue;
    const [flag, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value.\n${usage()}`);
      return v;
    };
    switch (flag) {
      case '--confirm':
        opts.confirm = true;
        break;
      case '--model':
        opts.model = value().trim();
        break;
      case '--effort': {
        const e = value().trim();
        if (!(ASSISTANT_EFFORTS as readonly string[]).includes(e)) {
          throw new Error(`--effort must be one of ${ASSISTANT_EFFORTS.join(', ')}.`);
        }
        opts.effort = e as AssistantEffort;
        break;
      }
      case '--attachments': {
        // Spelled one way, like the setting it overrides: a half-remembered "yes" must
        // not decide whether invented files are sent.
        const v = value().trim();
        if (v !== 'on' && v !== 'off') throw new Error('--attachments must be on or off.');
        opts.attachments = v === 'on';
        break;
      }
      case '--only':
        opts.only = value()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--concurrency': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('--concurrency must be a whole number from 1 to 10.');
        opts.concurrency = n;
        break;
      }
      case '--help':
      case '-h':
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option ${raw}.\n${usage()}`);
    }
  }
  return opts;
}

// ─── The estimate shown before anything is spent ─────────────────────────────

/**
 * Deliberately pessimistic assumptions. The point of the number is to let the person
 * about to type --confirm decide whether to; an estimate that comes in under the bill is
 * worse than useless there. Real runs are usually cheaper, chiefly because the system
 * prompt is read from the cache at a twentieth of the input price after the first email,
 * and this ignores caching altogether.
 */
const ASSUMED_REQUESTS_PER_EMAIL = 3;
const ASSUMED_OUTPUT_TOKENS_PER_REQUEST = 1_500;
const ASSUMED_LOOKUP_TOKENS_PER_REQUEST = 800;
/** Fewer characters per token than English averages, so the token count errs high. */
const CHARS_PER_TOKEN = 3.5;
/**
 * One PDF page: 1,500-3,000 tokens of its text plus the image of the page (Claude API PDF
 * docs) - USD 0.006-0.014 a page on Sonnet 5.5. The top of that range, so 7,000 in all.
 */
const ASSUMED_TOKENS_PER_PDF_PAGE = 7_000;

interface Reading {
  on: boolean;
  maxReads: number;
  maxPdfPages: number;
}

/**
 * Pages of invented files one email could send, assuming the worst: that the model opens
 * every attachment that has contents, up to the limit, whatever the key says it needs.
 */
function pagesItCouldRead(attachments: EvalAttachmentLike[], reading: Reading): number {
  if (!reading.on) return 0;
  return attachments
    .filter((a) => a.stored && a.pages?.length)
    .slice(0, reading.maxReads)
    .reduce((n, a) => n + Math.min(a.pages!.length, reading.maxPdfPages), 0);
}

function estimateUsd(cases: EvalCase[], model: string, playbook: string, maxToolCalls: number, reading: Reading): number {
  const { price } = priceOf(model);
  const tools = JSON.stringify(triageTools(reading.on));
  const prefixTokens = (playbook.length + ENGINE_INSTRUCTIONS.length + tools.length) / CHARS_PER_TOKEN;
  let input = 0;
  let output = 0;
  for (const c of cases) {
    const email = evalTriageEmail(c.email);
    const emailTokens = renderEmail(email, maxToolCalls, reading.on ? reading.maxReads : null).length / CHARS_PER_TOKEN;
    const fileTokens = pagesItCouldRead(c.email.attachments, reading) * ASSUMED_TOKENS_PER_PDF_PAGE;
    // Opening a file takes a turn of its own.
    const requests = ASSUMED_REQUESTS_PER_EMAIL + (fileTokens > 0 ? 1 : 0);
    for (let r = 0; r < requests; r++) {
      // Each request re-sends everything before it: prefix, email, every earlier turn -
      // and, from the second request on, the files opened in the first.
      input +=
        prefixTokens +
        emailTokens +
        r * (ASSUMED_OUTPUT_TOKENS_PER_REQUEST + ASSUMED_LOOKUP_TOKENS_PER_REQUEST) +
        (r > 0 ? fileTokens : 0);
      output += ASSUMED_OUTPUT_TOKENS_PER_REQUEST;
    }
  }
  return roundUsd((input * price.input + output * price.output) / 1_000_000);
}

// ─── Scoring ─────────────────────────────────────────────────────────────────
//
// In src/modules/assistant/eval-score.ts, where it is unit-tested without spending
// anything. config's EvalExpected is passed in as the scorer's EvalExpectedLike, so if the
// answer key's shape and the scorer's ever drift apart, this stops compiling.

export function scoreCase(c: EvalCase, result: TriageResult, attachmentsOn = true): Score {
  const expected: EvalExpectedLike = c.expected;
  return scoreExpected(expected, result, { attachmentsOn });
}

/**
 * With the reader off, the emails whose right answer needs a file are left out of the run
 * (see the header) - and named, so nobody wonders where they went. With it on, all run.
 */
export function withoutFileOnlyCases(cases: EvalCase[], attachmentsOn: boolean): { run: EvalCase[]; needFile: EvalCase[] } {
  if (attachmentsOn) return { run: cases, needFile: [] };
  return {
    run: cases.filter((c) => c.expected.readsAttachment !== true),
    needFile: cases.filter((c) => c.expected.readsAttachment === true),
  };
}

// ─── Running ─────────────────────────────────────────────────────────────────

interface Outcome {
  case: EvalCase;
  result: TriageResult;
  score: Score;
  seconds: number;
}

/**
 * The first email alone, then the rest N at a time. A cache entry can only be read once
 * the request that writes it has started answering, so N requests fired together would
 * each pay full price for the system prompt; one request first warms it for all the rest.
 *
 * Tools are made per email: the lookups are the same invented register for all, but the
 * reader opens only the attachments of the email it was made for.
 */
async function runAll(cases: EvalCase[], triage: TriageOptions, maxPdfPages: number, concurrency: number): Promise<Outcome[]> {
  const outcomes: Outcome[] = new Array(cases.length);
  let done = 0;

  const one = async (i: number) => {
    const c = cases[i]!;
    // config's EvalEmail, checked here against the shape the eval tools read.
    const email: EvalEmailLike = c.email;
    const tools = createEvalTools(ASSISTANT_EVAL_SEED, { attachments: email.attachments, maxPdfPages });
    const started = Date.now();
    const result = await runTriage(evalTriageEmail(email), tools, triage);
    outcomes[i] = {
      case: c,
      result,
      score: scoreCase(c, result, triage.readAttachments),
      seconds: (Date.now() - started) / 1000,
    };
    done++;
    process.stdout.write(`  ${done}/${cases.length} ${c.id}\n`);
  };

  if (cases.length === 0) return [];
  await one(0);
  let next = 1;
  const worker = async () => {
    while (next < cases.length) await one(next++);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length - 1) }, worker));
  return outcomes;
}

// ─── Reporting ───────────────────────────────────────────────────────────────

const mark = (v: boolean | null) => (v === null ? '-' : v ? 'ok' : 'WRONG');

/** "0", "1", "2 extra" (read though the email was enough), "0 missed" (needed one, read none). */
function readsCell(s: Score): string {
  return `${s.reads}${s.unnecessaryRead ? ' extra' : s.missedRead ? ' missed' : ''}`;
}

function table(outcomes: Outcome[]): string {
  const rows = outcomes.map((o) => {
    const p = o.result.ok ? o.result.proposal : null;
    const got = o.result.ok ? (p!.decision + (p!.followUp ? ` ${p!.followUp.caseNumber}` : '')) : 'FAILED';
    const checks = [
      `dec ${mark(o.score.decisionRight)}`,
      `case ${mark(o.score.caseNumberRight)}`,
      `resp ${mark(o.score.respondentsRight)}`,
      `link ${mark(o.score.linksRight)}`,
      `email ${mark(o.score.complainantEmailRight)}`,
    ].join(' ');
    return [
      o.case.id,
      o.case.expected.decision,
      got,
      p?.confidence ?? '',
      checks,
      String(o.result.toolCalls),
      readsCell(o.score),
      `$${o.result.costUsd.toFixed(4)}`,
      o.score.pass ? 'PASS' : 'FAIL',
    ];
  });
  const header = ['id', 'expected', 'got', 'conf', 'checks', 'lookups', 'reads', 'cost', ''];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function pct(n: number, of: number): string {
  return of === 0 ? '-' : `${Math.round((100 * n) / of)}%`;
}

function summarise(outcomes: Outcome[]) {
  const byDecision = Object.fromEntries(
    MAIL_SUGGESTION_DECISIONS.map((d) => {
      const these = outcomes.filter((o) => o.case.expected.decision === d);
      return [
        d,
        {
          emails: these.length,
          decisionRight: these.filter((o) => o.score.decisionRight).length,
          pass: these.filter((o) => o.score.pass).length,
        },
      ];
    }),
  ) as Record<MailSuggestionDecision, { emails: number; decisionRight: number; pass: number }>;
  const totalCost = roundUsd(outcomes.reduce((s, o) => s + o.result.costUsd, 0));
  return {
    emails: outcomes.length,
    decisionRight: outcomes.filter((o) => o.score.decisionRight).length,
    pass: outcomes.filter((o) => o.score.pass).length,
    failedRuns: outcomes.filter((o) => !o.result.ok).length,
    attachmentsRead: outcomes.reduce((n, o) => n + o.score.reads, 0),
    pdfPagesSent: outcomes.reduce(
      (n, o) => n + o.result.attachmentsRead.reduce((m, r) => m + (r.pagesSent ?? 0), 0),
      0,
    ),
    unnecessaryReads: outcomes.filter((o) => o.score.unnecessaryRead).length,
    missedReads: outcomes.filter((o) => o.score.missedRead).length,
    byDecision,
    totalCostUsd: totalCost,
    meanCostUsd: outcomes.length ? roundUsd(totalCost / outcomes.length) : 0,
    tokens: outcomes.reduce(
      (t, o) => ({
        input: t.input + o.result.usage.inputTokens,
        output: t.output + o.result.usage.outputTokens,
        cacheRead: t.cacheRead + o.result.usage.cacheReadTokens,
        cacheWrite: t.cacheWrite + o.result.usage.cacheWriteTokens,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ),
  };
}

/** This package's own directory, wherever the command is run from: dist/scripts -> ../.. */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<void> {
  // A stale build of @ksdc/config would import as "undefined" rather than fail; say so plainly.
  if (!Array.isArray(ASSISTANT_EVAL_CASES) || !ASSISTANT_EVAL_SEED) {
    throw new Error('The evaluation set is missing from @ksdc/config. Build it first: pnpm --filter @ksdc/config build');
  }

  // Model, effort, lookup budget, the reader's limits and the playbook as the running
  // assistant would have them; flags override the model and the effort. The reader itself
  // is on unless --attachments off (see the header). Whether MAIL_ASSISTANT is "on" is
  // irrelevant here too - this is not the assistant running, it is somebody measuring it
  // on purpose.
  const cfg = assistantConfigFromEnv();
  const opts = parseArgs(argv, { model: cfg.model, effort: cfg.effort, attachments: true });
  const reading: Reading = { on: opts.attachments, maxReads: cfg.maxAttachmentReads, maxPdfPages: cfg.maxPdfPages };

  let cases = ASSISTANT_EVAL_CASES;
  if (opts.only) {
    const unknown = opts.only.filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length) throw new Error(`No evaluation email with id ${unknown.join(', ')}.`);
    cases = cases.filter((c) => opts.only!.includes(c.id));
  }
  const { run: toRun, needFile } = withoutFileOnlyCases(cases, reading.on);
  cases = toRun;
  if (cases.length === 0) {
    console.log('Nothing to run: every email chosen needs a file opened, and --attachments off leaves those out.');
    return;
  }

  const estimate = estimateUsd(cases, opts.model, cfg.playbook, cfg.maxToolCalls, reading);
  const { known } = priceOf(opts.model);
  const withFiles = cases.filter((c) => pagesItCouldRead(c.email.attachments, { ...reading, on: true }) > 0).length;
  console.log(
    [
      `Emails to send:  ${cases.length}`,
      `Model:           ${opts.model}${known ? '' : ' (no price on file - estimated at the highest known rate)'}`,
      `Effort:          ${opts.effort}`,
      `Lookups allowed: ${cfg.maxToolCalls} per email`,
      `Attachments:     ` +
        (reading.on
          ? `opened when needed - at most ${reading.maxReads} per email, PDFs cut to ${reading.maxPdfPages} pages ` +
            `(${withFiles} email(s) have invented files to open; --attachments off for names only)`
          : 'not opened - names only' +
            (needFile.length
              ? `; left out, as they need a file: ${needFile.map((c) => c.id).join(', ')}`
              : '')),
      `Estimated cost:  up to about $${estimate.toFixed(2)} ` +
        `(assumes ${ASSUMED_REQUESTS_PER_EMAIL} requests per email` +
        (reading.on ? ', every invented file opened' : '') +
        ' and no cache savings; usually less)',
    ].join('\n'),
  );

  const hasKey = !!process.env.ANTHROPIC_API_KEY?.trim();
  if (!opts.confirm) {
    console.log(
      `\nNothing was sent and nothing was spent. To run it, add --confirm.` +
        (hasKey ? '' : '\n(ANTHROPIC_API_KEY is not set either, so it could not run yet.)'),
    );
    return;
  }
  if (!hasKey) {
    throw new Error('ANTHROPIC_API_KEY is not set. Put it in apps/web/.env.local or .env.dev, then try again.');
  }

  console.log(`\nRunning ${cases.length} email(s), ${opts.concurrency} at a time...`);
  const startedAt = new Date();
  const triage: TriageOptions = {
    model: opts.model,
    effort: opts.effort,
    playbook: cfg.playbook,
    playbookVersion: cfg.playbookVersion,
    maxToolCalls: cfg.maxToolCalls,
    readAttachments: reading.on,
    maxAttachmentReads: reading.maxReads,
  };
  const outcomes = await runAll(cases, triage, reading.maxPdfPages, opts.concurrency);
  const summary = summarise(outcomes);

  console.log(`\n${table(outcomes)}\n`);
  for (const o of outcomes) {
    // The reading flags first, and for failed runs too: a file opened before the run
    // failed was still opened. Invented files, so naming them here is safe.
    const opened = o.result.attachmentsRead.map((r) => r.filename).join(', ');
    if (o.score.unnecessaryRead) {
      console.log(`${o.case.id}: opened ${opened}, though the email alone was enough (flagged, not failed)`);
    }
    if (o.score.missedRead) {
      console.log(`${o.case.id}: opened no attachment, though the right answer needs one (flagged, not failed)`);
    }
    if (!o.result.ok) {
      console.log(`${o.case.id}: no suggestion - ${o.result.error}`);
      continue;
    }
    if (o.score.missingRespondents.length) {
      console.log(`${o.case.id}: did not name ${o.score.missingRespondents.join(', ')}`);
    }
    if (o.score.unexpectedRespondents.length) {
      console.log(`${o.case.id}: also named ${o.score.unexpectedRespondents.join(', ')}, which the key does not`);
    }
    if (o.score.wronglyLinked.length) {
      console.log(`${o.case.id}: linked ${o.score.wronglyLinked.join(', ')} to the register, which it must not`);
    }
  }

  console.log('\nBy expected decision:');
  for (const d of MAIL_SUGGESTION_DECISIONS) {
    const s = summary.byDecision[d];
    if (s.emails === 0) continue;
    console.log(
      `  ${d.padEnd(16)} ${String(s.emails).padStart(3)} email(s)   decision right ${pct(s.decisionRight, s.emails).padStart(4)}` +
        `   fully right ${pct(s.pass, s.emails).padStart(4)}`,
    );
  }
  console.log(
    [
      '',
      `Decision right:  ${summary.decisionRight}/${summary.emails} (${pct(summary.decisionRight, summary.emails)})`,
      `Fully right:     ${summary.pass}/${summary.emails} (${pct(summary.pass, summary.emails)})`,
      `No suggestion:   ${summary.failedRuns}`,
      ...(reading.on
        ? [
            `Files opened:    ${summary.attachmentsRead} (${summary.pdfPagesSent} PDF page(s) sent)`,
            `Reading flags:   ${summary.unnecessaryReads} opened needlessly, ${summary.missedReads} not opened when needed`,
          ]
        : []),
      `Total cost:      $${summary.totalCostUsd.toFixed(4)}`,
      `Mean per email:  $${summary.meanCostUsd.toFixed(4)}`,
    ].join('\n'),
  );

  const dir = join(packageRoot(), 'var', 'assistant-eval');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        model: opts.model,
        effort: opts.effort,
        maxToolCalls: cfg.maxToolCalls,
        attachments: reading,
        playbookVersion: cfg.playbookVersion,
        estimateUsd: estimate,
        summary,
        cases: outcomes.map((o) => ({
          id: o.case.id,
          about: o.case.about,
          expected: o.case.expected,
          score: o.score,
          seconds: o.seconds,
          result: o.result,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nFull report: ${file}`);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
