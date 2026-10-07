import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageParam,
  BetaRefusalStopDetails,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { z } from 'zod';
import { mailSuggestionConfidenceSchema, mailSuggestionDecisionSchema } from '@ksdc/contracts';
import { Logger } from '../../common/logger.js';
import { costOf, roundUsd } from './pricing.js';
import { canonicalCaseNumber, registrationKey } from './text-rules.js';
import {
  NUDGE,
  renderEmail,
  systemBlocks,
  TOOL_GET_CASE,
  TOOL_SEARCH_CASES,
  TOOL_SEARCH_DENTISTS,
  TOOL_SUBMIT,
  TRIAGE_TOOLS,
} from './prompt.js';
import type {
  DentistHit,
  RunTriage,
  SuggestedRespondent,
  TriageEmail,
  TriageOptions,
  TriageProposal,
  TriageResult,
  TriageTools,
  TriageUsage,
} from './types.js';

/**
 * The part that talks to Claude.
 *
 * One email in, one TriageResult out. It knows nothing about the database: it is handed
 * the email, three read-only lookup functions and its options, and it returns a proposal -
 * or a plain-English reason why there is none. Storing the suggestion, the daily limit,
 * and carrying out what the officer accepts all belong to assistant.service.ts.
 *
 * A HAND-WRITTEN LOOP, not the SDK's tool runner, because the rules that matter here sit
 * between the turns: a cap on lookups that fails the run rather than truncating it, one
 * nudge when the model stops without answering, a proposal that is checked and sent back
 * once if it does not hold together, ids that are kept only if a lookup in THIS run
 * produced them, and a running cost over every request. Each of those is a few lines in a
 * loop and a contortion in a runner. It also makes the client trivially fakeable - the
 * tests inject an object with one method and script its replies.
 *
 * THE OUTPUT NEVER CARRIES THE EMAIL. Every error string below is a fixed sentence (at
 * most naming the model or a refusal category), and nothing logged here includes the
 * email's text or the model's reading of it: a log line is the one place that text could
 * leak to without anyone deciding it should.
 */

const log = new Logger('assistant');

// ─── The client ──────────────────────────────────────────────────────────────

/**
 * The one method the engine uses. The real SDK client satisfies it; tests fake it.
 *
 * The second argument is the SDK's per-request options, narrowed to the two the engine
 * sets: the run's deadline as an abort signal, and how long this one request may take. A
 * fake may ignore it.
 */
export interface TriageClient {
  beta: {
    messages: {
      create(
        params: MessageCreateParamsNonStreaming,
        options?: { signal?: AbortSignal; timeout?: number },
      ): Promise<BetaMessage>;
    };
  };
}

export type MakeClient = () => TriageClient;

/**
 * The real client. The key is read here and only here (config.ts records only whether it
 * is present), straight from the environment into the SDK.
 *
 * Two retries with the SDK's own backoff covers a 429 or a 529 in passing. The timeout is
 * per attempt: a triage at medium effort answers in well under a minute, and a request
 * still hanging after two has failed in a way waiting longer will not fix.
 */
function defaultClient(): TriageClient {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 2,
    timeout: 120_000,
  });
}

// ─── The request ─────────────────────────────────────────────────────────────

/**
 * Server-side fallback, on by default. Claude Opus 5.5 runs safety classifiers that can
 * decline a request - and an email complaining about, say, an unsterilised instrument or
 * a patient's infection is exactly the kind of benign text a biology classifier can
 * misfire on. With `fallbacks: "default"` the API re-runs a declined request on the model
 * Anthropic recommends for that category, inside the same call; without it, a false
 * positive is simply a missing suggestion. The scalar "default" form goes with THIS
 * header; the array form has a different one, and mixing them is a 400.
 */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Room for the thinking AND the answer. Opus 5.5 always thinks, and thinking counts
 * against max_tokens even though its text is not returned; a limit sized for the answer
 * alone (a submit_suggestion call is a few hundred tokens) would cut turns off. 16,000 is
 * generous at medium effort and stays under the SDK's ceiling for a non-streaming request.
 */
export const MAX_OUTPUT_TOKENS = 16_000;

/** A proposal that does not hold together is sent back once; a second bad one ends the run. */
const MAX_SUBMISSIONS = 2;

/** At most this many hits from any one lookup reach the model. */
const MAX_HITS = 10;

/**
 * Requests per email beyond the lookups themselves: one for the answer, one for a nudge,
 * one for a corrected proposal, and one spare. Lookups made in parallel need fewer turns,
 * so this bound is only ever reached by a run that is going round in circles.
 */
const SPARE_TURNS = 4;

/**
 * The most respondents one suggestion may name - the same cap the service stores and the
 * accept route takes, so a proposal the engine accepts is never thrown away afterwards
 * for being too long, after it has been paid for. Here it is checked while the model can
 * still be told and correct it.
 */
export const MAX_RESPONDENTS = 10;

/**
 * The whole run's time, every request and every retry together.
 *
 * Each request has its own timeout and the SDK retries twice, so without an overall bound
 * one email could keep a reader - or an officer's "ask again" - waiting for many minutes,
 * spending all the while. A triage at medium effort takes well under a minute; one still
 * going after two and a half has gone wrong in a way that waiting longer will not fix.
 * Kept under the five minutes a hosted request is usually allowed, so the run ends - and
 * its row says why - before the platform cuts the request off with nothing recorded.
 */
export const RUN_DEADLINE_MS = 150_000;

/** One request's own limit, within the run's deadline. */
const REQUEST_TIMEOUT_MS = 120_000;

function buildRequest(opts: TriageOptions, messages: BetaMessageParam[]): MessageCreateParamsNonStreaming {
  return {
    model: opts.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemBlocks(opts.playbook),
    tools: [...TRIAGE_TOOLS],
    // A copy: this array keeps growing after the call, and a request object - in a test's
    // record of what was sent, or anywhere else - must not change after the fact.
    messages: [...messages],
    // Thinking is NOT set. On Opus 5.5 it is always on (adaptive), and both "disabled" and
    // a token budget are a 400. Effort is the control for how hard it thinks - and for cost.
    output_config: { effort: opts.effort },
    // tool_choice is NOT set either: "any" and "tool" are a 400 on Opus 5.5. The default,
    // auto, plus strict tools and a plain instruction, is what the model guide prescribes;
    // the loop below handles the turn where no submission comes.
    //
    // Automatic caching for the growing tail of the conversation, on top of the explicit
    // breakpoint at the end of the system prompt. An email that takes three requests then
    // re-reads its own earlier turns at the cache price rather than paying for them again.
    cache_control: { type: 'ephemeral' },
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
  };
}

// ─── Validating what the model sends ────────────────────────────────────────

const queryInput = z.object({ query: z.string().trim().min(1).max(300) });
const caseNumberInput = z.object({ case_number: z.string().trim().min(1).max(100) });

/** "", "   " and null all mean "not given". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

/**
 * The proposal, checked again here even though the tool is strict. Strict mode guarantees
 * the shape on the wire; this guarantees it in our hands - a different model in
 * MAIL_ASSISTANT_MODEL, a fallback, or a future change to the schema in prompt.ts must not
 * be able to put an unchecked value into the register's database. The enums are the
 * contracts', so a decision the rest of the system does not know cannot get through.
 */
const respondentInput = z.object({
  name: z.string().trim().min(1).max(300),
  registrationNo: optionalText(100),
  clinicName: optionalText(300),
  isEstablishment: z.boolean(),
  partyId: optionalText(100),
  registeredDentistId: optionalText(100),
});

const proposalInput = z.object({
  decision: mailSuggestionDecisionSchema,
  confidence: mailSuggestionConfidenceSchema,
  reasoning: z.string().trim().min(1).max(2000),
  notComplaint: z.object({ reason: z.string().trim().min(1).max(1000) }).nullable(),
  followUp: z
    .object({
      caseNumber: z.string().trim().min(1).max(100),
      because: z.string().trim().min(1).max(1000),
    })
    .nullable(),
  newComplaint: z
    .object({
      summary: z.string().trim().min(1).max(500),
      complainantName: z.string().trim().min(1).max(300),
      complainantEmail: optionalText(320),
      respondents: z.array(respondentInput).max(MAX_RESPONDENTS),
    })
    .nullable(),
});

type ProposalInput = z.infer<typeof proposalInput>;

const DETAIL_FOR: Record<Exclude<TriageProposal['decision'], 'unsure'>, keyof ProposalInput> = {
  not_a_complaint: 'notComplaint',
  follow_up: 'followUp',
  new_complaint: 'newComplaint',
};

/**
 * The rule the schema cannot state: exactly one detail object, and the one the decision
 * names; none at all for "unsure". A follow_up carrying a newComplaint is not a slightly
 * untidy answer, it is two answers, and the screen could only show one of them.
 */
function consistencyProblems(p: ProposalInput): string[] {
  const problems: string[] = [];
  for (const [decision, key] of Object.entries(DETAIL_FOR)) {
    const present = p[key] !== null;
    if (decision === p.decision && !present) {
      problems.push(`The decision is ${decision}, so ${key} must be filled in.`);
    }
    if (decision !== p.decision && present) {
      problems.push(`The decision is ${p.decision}, so ${key} must be null.`);
    }
  }
  return problems;
}

/**
 * Case numbers compared as the register would read them: case and spacing do not matter,
 * and a loosely written number ("KSDC-COMP-2026-27-42") is the case it plainly names - the
 * same reading the case lookup gives it (text-rules.ts).
 */
function caseKey(caseNumber: string): string {
  return (canonicalCaseNumber(caseNumber) ?? caseNumber).trim().toUpperCase().replace(/\s+/g, '');
}

const EMAIL_SHAPE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ─── Plain English for what went wrong ───────────────────────────────────────

const CATEGORY_WORDS: Record<string, string> = {
  cyber: 'computer security',
  bio: 'biology',
  frontier_llm: 'AI development',
  reasoning_extraction: 'revealing its own reasoning',
  general_harms: 'possible harm',
};

/**
 * A refusal, named. Branch on stop_reason, read stop_details only for the words: the
 * category can be null on a genuine refusal, and is not something to make decisions on.
 * The explanation field is deliberately not passed on - it is not guaranteed stable and
 * is not written for the officer.
 */
function refusalMessage(details: BetaRefusalStopDetails | null): string {
  const category = details?.category ?? null;
  const named = category
    ? `${CATEGORY_WORDS[category] ?? category} (category "${category}")`
    : 'no category was given';
  return (
    `Claude declined to deal with this email on safety grounds - ${named}. ` +
    'Please handle it with the ordinary buttons.'
  );
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * An API failure, in words the officer can act on. Classified by the SDK's error classes
 * and the API's error TYPE, never by matching message text - messages change, types don't.
 *
 * The log line carries the status, the type and Anthropic's request id (which support can
 * trace), and for a malformed-request error the API's own message: that one is about the
 * request's structure and is useless to debug without. No other message is logged.
 */
function apiErrorMessage(err: unknown, model: string): string {
  if (err instanceof APIUserAbortError) return 'The request to Claude was cancelled.';
  if (err instanceof APIConnectionTimeoutError) {
    log.warn('Claude did not answer in time');
    return 'Claude did not answer in time. Try again later.';
  }
  if (err instanceof APIConnectionError) {
    log.warn('could not reach the Claude API');
    return 'Could not reach Claude. Check the internet connection, then try again.';
  }
  if (err instanceof APIError) {
    const structural = err.type === 'invalid_request_error' || err.type === 'not_found_error';
    log.warn(
      `Claude API error: status ${err.status ?? '-'}, type ${err.type ?? 'unknown'}, ` +
        `request ${err.requestID ?? '-'}` +
        (structural ? ` - ${oneLine(err.message).slice(0, 300)}` : ''),
    );
    switch (err.type) {
      case 'authentication_error':
        return 'Claude did not accept the API key (ANTHROPIC_API_KEY). Check that it was copied correctly and has not been revoked.';
      case 'billing_error':
        return "Claude refused the request because of the account's billing - the credits may have run out. Check the Claude Console.";
      case 'permission_error':
        return `The API key is not allowed to use the model ${model}.`;
      case 'not_found_error':
        return `Claude does not recognise the model "${model}". Check MAIL_ASSISTANT_MODEL.`;
      case 'rate_limit_error':
        return 'Claude is receiving too many requests from this account just now. Try again in a few minutes.';
      case 'overloaded_error':
      case 'api_error':
      case 'timeout_error':
        return 'Claude is busy or unavailable just now. Try again later.';
      case 'invalid_request_error':
        return 'Claude rejected the request as malformed. This is a fault in the software, not in the email; the details are in the server log.';
    }
    if (err.status === 413) return 'This email is too large to send to Claude.';
    if (typeof err.status === 'number' && err.status >= 500) {
      return 'Claude is busy or unavailable just now. Try again later.';
    }
    return `Claude returned an error (status ${err.status ?? 'unknown'}). The details are in the server log.`;
  }
  log.warn(`triage failed unexpectedly (${errorName(err)})`);
  return 'The assistant failed unexpectedly while reading this email.';
}

// ─── One run ─────────────────────────────────────────────────────────────────

type Judged = { ok: true; proposal: TriageProposal } | { ok: false; problem: string };

/**
 * The state of triaging one email. A class only to keep the running totals - tokens,
 * dollars, lookups, what the lookups returned - in one place that every exit reads from,
 * so that a failure reports what was spent exactly as a success does.
 */
class TriageRun {
  private readonly usage: TriageUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  private costUsd = 0;
  private toolCalls = 0;
  /** The model that produced the latest reply - not always the one asked for (fallback). */
  private servedBy: string | null = null;
  /** Case numbers a lookup returned in THIS run, keyed for comparison, valued as written. */
  private readonly seenCases = new Map<string, string>();
  /** Dentists a search_dentists call returned in THIS run. */
  private readonly seenDentists: DentistHit[] = [];
  private readonly maxToolCalls: number;

  constructor(
    private readonly email: TriageEmail,
    private readonly tools: TriageTools,
    private readonly opts: TriageOptions,
  ) {
    this.maxToolCalls = Math.max(0, Math.floor(opts.maxToolCalls));
  }

  async execute(client: TriageClient): Promise<TriageResult> {
    const messages: BetaMessageParam[] = [
      { role: 'user', content: renderEmail(this.email, this.maxToolCalls) },
    ];
    const maxRequests = this.maxToolCalls + SPARE_TURNS;
    let nudged = false;
    let submissions = 0;

    // One clock for the whole run (RUN_DEADLINE_MS): it aborts a request in flight, SDK
    // retries included, and each request's own timeout is cut to what is left of it.
    const deadline = Date.now() + RUN_DEADLINE_MS;
    const signal = AbortSignal.timeout(RUN_DEADLINE_MS);
    const outOfTime = () =>
      this.fail(
        `Claude took more than ${Math.round(RUN_DEADLINE_MS / 60_000 * 10) / 10} minutes over this ` +
          'email and was stopped, so no suggestion was made. Try again later.',
      );

    for (let request = 0; request < maxRequests; request++) {
      const left = deadline - Date.now();
      if (left <= 0 || signal.aborted) return outOfTime();
      let reply: BetaMessage;
      try {
        reply = await client.beta.messages.create(buildRequest(this.opts, messages), {
          signal,
          timeout: Math.min(REQUEST_TIMEOUT_MS, left),
        });
      } catch (err) {
        if (signal.aborted) return outOfTime();
        return this.fail(apiErrorMessage(err, this.opts.model));
      }
      this.meter(reply);

      // The stop reason BEFORE the content. A refusal can arrive with empty content, or
      // with a tool call cut off part-way; max_tokens can leave a tool input that parses
      // as a valid but truncated object. Neither turn's tools may be run.
      switch (reply.stop_reason) {
        case 'refusal':
          return this.fail(refusalMessage(reply.stop_details));
        case 'max_tokens':
          return this.fail(
            'Claude ran out of room before it finished its answer for this email, so no suggestion was made.',
          );
        case 'model_context_window_exceeded':
          return this.fail('This email is too long for Claude to read in one go.');
        case 'tool_use':
        case 'end_turn':
        case 'stop_sequence':
        case 'pause_turn':
          break;
        default:
          return this.fail(`Claude stopped for an unexpected reason (${String(reply.stop_reason)}).`);
      }

      // The reply goes back VERBATIM, thinking blocks and any fallback marker included.
      // Opus 5.5 ties its thinking to the exact conversation that produced it; an edited
      // or reordered turn is a 400 on newer accounts and a lost cache on the rest. The
      // documented exception - drop blocks a declined model left BEFORE a fallback
      // marker - only arises when streaming: a non-streaming reply, which this is, omits
      // the declined attempt's partial output entirely, so there is nothing to drop.
      messages.push({ role: 'assistant', content: reply.content });

      // Only server-side tools pause, and none are offered - but if one ever did, the
      // documented way on is to send the turn back unchanged.
      if (reply.stop_reason === 'pause_turn') continue;

      const uses = reply.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');

      if (uses.length === 0) {
        // tool_choice cannot be forced on this model, so a turn that ends in prose is a
        // real possibility. One reminder; after that the email goes to the officer
        // unsuggested rather than round the loop again at his expense.
        if (nudged) {
          return this.fail('Claude finished without giving a suggestion, even when asked again.');
        }
        nudged = true;
        messages.push({ role: 'user', content: NUDGE });
        continue;
      }

      // An acceptable submission ends the run, whatever else was asked for in the same
      // turn: lookups requested alongside a final answer can no longer change it.
      const submit = uses.find((u) => u.name === TOOL_SUBMIT) ?? null;
      let submitProblem: string | null = null;
      if (submit) {
        submissions++;
        const judged = this.judge(submit.input);
        if (judged.ok) return this.succeed(judged.proposal);
        if (submissions >= MAX_SUBMISSIONS) {
          return this.fail(
            "Claude's suggestion did not hold together, even after it was asked to correct it, so it was not used.",
          );
        }
        submitProblem = judged.problem;
      }

      // The cap is checked BEFORE any of the turn's lookups run, so a run that would go
      // past it spends nothing more on lookups whose answers would never be used.
      const lookups = uses.filter((u) => isLookup(u.name));
      if (this.toolCalls + lookups.length > this.maxToolCalls) {
        return this.fail(
          `Claude needed more than ${this.maxToolCalls} lookups for this email and was stopped ` +
            'before it reached a suggestion.',
        );
      }

      // Every tool_use must be answered, in the next user turn, or the API rejects it.
      const results: BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        if (use === submit) {
          results.push(toolError(use.id, submitProblem ?? 'The suggestion was not accepted.'));
        } else if (use.name === TOOL_SUBMIT) {
          results.push(toolError(use.id, 'Only one submission per turn is read; this one was ignored.'));
        } else if (isLookup(use.name)) {
          results.push(await this.lookup(use));
        } else {
          results.push(toolError(use.id, 'There is no such tool.'));
        }
      }
      messages.push({ role: 'user', content: results });
    }

    return this.fail('Claude did not reach a suggestion within the number of steps allowed, so it was stopped.');
  }

  // ─── Lookups ───────────────────────────────────────────────────────────────

  /**
   * One read-only lookup, answered as JSON.
   *
   * A lookup is counted when it is ATTEMPTED, malformed or failing ones included: the cap
   * exists to bound what one email can cost, and a model retrying a bad query costs just
   * as much as one making good ones.
   *
   * A lookup that throws is answered with an error the model can work around, not a
   * failed run: the email can usually still be triaged without that one answer. Only the
   * tool name and the error's class are logged - a database error can carry the query,
   * and the query is built from the email.
   */
  private async lookup(use: BetaToolUseBlock): Promise<BetaToolResultBlockParam> {
    this.toolCalls++;
    const lookupsLeft = this.maxToolCalls - this.toolCalls;
    try {
      switch (use.name) {
        case TOOL_SEARCH_CASES: {
          const input = queryInput.safeParse(use.input);
          if (!input.success) return toolError(use.id, 'Give a non-empty "query" of at most 300 characters.');
          const hits = (await this.tools.searchCases(input.data.query)).slice(0, MAX_HITS);
          for (const h of hits) this.seeCase(h.caseNumber);
          return toolResult(use.id, { cases: hits, lookupsLeft });
        }
        case TOOL_GET_CASE: {
          const input = caseNumberInput.safeParse(use.input);
          if (!input.success) return toolError(use.id, 'Give a non-empty "case_number".');
          const found = await this.tools.getCase(input.data.case_number);
          if (!found) {
            return toolResult(use.id, {
              case: null,
              note: 'No case with that number is on the register.',
              lookupsLeft,
            });
          }
          this.seeCase(found.caseNumber);
          return toolResult(use.id, {
            case: {
              ...found,
              respondents: found.respondents.slice(0, 20),
              recentLetters: found.recentLetters.slice(0, 10),
            },
            lookupsLeft,
          });
        }
        case TOOL_SEARCH_DENTISTS: {
          const input = queryInput.safeParse(use.input);
          if (!input.success) return toolError(use.id, 'Give a non-empty "query" of at most 300 characters.');
          const hits = (await this.tools.searchDentists(input.data.query)).slice(0, MAX_HITS);
          this.seenDentists.push(...hits);
          return toolResult(use.id, { dentists: hits, lookupsLeft });
        }
        default:
          return toolError(use.id, 'There is no such tool.');
      }
    } catch (err) {
      log.warn(`${use.name} lookup failed (${errorName(err)})`);
      return toolError(use.id, 'The lookup failed. Try a different query, or decide without it.');
    }
  }

  private seeCase(caseNumber: string): void {
    if (caseNumber) this.seenCases.set(caseKey(caseNumber), caseNumber);
  }

  // ─── Judging the answer ────────────────────────────────────────────────────

  /**
   * Accept a submission, or say - to the MODEL, which gets one chance to fix it - what is
   * wrong with it. The problems are written for the model; the officer never sees them.
   */
  private judge(input: unknown): Judged {
    const parsed = proposalInput.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join('.') || '(top level)'}: ${i.message}`)
        .join('; ');
      return { ok: false, problem: `The suggestion is not in the expected form - ${issues}. Correct it and call ${TOOL_SUBMIT} again.` };
    }
    const p = parsed.data;
    const problems = consistencyProblems(p);

    // A follow-up must point at a case a lookup in THIS run returned. A case number the
    // model produced any other way - remembered from the email, or made up - is unchecked,
    // and filing a letter on the wrong case is the most damaging mistake this can make.
    if (p.followUp && !this.seenCases.has(caseKey(p.followUp.caseNumber))) {
      problems.push(
        `No lookup for this email returned the case ${p.followUp.caseNumber}. Open it with ${TOOL_GET_CASE} ` +
          'first to confirm it exists and fits, or choose another answer.',
      );
    }

    if (problems.length > 0) {
      return { ok: false, problem: `The suggestion was not accepted. ${problems.join(' ')} Correct it and call ${TOOL_SUBMIT} again.` };
    }
    return { ok: true, proposal: this.tidy(p) };
  }

  /** The accepted proposal, cleaned to what the register can rely on. */
  private tidy(p: ProposalInput): TriageProposal {
    return {
      decision: p.decision,
      confidence: p.confidence,
      reasoning: oneLine(p.reasoning),
      notComplaint: p.notComplaint ? { reason: oneLine(p.notComplaint.reason) } : null,
      followUp: p.followUp
        ? {
            // As the register writes it, not as the model happened to type it.
            caseNumber: this.seenCases.get(caseKey(p.followUp.caseNumber)) ?? p.followUp.caseNumber,
            because: oneLine(p.followUp.because),
          }
        : null,
      newComplaint: p.newComplaint
        ? {
            summary: oneLine(p.newComplaint.summary),
            complainantName: oneLine(p.newComplaint.complainantName),
            complainantEmail: this.complainantEmail(p.newComplaint.complainantEmail),
            respondents: p.newComplaint.respondents.map((r) => this.respondent(r)),
          }
        : null,
    };
  }

  /**
   * Kept only if it is shaped like an address AND appears in the email. An address the
   * model reconstructed or guessed would have the Council's letters sent to a stranger;
   * dropping it costs the officer one field to type, which he will see is empty.
   */
  private complainantEmail(address: string | null): string | null {
    if (!address) return null;
    const a = address.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(a)) return null;
    const haystack = [this.email.fromAddress ?? '', this.email.subject, this.email.body].join('\n').toLowerCase();
    return haystack.includes(a) ? a : null;
  }

  /**
   * A respondent, with its link to a known dentist kept only if a search_dentists call in
   * this run returned that id. An invented or stale id would attach this complaint to some
   * other dentist's history - in front of a committee - so it is dropped and the officer
   * links the dentist himself. And when the model gives BOTH ids, they must come from the
   * same hit: a partyId from one dentist with a registeredDentistId from another is a
   * contradiction, and neither half can be trusted.
   *
   * The REGISTRATION NUMBER is held to the same standard, because it is a link too: a new
   * person named with a number is joined, on accept, to whichever entry in the register of
   * dentists holds that number (RespondentService.createParty - "same number, same
   * dentist"). So a number is kept only if the email itself gives it, however it is
   * spaced or punctuated, or a dentist lookup in this run returned it. One the model made
   * up, or remembered from somewhere else, is dropped - the officer can type it.
   */
  private respondent(r: z.infer<typeof respondentInput>): SuggestedRespondent {
    const seen = this.seenDentists;
    let partyId = r.partyId && seen.some((h) => h.partyId === r.partyId) ? r.partyId : null;
    let registeredDentistId =
      r.registeredDentistId && seen.some((h) => h.registeredDentistId === r.registeredDentistId)
        ? r.registeredDentistId
        : null;
    if (
      partyId &&
      registeredDentistId &&
      !seen.some((h) => h.partyId === partyId && h.registeredDentistId === registeredDentistId)
    ) {
      partyId = null;
      registeredDentistId = null;
    }
    return {
      name: oneLine(r.name),
      registrationNo: this.registrationNo(r.registrationNo),
      clinicName: r.clinicName,
      isEstablishment: r.isEstablishment,
      partyId,
      registeredDentistId,
    };
  }

  /** See respondent(): a number the email gives, or a lookup returned - nothing else. */
  private registrationNo(given: string | null): string | null {
    if (!given) return null;
    const key = registrationKey(given);
    if (key.length < 3 || !/\d/.test(key)) return null;
    if (this.seenDentists.some((h) => h.registrationNo && registrationKey(h.registrationNo) === key)) {
      return given;
    }
    const inEmail = registrationKey([this.email.subject, this.email.body].join('\n'));
    return inEmail.includes(key) ? given : null;
  }

  // ─── Accounting and exits ──────────────────────────────────────────────────

  /**
   * Add one reply's tokens and dollars to the run.
   *
   * With fallbacks on, the top-level `usage` covers only the attempt that produced the
   * reply; `usage.iterations` is the per-attempt record, each attempt with its own model
   * (a declined Opus 5.5 attempt and the fallback that answered are billed separately, at
   * their own prices). So: the iterations when present, priced one by one, else the
   * top-level figures at the reply's model. If an attempt that declined before producing
   * anything turns out not to be billed, this over-reports it - the right way round.
   */
  private meter(reply: BetaMessage): void {
    this.servedBy = reply.model || this.servedBy;
    const replyModel = reply.model || this.opts.model;
    const iterations = reply.usage.iterations ?? [];
    const batches =
      iterations.length > 0
        ? iterations.map((it) => ({
            model: ('model' in it && typeof it.model === 'string' && it.model) || replyModel,
            usage: tokensOf(it),
          }))
        : [{ model: replyModel, usage: tokensOf(reply.usage) }];
    for (const b of batches) {
      this.usage.inputTokens += b.usage.inputTokens;
      this.usage.outputTokens += b.usage.outputTokens;
      this.usage.cacheReadTokens += b.usage.cacheReadTokens;
      this.usage.cacheWriteTokens += b.usage.cacheWriteTokens;
      this.costUsd += costOf(b.model, b.usage);
    }
  }

  private totals() {
    return {
      model: this.servedBy ?? this.opts.model,
      usage: { ...this.usage },
      costUsd: roundUsd(this.costUsd),
      toolCalls: this.toolCalls,
    };
  }

  private succeed(proposal: TriageProposal): TriageResult {
    return { ok: true, proposal, ...this.totals() };
  }

  fail(error: string): TriageResult {
    log.warn(`no suggestion: ${error}`);
    return { ok: false, error, ...this.totals() };
  }
}

function isLookup(name: string): boolean {
  return name === TOOL_SEARCH_CASES || name === TOOL_GET_CASE || name === TOOL_SEARCH_DENTISTS;
}

function tokensOf(u: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): TriageUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** Lookup answers are JSON, parsed by the model as data. Never prose built from the hits. */
function toolResult(id: string, body: unknown): BetaToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(body) };
}

function toolError(id: string, message: string): BetaToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: id, is_error: true, content: message };
}

// ─── The function the rest of the system calls ───────────────────────────────

/**
 * Build a RunTriage. `makeClient` is for tests, which pass a fake; left out, the real SDK
 * client is built on first use and reused.
 *
 * With the real client and no ANTHROPIC_API_KEY the run fails at once, before anything is
 * constructed - config.ts should have kept the assistant off already, but the engine does
 * not lean on that: no key, no request, and a reason that says so.
 */
export function createRunTriage(makeClient?: MakeClient): RunTriage {
  let client: TriageClient | null = null;

  return async (email, tools, opts) => {
    const run = new TriageRun(email, tools, opts);
    if (!makeClient && !process.env.ANTHROPIC_API_KEY?.trim()) {
      return run.fail('ANTHROPIC_API_KEY is not set, so the assistant cannot reach Claude.');
    }
    if (!client) {
      try {
        client = (makeClient ?? defaultClient)();
      } catch (err) {
        // Not cached: a later call, after the configuration is fixed, tries again.
        return run.fail(apiErrorMessage(err, opts.model));
      }
    }
    return run.execute(client);
  };
}

export const runTriage: RunTriage = createRunTriage();
