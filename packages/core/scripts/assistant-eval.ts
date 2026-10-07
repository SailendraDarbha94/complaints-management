/**
 * Score the mail assistant against emails whose right answer is known.
 *
 *   pnpm --filter @ksdc/core assistant:eval                       say what it WOULD do, and stop
 *   pnpm --filter @ksdc/core assistant:eval -- --confirm          run it (this spends money)
 *   ... -- --confirm --only eval-03,eval-11                       just these emails
 *   ... -- --confirm --model claude-sonnet-5-5 --effort low       try another setting
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
import { createEvalTools } from '../src/modules/assistant/eval-tools.js';
import {
  scoreCase as scoreExpected,
  type EvalExpectedLike,
  type Score,
} from '../src/modules/assistant/eval-score.js';
import { priceOf, roundUsd } from '../src/modules/assistant/pricing.js';
import { ENGINE_INSTRUCTIONS, renderEmail, TRIAGE_TOOLS } from '../src/modules/assistant/prompt.js';
import type { AssistantEffort, TriageOptions, TriageResult } from '../src/modules/assistant/types.js';
import { isMainModule } from './is-main.js';

// ─── Options ─────────────────────────────────────────────────────────────────

interface Options {
  confirm: boolean;
  model: string;
  effort: AssistantEffort;
  only: string[] | null;
  concurrency: number;
}

function usage(): string {
  return [
    `usage: assistant:eval [--confirm] [--model ID] [--effort ${ASSISTANT_EFFORTS.join('|')}]`,
    '                      [--only id1,id2] [--concurrency N]',
    'Without --confirm nothing is sent and nothing is spent.',
  ].join('\n');
}

/** "--flag value" and "--flag=value" both work; anything unrecognised is an error, not ignored. */
function parseArgs(argv: string[], defaults: { model: string; effort: AssistantEffort }): Options {
  const opts: Options = { confirm: false, model: defaults.model, effort: defaults.effort, only: null, concurrency: 3 };
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

function estimateUsd(cases: EvalCase[], model: string, playbook: string, maxToolCalls: number): number {
  const { price } = priceOf(model);
  const prefixTokens = (playbook.length + ENGINE_INSTRUCTIONS.length + JSON.stringify(TRIAGE_TOOLS).length) / CHARS_PER_TOKEN;
  let input = 0;
  let output = 0;
  for (const c of cases) {
    const emailTokens = renderEmail(c.email, maxToolCalls).length / CHARS_PER_TOKEN;
    for (let r = 0; r < ASSUMED_REQUESTS_PER_EMAIL; r++) {
      // Each request re-sends everything before it: prefix, email, and every earlier turn.
      input += prefixTokens + emailTokens + r * (ASSUMED_OUTPUT_TOKENS_PER_REQUEST + ASSUMED_LOOKUP_TOKENS_PER_REQUEST);
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

export function scoreCase(c: EvalCase, result: TriageResult): Score {
  const expected: EvalExpectedLike = c.expected;
  return scoreExpected(expected, result);
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
 */
async function runAll(cases: EvalCase[], triage: TriageOptions, concurrency: number): Promise<Outcome[]> {
  const tools = createEvalTools(ASSISTANT_EVAL_SEED);
  const outcomes: Outcome[] = new Array(cases.length);
  let done = 0;

  const one = async (i: number) => {
    const c = cases[i]!;
    const started = Date.now();
    const result = await runTriage(c.email, tools, triage);
    outcomes[i] = { case: c, result, score: scoreCase(c, result), seconds: (Date.now() - started) / 1000 };
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
      `$${o.result.costUsd.toFixed(4)}`,
      o.score.pass ? 'PASS' : 'FAIL',
    ];
  });
  const header = ['id', 'expected', 'got', 'conf', 'checks', 'lookups', 'cost', ''];
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

  // Model, effort, lookup budget and playbook as the running assistant would have them;
  // flags override the first two. Whether MAIL_ASSISTANT is "on" is irrelevant here - this
  // is not the assistant running, it is somebody measuring it on purpose.
  const cfg = assistantConfigFromEnv();
  const opts = parseArgs(argv, { model: cfg.model, effort: cfg.effort });

  let cases = ASSISTANT_EVAL_CASES;
  if (opts.only) {
    const unknown = opts.only.filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length) throw new Error(`No evaluation email with id ${unknown.join(', ')}.`);
    cases = cases.filter((c) => opts.only!.includes(c.id));
  }

  const estimate = estimateUsd(cases, opts.model, cfg.playbook, cfg.maxToolCalls);
  const { known } = priceOf(opts.model);
  console.log(
    [
      `Emails to send:  ${cases.length}`,
      `Model:           ${opts.model}${known ? '' : ' (no price on file - estimated at the highest known rate)'}`,
      `Effort:          ${opts.effort}`,
      `Lookups allowed: ${cfg.maxToolCalls} per email`,
      `Estimated cost:  up to about $${estimate.toFixed(2)} ` +
        `(assumes ${ASSUMED_REQUESTS_PER_EMAIL} requests per email and no cache savings; usually less)`,
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
  };
  const outcomes = await runAll(cases, triage, opts.concurrency);
  const summary = summarise(outcomes);

  console.log(`\n${table(outcomes)}\n`);
  for (const o of outcomes) {
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
