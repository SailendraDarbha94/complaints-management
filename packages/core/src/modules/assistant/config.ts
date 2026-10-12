import { createHash } from 'node:crypto';
import { KSDC_ASSISTANT_PLAYBOOK } from '@ksdc/config';
import type { AssistantEffort } from './types.js';

/**
 * Whether the mail assistant runs, and within what limits.
 *
 * OFF unless somebody turns it on, on purpose. Every suggestion is a paid call to the
 * Anthropic API, billed to credits the officer bought, so the default must cost nothing:
 * a fresh clone, a test run or a misread .env file must never start spending. Turning it
 * on takes two things - MAIL_ASSISTANT=on (or =ask) and an API key - and when either is missing the
 * assistant is off WITH A REASON, because "it isn't doing anything" with no explanation is
 * the one state nobody can fix.
 *
 * A setting that is present but cannot be read (a limit of "fifty", an effort of "hgih")
 * also turns it off, with the variable named. Guessing what was meant is the wrong way
 * round for something that spends money: a typo should stop the spending, not set it.
 *
 * Reading ATTACHMENTS is a third switch, off by default even with the assistant on
 * (MAIL_ASSISTANT_ATTACHMENTS=on). With it off the model sees files by name only, as it
 * always has; with it on, it may ask for a file's contents, and that file goes to
 * Anthropic. Its two limits - files per email, pages per PDF - are checked like the rest.
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
  /**
   * Whether it reads new mail by itself (MAIL_ASSISTANT=on) or only the messages the
   * officer asks it about (MAIL_ASSISTANT=ask). False whenever it is off.
   */
  automatic: boolean;
  model: string;
  effort: AssistantEffort;
  /** Suggestions per council per day (the Council's own day), counting failures. */
  dailyLimit: number;
  /** At most this many new messages are read per mailbox sweep. */
  perSweep: number;
  /** Lookups per email before the engine gives up cleanly. */
  maxToolCalls: number;
  /**
   * Whether the model may ask for an attachment's contents (MAIL_ASSISTANT_ATTACHMENTS=on).
   * Off by default, and a switch of its own: reading a file sends it to Anthropic, which
   * is a bigger step than sending the email it came with, and costs more than the rest of
   * the reading together.
   */
  readAttachments: boolean;
  /** Files read per email at most (MAIL_ASSISTANT_MAX_ATTACHMENT_READS). */
  maxAttachmentReads: number;
  /** A PDF longer than this is cut to its first pages before it is sent (MAIL_ASSISTANT_MAX_PDF_PAGES). */
  maxPdfPages: number;
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
  // Three files covers the cases reading is for - the letter, the referral, the enclosure
  // with the case number - without letting one email's bundle of bills become the day's
  // spending. Ten pages is a complaint letter with its annexures. A PDF page is roughly
  // 1,500-3,000 tokens plus its page image (USD 0.006-0.014 a page on Sonnet 5.5), so a
  // full ten-page read costs six to fourteen cents - more than the email it came with.
  maxAttachmentReads: 3,
  maxPdfPages: 10,
} as const;

export function playbookVersionOf(playbook: string): string {
  return createHash('sha256').update(playbook, 'utf8').digest('hex');
}

/**
 * A whole number from min to max, or the default when unset; anything else is a
 * misconfiguration.
 */
function intSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max = Infinity,
): { value: number; problem: string | null } {
  const raw = env[name]?.trim();
  if (!raw) return { value: fallback, problem: null };
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    const range = Number.isFinite(max)
      ? ` from ${min} to ${max}`
      : min > 0
        ? ` of at least ${min}`
        : '';
    return { value: fallback, problem: `${name} must be a whole number${range}.` };
  }
  return { value: Number(raw), problem: null };
}

/**
 * The most files the reader may open for one email, whatever the setting says. Each file
 * is a page or a picture of somebody's medical record sent abroad; ten covers any genuine
 * complaint, and a ceiling means a slipped zero cannot send a hundred.
 */
export const MAX_ATTACHMENT_READS_CEILING = 10;

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
  // At least one each: a reader switched on with a budget of no files, or of no pages,
  // could only ever refuse - better said now, by name, than discovered on a card.
  const maxReads = intSetting(
    env,
    'MAIL_ASSISTANT_MAX_ATTACHMENT_READS',
    ASSISTANT_DEFAULTS.maxAttachmentReads,
    1,
    MAX_ATTACHMENT_READS_CEILING,
  );
  const maxPages = intSetting(env, 'MAIL_ASSISTANT_MAX_PDF_PAGES', ASSISTANT_DEFAULTS.maxPdfPages, 1);
  // Checked whether or not the reader is on, like every other limit here: a typo in a
  // setting somebody took the trouble to write is a misconfiguration either way, and
  // finding it only on the day the reader is switched on is finding it too late.
  for (const s of [daily, perSweep, maxTools, maxReads, maxPages]) if (s.problem) problems.push(s.problem);

  // Exactly "on", as MAIL_ASSISTANT is. Anything else - unset, "true", "yes" - leaves the
  // reader off without turning the assistant off: the email-only assistant is the one the
  // Council agreed to, and a half-remembered spelling must not widen what is sent.
  const readAttachments = env.MAIL_ASSISTANT_ATTACHMENTS?.trim() === 'on';

  // The order of these is the order the officer would fix them in.
  let reason: string | null = null;
  // Exactly "on" or "ask". Not "true", not "1", not "yes": the switch that spends money is
  // spelled one way, so a value somebody half-remembers leaves it off rather than guessing.
  //   on   reads each new message in the tray by itself;
  //   ask  reads only the messages the officer asks about, from the message page - for
  //        trying it on mail the officer chose (their own made-up complaints) before the
  //        Council has decided that real complainants' mail may go to the model.
  const mode = env.MAIL_ASSISTANT?.trim();
  if (mode !== 'on' && mode !== 'ask') {
    reason = 'MAIL_ASSISTANT is not set to on or ask.';
  } else if (!env.ANTHROPIC_API_KEY?.trim()) {
    reason = 'ANTHROPIC_API_KEY is missing.';
  } else if (problems.length) {
    reason = problems.join(' ');
  }

  const playbook = KSDC_ASSISTANT_PLAYBOOK;
  return {
    enabled: reason === null,
    reason,
    automatic: reason === null && mode === 'on',
    model,
    effort,
    dailyLimit: daily.value,
    perSweep: perSweep.value,
    maxToolCalls: maxTools.value,
    readAttachments,
    maxAttachmentReads: maxReads.value,
    maxPdfPages: maxPages.value,
    playbook,
    playbookVersion: playbookVersionOf(playbook),
  };
}
