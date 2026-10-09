import { createHash } from 'node:crypto';
import { KSDC_ASSISTANT_PLAYBOOK } from '@ksdc/config';
import type { AssistantEffort } from './types.js';

/**
 * Whether the mail assistant runs, and within what limits.
 *
 * OFF unless somebody turns it on, on purpose. Every suggestion is a paid call to the
 * Anthropic API, billed to credits the officer bought, so the default must cost nothing:
 * a fresh clone, a test run or a misread .env file must never start spending. Turning it
 * on takes two things - MAIL_ASSISTANT=on and an API key - and when either is missing the
 * assistant is off WITH A REASON, because "it isn't doing anything" with no explanation is
 * the one state nobody can fix.
 *
 * A setting that is present but cannot be read (a limit of "fifty", an effort of "hgih")
 * also turns it off, with the variable named. Guessing what was meant is the wrong way
 * round for something that spends money: a typo should stop the spending, not set it.
 *
 * The API key itself is deliberately not held here. Only whether it is present: this
 * object is logged, returned by routes and compared in tests, and a secret has no
 * business in any of those. The engine reads the key where it builds the client.
 */

/**
 * The efforts the assistant may be set to - deliberately not all the API offers.
 *
 * The engine asks for a non-streaming reply with room for 16,000 tokens (MAX_OUTPUT_TOKENS
 * in engine.ts), and the model's thinking counts against that room. At "xhigh" and "max"
 * the model thinks far longer: many turns would run out of room before the answer, which
 * the engine treats as a failure - paid for, counted against the daily limit, and no
 * suggestion. Those levels need a streaming client with a much larger limit; until the
 * engine has one, offering them would only be offering a way to spend money for nothing.
 * Triage is not the kind of work that repays them anyway.
 */
export const ASSISTANT_EFFORTS: readonly AssistantEffort[] = ['low', 'medium', 'high'];

export interface AssistantConfig {
  enabled: boolean;
  /** Why it is off, in words for the officer. Null when it is on. */
  reason: string | null;
  model: string;
  effort: AssistantEffort;
  /** Suggestions per council per day (the Council's own day), counting failures. */
  dailyLimit: number;
  /** At most this many new messages are read per mailbox sweep. */
  perSweep: number;
  /** Lookups per email before the engine gives up cleanly. */
  maxToolCalls: number;
  /** The Council's playbook - the cached system prompt. */
  playbook: string;
  /** sha256 of the playbook, stored on every suggestion so a change can be traced. */
  playbookVersion: string;
}

export const ASSISTANT_DEFAULTS = {
  // Sonnet, not Opus, on measured evidence: on the 30-email evaluation set (9 October 2026)
  // both got every decision right, and Sonnet 5.5 cost $0.010 an email against Opus 5.5's
  // $0.023. MAIL_ASSISTANT_MODEL=claude-opus-5-5 switches back.
  model: 'claude-sonnet-5-5',
  effort: 'medium' as AssistantEffort,
  dailyLimit: 50,
  perSweep: 5,
  maxToolCalls: 8,
} as const;

export function playbookVersionOf(playbook: string): string {
  return createHash('sha256').update(playbook, 'utf8').digest('hex');
}

/** A whole number >= min, or the default when unset; anything else is a misconfiguration. */
function intSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
): { value: number; problem: string | null } {
  const raw = env[name]?.trim();
  if (!raw) return { value: fallback, problem: null };
  if (!/^\d+$/.test(raw) || Number(raw) < min) {
    return {
      value: fallback,
      problem: `${name} must be a whole number${min > 0 ? ` of at least ${min}` : ''}.`,
    };
  }
  return { value: Number(raw), problem: null };
}

export function assistantConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
  const problems: string[] = [];

  const model = env.MAIL_ASSISTANT_MODEL?.trim() || ASSISTANT_DEFAULTS.model;

  const rawEffort = env.MAIL_ASSISTANT_EFFORT?.trim();
  let effort: AssistantEffort = ASSISTANT_DEFAULTS.effort;
  if (rawEffort) {
    if ((ASSISTANT_EFFORTS as readonly string[]).includes(rawEffort)) {
      effort = rawEffort as AssistantEffort;
    } else {
      problems.push(`MAIL_ASSISTANT_EFFORT must be one of ${ASSISTANT_EFFORTS.join(', ')}.`);
    }
  }

  // Zero is a legitimate daily limit - "on, but spend nothing today" - and is honoured by
  // the limit check rather than treated as a typo. A per-sweep or lookup budget of zero
  // could never produce a suggestion at all, so those must be at least one.
  const daily = intSetting(env, 'MAIL_ASSISTANT_DAILY_LIMIT', ASSISTANT_DEFAULTS.dailyLimit, 0);
  const perSweep = intSetting(env, 'MAIL_ASSISTANT_PER_SWEEP', ASSISTANT_DEFAULTS.perSweep, 1);
  const maxTools = intSetting(env, 'MAIL_ASSISTANT_MAX_TOOL_CALLS', ASSISTANT_DEFAULTS.maxToolCalls, 1);
  for (const s of [daily, perSweep, maxTools]) if (s.problem) problems.push(s.problem);

  // The order of these is the order the officer would fix them in.
  let reason: string | null = null;
  // Exactly "on". Not "true", not "1", not "yes": the switch that spends money is spelled
  // one way, so a value somebody half-remembers leaves it off rather than guessing.
  if (env.MAIL_ASSISTANT?.trim() !== 'on') {
    reason = 'MAIL_ASSISTANT is not set to on.';
  } else if (!env.ANTHROPIC_API_KEY?.trim()) {
    reason = 'ANTHROPIC_API_KEY is missing.';
  } else if (problems.length) {
    reason = problems.join(' ');
  }

  const playbook = KSDC_ASSISTANT_PLAYBOOK;
  return {
    enabled: reason === null,
    reason,
    model,
    effort,
    dailyLimit: daily.value,
    perSweep: perSweep.value,
    maxToolCalls: maxTools.value,
    playbook,
    playbookVersion: playbookVersionOf(playbook),
  };
}
