import { Logger } from '../../common/logger.js';
import type { TriageUsage } from './types.js';

/**
 * What a suggestion cost, in US dollars.
 *
 * The officer bought the credits this spends, so the figure shown against each suggestion
 * and summed in the monthly report has to be one he can hold the Anthropic invoice up
 * against. It is computed here from the token counts the API returns, not estimated.
 *
 * Prices are USD per MILLION tokens, as published, copied on 2026-09-25. They will drift;
 * when they do, change this table and nothing else. A cache WRITE is the five-minute rate
 * (1.25x input), because that is the only cache lifetime the engine asks for.
 *
 * An unknown model - a new one set in MAIL_ASSISTANT_MODEL, or a server-side fallback to a
 * model this table has never heard of - is charged at the HIGHEST known rate for each kind
 * of token. Over-reporting a cost is an annoyance; under-reporting it is the officer
 * running out of credits while the screen said he had plenty.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Not asked for by name, but it answers: under fallbacks "default" (engine.ts) a request
  // Opus 5.5 declines on cyber-security grounds - an email about a clinic's hacked booking
  // site, say - is re-run on Opus 4.8. Without its row every such reply was charged at the
  // ceiling, double its real price, and the month stopped matching the invoice.
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

/**
 * The ceiling, taken field by field rather than as "the dearest model's row": no single
 * model is dearest on every line (Opus 5 and 4.8 have the dearest cache READ), and the point is
 * that an unknown model can never be charged less than any known one on any line.
 */
export const CEILING_PRICE: ModelPrice = Object.values(MODEL_PRICES).reduce(
  (max, p) => ({
    input: Math.max(max.input, p.input),
    output: Math.max(max.output, p.output),
    cacheRead: Math.max(max.cacheRead, p.cacheRead),
    cacheWrite: Math.max(max.cacheWrite, p.cacheWrite),
  }),
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
);

const log = new Logger('assistant');

/** Warned once per model per process: a sweep every 30 seconds would otherwise flood the log. */
const warnedAbout = new Set<string>();

/**
 * The price row for a model id.
 *
 * A dated snapshot id ("claude-haiku-4-5-20251001") is priced as its alias - Anthropic
 * prices a snapshot and its alias identically, and refusing to recognise one would charge
 * the ceiling for no reason.
 */
export function priceOf(model: string): { price: ModelPrice; known: boolean } {
  const id = model.trim().toLowerCase().replace(/-\d{8}$/, '');
  const price = MODEL_PRICES[id];
  if (price) return { price, known: true };
  if (!warnedAbout.has(id)) {
    warnedAbout.add(id);
    log.warn(
      `no price on file for model "${model}" - charging it at the highest known rate so the ` +
        'cost is never under-reported. Add it to assistant/pricing.ts.',
    );
  }
  return { price: CEILING_PRICE, known: false };
}

/**
 * Dollars for one batch of tokens on one model.
 *
 * Rounded to a millionth of a dollar: the sum of four float products otherwise carries
 * noise in the 17th digit into the database and onto the report.
 */
export function costOf(model: string, usage: TriageUsage): number {
  const { price } = priceOf(model);
  const dollars =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000;
  return roundUsd(dollars);
}

export function roundUsd(dollars: number): number {
  return Math.round(dollars * 1_000_000) / 1_000_000;
}
