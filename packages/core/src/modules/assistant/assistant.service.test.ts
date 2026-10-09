import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import { closeDb, initDb, withCouncil, type Tx } from '@ksdc/db';
import { KSDC_CONFIG } from '@ksdc/config';
import { CaseIntakeService } from '../cases/case-intake.service.js';
import { CaseLifecycleService } from '../cases/case-lifecycle.service.js';
import { RespondentService } from '../cases/respondent.service.js';
import { CorrespondenceService } from '../correspondence/correspondence.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { FollowupService, type EngineContext } from '../followups/followup.service.js';
import { LocalStorage } from '../documents/storage.js';
import { MailIntakeService } from '../mail/mail-intake.service.js';
import { seedCouncilAndOfficer } from '../../test-support/fixtures.js';
import { todayIn } from '../../common/working-days.js';
import { AssistantService, SET_ASIDE_PREFIX, STILL_READING } from './assistant.service.js';
import { assistantConfigFromEnv, playbookVersionOf, type AssistantConfig } from './config.js';
import { registerTools } from './register-tools.js';
import type {
  RunTriage,
  TriageEmail,
  TriageProposal,
  TriageResult,
  TriageTools,
} from './types.js';

/**
 * The mail assistant's register side, against a real database, with a FAKE model.
 *
 * Nothing here calls the Anthropic API: every suggestion comes from `answer` below, which
 * each test sets. What is under test is everything around the model - what it is shown,
 * what it may look up, what is stored, and what an accepted suggestion does to the
 * register - and above all the two rules stage 1 is built on: nothing the model does
 * changes the register, and every outcome is recorded so the agreement rate is honest.
 *
 * suggestFor() opens its own transactions (it must never hold one across a model call),
 * so the messages it reads are committed first, each in a scope of its own.
 */

const councilId = 'c0a51111-1111-4111-8111-111111111111';
const officer = 'c0a52222-2222-4222-8222-222222222222';
// A second council, used only by the report test, so its numbers are exactly its own.
const reportCouncilId = 'c0a53333-3333-4333-8333-333333333333';
const reportOfficer = 'c0a54444-4444-4444-8444-444444444444';

// The council's own AI switch on, as it will be once the Registrar has signed: the seed
// ships it off (D16), and one test below checks that off means off.
const AI_ON = { ...KSDC_CONFIG, aiEnabled: true };
const ctx: EngineContext = { councilId, userId: officer, config: AI_ON };
const reportCtx: EngineContext = { councilId: reportCouncilId, userId: reportOfficer, config: AI_ON };

// Names unique to this run, so searches by name cannot meet another test's rows.
const TAG = `Q${Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6)}`;

const followups = new FollowupService();
const lifecycle = new CaseLifecycleService(followups);
const intake = new CaseIntakeService(followups);
const correspondence = new CorrespondenceService(lifecycle, followups);
const storage = new LocalStorage();
const documents = new DocumentsService(storage);
const respondents = new RespondentService();

// ─── The fake model ──────────────────────────────────────────────────────────

type Answer = (email: TriageEmail, tools: TriageTools) => Promise<TriageResult> | TriageResult;
let answer: Answer;
let seen: TriageEmail[] = [];
const fakeTriage: RunTriage = async (email, tools) => {
  seen.push(email);
  return answer(email, tools);
};

function ok(proposal: TriageProposal, costUsd = 0.01): TriageResult {
  return {
    ok: true,
    proposal,
    model: 'fake-model',
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, cacheWriteTokens: 0 },
    costUsd,
    toolCalls: 2,
  };
}
const notComplaint = (reason = 'A circular from another body, not a complaint.'): TriageProposal => ({
  decision: 'not_a_complaint',
  confidence: 'high',
  reasoning: 'It is a circular addressed to every council.',
  notComplaint: { reason },
  followUp: null,
  newComplaint: null,
});
const followUp = (caseNumber: string): TriageProposal => ({
  decision: 'follow_up',
  confidence: 'high',
  reasoning: 'The same complainant writing about the same crown.',
  notComplaint: null,
  followUp: { caseNumber, because: 'Same complainant, same treatment.' },
  newComplaint: null,
});
const newComplaint = (nc: NonNullable<TriageProposal['newComplaint']>): TriageProposal => ({
  decision: 'new_complaint',
  confidence: 'medium',
  reasoning: 'A patient describing treatment that went wrong.',
  notComplaint: null,
  followUp: null,
  newComplaint: nc,
});
const unsure = (): TriageProposal => ({
  decision: 'unsure',
  confidence: 'low',
  reasoning: 'Too little in the message to tell.',
  notComplaint: null,
  followUp: null,
  newComplaint: null,
});

function config(over: Partial<AssistantConfig> = {}): AssistantConfig {
  return {
    enabled: true,
    reason: null,
    model: 'fake-model',
    effort: 'medium',
    dailyLimit: 10_000,
    perSweep: 5,
    maxToolCalls: 8,
    playbook: 'test playbook',
    playbookVersion: playbookVersionOf('test playbook'),
    ...over,
  };
}

// The mail service tells the assistant what the officer did; the assistant carries out an
// accepted suggestion through the mail service. Wired as services.ts wires them.
let assistant: AssistantService;
const mail = new MailIntakeService(storage, intake, correspondence, documents, followups, {
  officerActed: (tx, c, id, act) => assistant.officerActed(tx, c, id, act),
  suggestAfterSweep: (c, ids) => assistant.suggestAfterSweep(c, ids),
});
assistant = new AssistantService(mail, respondents, fakeTriage, config());

// ─── Helpers ─────────────────────────────────────────────────────────────────

const asOfficer = <T>(c: EngineContext, fn: (tx: Tx) => Promise<T>) =>
  withCouncil({ councilId: c.councilId, userId: c.userId ?? null }, fn);

let seq = 0;
/** A complaint forwarded by the office, Gmail-style, as a mail server hands it over. */
async function arrive(
  c: EngineContext,
  from: { name: string; email: string },
  subject: string,
  body: string,
): Promise<string> {
  seq++;
  const inner = [
    'Sir, please log this.',
    '',
    '---------- Forwarded message ---------',
    `From: ${from.name} <${from.email}>`,
    'Date: Tue, 16 Sep 2026 at 19:12',
    `Subject: ${subject}`,
    'To: <registrar@asst.test>',
    '',
    body,
  ].join('\r\n');
  const bytes = Buffer.from(
    [
      'From: Dental Officer <officer@asst.test>',
      'To: intake@asst.test',
      `Subject: Fwd: ${subject}`,
      `Message-ID: <asst-${TAG}-${seq}@mail.test>`,
      'Date: Wed, 17 Sep 2026 10:14:00 +0530',
      'Content-Type: text/plain; charset=utf-8',
      '',
      inner,
    ].join('\r\n'),
    'utf8',
  );
  const parsed = await simpleParser(bytes);
  const out = await asOfficer(c, (tx) =>
    mail.ingest(tx, c, parsed, { mailbox: 'INBOX', uid: 1000 + seq, uidValidity: '1', raw: bytes }),
  );
  expect(out.status).toBe('unfiled');
  return out.mailMessageId;
}

let people = 0;
/**
 * A complainant nobody else in this run shares. The number is fenced by letters so that
 * person 1's name is not a substring of person 12's - name search matches substrings.
 */
function person(first = 'Kavitha') {
  people++;
  return { name: `${first} ${TAG}N${people}Z`, email: `p${people}.${TAG.toLowerCase()}@example.in` };
}

/**
 * A message sent STRAIGHT to the intake mailbox, not a recognisable forward - as an office
 * webmail forward the unwrapper did not recognise arrives.
 */
async function arriveDirect(
  c: EngineContext,
  from: { name: string; email: string },
  subject: string,
  body: string,
): Promise<string> {
  seq++;
  const bytes = Buffer.from(
    [
      `From: ${from.name} <${from.email}>`,
      'To: intake@asst.test',
      `Subject: ${subject}`,
      `Message-ID: <asst-direct-${TAG}-${seq}@mail.test>`,
      'Date: Wed, 17 Sep 2026 10:14:00 +0530',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n'),
    'utf8',
  );
  const parsed = await simpleParser(bytes);
  const out = await asOfficer(c, (tx) =>
    mail.ingest(tx, c, parsed, { mailbox: 'INBOX', uid: 1000 + seq, uidValidity: '1', raw: bytes }),
  );
  expect(out.status).toBe('unfiled');
  return out.mailMessageId;
}

/** Suggestions made today in a council - what the daily limit counts. */
async function madeToday(c: EngineContext): Promise<number> {
  const used = await asOfficer(c, (tx) =>
    tx.execute<{ n: number }>(sql`
      SELECT count(*)::int n FROM mail_suggestion
      WHERE council_id = ${c.councilId}::uuid
        AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
    `),
  );
  return used.rows[0]!.n;
}

/** A real case, opened from a message the ordinary way. */
async function caseFrom(c: EngineContext, who = person()) {
  const id = await arrive(c, who, 'Crown came off within a week', 'My crown came off.');
  const opened = await asOfficer(c, (tx) => mail.openCase(tx, c, { mailMessageId: id }));
  return { ...opened, who, mailMessageId: id };
}

async function suggestionRows(c: EngineContext, mailMessageId: string) {
  return asOfficer(c, async (tx) => {
    const rows = await tx.execute<{
      status: string;
      decision: string | null;
      outcome_action: string | null;
      outcome_agreed: boolean | null;
      outcome_case_file_id: string | null;
      outcome_note: string | null;
      acted_by: string | null;
      created_by: string | null;
      cost_usd: string;
      input_tokens: number;
      playbook_version: string;
      error: string | null;
      proposal: TriageProposal | null;
    }>(sql`
      SELECT status::text, decision::text, outcome_action, outcome_agreed, outcome_case_file_id,
             outcome_note, acted_by, created_by, cost_usd, input_tokens, playbook_version, error,
             proposal
      FROM mail_suggestion
      WHERE council_id = ${c.councilId}::uuid AND mail_message_id = ${mailMessageId}::uuid
      ORDER BY created_at, (status = 'pending')
    `);
    return rows.rows;
  });
}

async function messageRow(c: EngineContext, id: string) {
  return asOfficer(c, async (tx) => {
    const r = await tx.execute<{ status: string; case_file_id: string | null; dismissed_reason: string | null }>(sql`
      SELECT status::text, case_file_id, dismissed_reason FROM mail_message
      WHERE council_id = ${c.councilId}::uuid AND id = ${id}::uuid
    `);
    return r.rows[0]!;
  });
}

beforeAll(async () => {
  initDb({ connectionString: process.env.TEST_DATABASE_URL });
  for (const [cid, oid, code] of [
    [councilId, officer, 'ASST'],
    [reportCouncilId, reportOfficer, 'ASRP'],
  ] as const) {
    await withCouncil({ councilId: cid }, async (tx) => {
      await seedCouncilAndOfficer(tx, { councilId: cid, officerId: oid, code });
      await tx.execute(sql`
        INSERT INTO council_config (council_id, config)
        VALUES (${cid}::uuid, ${JSON.stringify(KSDC_CONFIG)}::jsonb)
        ON CONFLICT (council_id) DO UPDATE SET config = EXCLUDED.config
      `);
    });
  }
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  seen = [];
  answer = () => ok(notComplaint());
});

// ─── Switching it on ─────────────────────────────────────────────────────────

describe('whether the assistant is on', () => {
  // Never a real key: these only check that one is present.
  const KEY = { ANTHROPIC_API_KEY: 'placeholder-not-a-real-key' };

  it('is off by default, and says why', () => {
    const c = assistantConfigFromEnv({});
    expect(c.enabled).toBe(false);
    expect(c.reason).toBe('MAIL_ASSISTANT is not set to on.');
    expect(c).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium', dailyLimit: 50, perSweep: 5, maxToolCalls: 8 });
    expect(c.playbookVersion).toMatch(/^[0-9a-f]{64}$/);
  });

  it('needs exactly "on", and a key', () => {
    expect(assistantConfigFromEnv({ ...KEY, MAIL_ASSISTANT: 'true' }).enabled).toBe(false);
    expect(assistantConfigFromEnv({ MAIL_ASSISTANT: 'on' }).reason).toBe('ANTHROPIC_API_KEY is missing.');
    const on = assistantConfigFromEnv({ ...KEY, MAIL_ASSISTANT: 'on' });
    expect(on).toMatchObject({ enabled: true, reason: null });
    // The key is checked, never kept: this object is logged and sent to screens.
    expect(JSON.stringify(on)).not.toContain(KEY.ANTHROPIC_API_KEY);
  });

  it('takes its limits from the environment, and a setting it cannot read turns it off', () => {
    const tuned = assistantConfigFromEnv({
      ...KEY,
      MAIL_ASSISTANT: 'on',
      MAIL_ASSISTANT_MODEL: 'claude-other',
      MAIL_ASSISTANT_EFFORT: 'high',
      MAIL_ASSISTANT_DAILY_LIMIT: '0',
      MAIL_ASSISTANT_PER_SWEEP: '2',
      MAIL_ASSISTANT_MAX_TOOL_CALLS: '4',
    });
    expect(tuned).toMatchObject({
      enabled: true,
      model: 'claude-other',
      effort: 'high',
      dailyLimit: 0,
      perSweep: 2,
      maxToolCalls: 4,
    });

    const typo = assistantConfigFromEnv({ ...KEY, MAIL_ASSISTANT: 'on', MAIL_ASSISTANT_EFFORT: 'hgih' });
    expect(typo.enabled).toBe(false);
    expect(typo.reason).toMatch(/MAIL_ASSISTANT_EFFORT/);
    const words = assistantConfigFromEnv({ ...KEY, MAIL_ASSISTANT: 'on', MAIL_ASSISTANT_DAILY_LIMIT: 'fifty' });
    expect(words.enabled).toBe(false);
    expect(words.reason).toMatch(/MAIL_ASSISTANT_DAILY_LIMIT/);
  });
});

// ─── Asking ──────────────────────────────────────────────────────────────────

describe('asking the assistant about a message', () => {
  it('stores a pending suggestion, and asking again supersedes it - one card, two rows', async () => {
    const id = await arrive(ctx, person(), 'A circular about fees', 'Please note the revised fees.');

    const first = await assistant.suggestFor(ctx, id);
    expect(first.status).toBe('pending');
    expect(first.decision).toBe('not_a_complaint');
    expect(first.notComplaint?.reason).toMatch(/circular/);
    expect(first.followUp).toBeNull();
    expect(first.newComplaint).toBeNull();
    expect(first.costUsd).toBeCloseTo(0.01);
    expect(first.outcome).toBeNull();

    const second = await assistant.suggestFor(ctx, id);
    expect(second.id).not.toBe(first.id);

    const rows = await suggestionRows(ctx, id);
    expect(rows.map((r) => r.status)).toEqual(['superseded', 'pending']);
    // Kept, with what it cost and what produced it: a month's cost has to add up.
    expect(rows[0]!.input_tokens).toBe(1200);
    expect(rows[0]!.playbook_version).toBe(playbookVersionOf('test playbook'));
    expect(rows[0]!.created_by).toBe(officer);

    // The card shows the latest.
    const latest = await asOfficer(ctx, (tx) => assistant.latestFor(tx, ctx, [id]));
    expect(latest.get(id)?.id).toBe(second.id);
  });

  it('changes nothing in the register - the message stays in the tray', async () => {
    const before = await asOfficer(ctx, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int n FROM case_file WHERE council_id = ${councilId}::uuid`),
    );
    const id = await arrive(ctx, person(), 'Root canal pain', 'The root canal still hurts.');
    answer = () =>
      ok(newComplaint({ summary: 'Pain after root canal', complainantName: 'X', complainantEmail: null, respondents: [] }));
    await assistant.suggestFor(ctx, id);

    const after = await asOfficer(ctx, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int n FROM case_file WHERE council_id = ${councilId}::uuid`),
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect((await messageRow(ctx, id)).status).toBe('unfiled');
  });

  it('shows the model the ORIGINAL email, narrowly: the complainant, not the office that forwarded it', async () => {
    const who = person();
    const id = await arrive(ctx, who, 'Crown came off within a week', 'My crown was fitted in June.');
    await assistant.suggestFor(ctx, id);

    const email = seen.at(-1)!;
    expect(email.fromName).toBe(who.name);
    expect(email.fromAddress).toBe(who.email);
    expect(email.forwardedBy).toMatch(/officer@asst\.test/);
    expect(email.subject).toBe('Crown came off within a week');
    // As written: a forwarded date has no timezone, and none is invented for it.
    expect(email.dateText).toBe('Tue, 16 Sep 2026 at 19:12');
    expect(email.body).toMatch(/crown was fitted in June/);
    // The officer's covering note is not the complaint.
    expect(email.body).not.toMatch(/please log this/);
    expect(email.attachments).toEqual([]);
    // Nothing else from the row travels.
    expect(Object.keys(email).sort()).toEqual(
      ['attachments', 'body', 'dateText', 'forwardedBy', 'fromAddress', 'fromName', 'subject'].sort(),
    );
  });

  it('asks nothing at all when switched off, and says why', async () => {
    const off = new AssistantService(
      mail,
      respondents,
      fakeTriage,
      config({ enabled: false, reason: 'MAIL_ASSISTANT is not set to on.' }),
    );
    const id = await arrive(ctx, person(), 'Bleeding gums', 'My gums bleed.');

    await expect(off.suggestFor(ctx, id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/switched off.*MAIL_ASSISTANT is not set to on/),
    });
    await off.suggestAfterSweep(ctx, [id]);

    expect(seen).toHaveLength(0);
    expect(await suggestionRows(ctx, id)).toHaveLength(0);
    expect(off.status()).toEqual({ enabled: false, reason: 'MAIL_ASSISTANT is not set to on.' });
  });

  it('stops at the daily limit, before calling the model, with a 429', async () => {
    const used = await asOfficer(ctx, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int n FROM mail_suggestion
        WHERE council_id = ${councilId}::uuid
          AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
      `),
    );
    const limited = new AssistantService(
      mail,
      respondents,
      fakeTriage,
      config({ dailyLimit: used.rows[0]!.n + 1 }),
    );
    const a = await arrive(ctx, person(), 'Loose filling', 'The filling fell out.');
    const b = await arrive(ctx, person(), 'Another loose filling', 'Mine too.');

    await limited.suggestFor(ctx, a);
    await expect(limited.suggestFor(ctx, b)).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/daily limit/),
    });
    expect(seen).toHaveLength(1);
    expect(await suggestionRows(ctx, b)).toHaveLength(0);
  });

  it('stores a failure as a failed suggestion, with its cost, rather than throwing', async () => {
    const id = await arrive(ctx, person(), 'Overcharged', 'I was charged twice.');

    answer = () => ({
      ok: false,
      error: 'The assistant stopped after too many lookups.',
      model: 'fake-model',
      usage: { inputTokens: 5000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.0234,
      toolCalls: 8,
    });
    const failed = await assistant.suggestFor(ctx, id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('The assistant stopped after too many lookups.');
    expect(failed.decision).toBeNull();
    expect(failed.costUsd).toBeCloseTo(0.0234);

    // An engine that throws is a failed card too, not a 500.
    answer = () => {
      throw new Error('socket hang up');
    };
    const thrown = await assistant.suggestFor(ctx, id);
    expect(thrown.status).toBe('failed');
    expect(thrown.error).toMatch(/could not be reached/);

    // And an answer in the wrong shape is never put on a card to be accepted.
    answer = () => ok({ ...followUp('ASST/COMP/2026-27/0001'), followUp: null });
    const malformed = await assistant.suggestFor(ctx, id);
    expect(malformed.status).toBe('failed');
    expect(malformed.error).toMatch(/not in the form expected/);

    // Failures are not pending, so nothing was superseded by them.
    expect((await suggestionRows(ctx, id)).map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
  });

  it('asks only about messages still in the tray', async () => {
    const opened = await caseFrom(ctx);
    await expect(assistant.suggestFor(ctx, opened.mailMessageId)).rejects.toMatchObject({ status: 409 });
    expect(seen).toHaveLength(0);
  });

  it('drops dentist ids the model invented rather than trusting them', async () => {
    const id = await arrive(ctx, person(), 'Wrong tooth extracted', 'They took the wrong tooth.');
    answer = () =>
      ok(
        newComplaint({
          summary: 'Wrong tooth extracted',
          complainantName: 'Somebody',
          complainantEmail: null,
          respondents: [
            {
              name: 'Dr Invented',
              registrationNo: null,
              clinicName: null,
              isEstablishment: false,
              partyId: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e',
              registeredDentistId: 'not-a-uuid',
            },
          ],
        }),
      );
    const view = await assistant.suggestFor(ctx, id);
    expect(view.newComplaint?.respondents[0]).toMatchObject({
      name: 'Dr Invented',
      partyId: null,
      registeredDentistId: null,
    });
  });

  it("does nothing while the council's own AI switch is off, whatever the environment says", async () => {
    // The seed's configuration: aiEnabled false until the Registrar signs (D16).
    const councilOff: EngineContext = { ...ctx, config: KSDC_CONFIG };
    expect(KSDC_CONFIG.aiEnabled).toBe(false);
    const id = await arrive(ctx, person(), 'Bleeding after extraction', 'It will not stop.');

    await expect(assistant.suggestFor(councilOff, id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/aiEnabled.*Registrar/),
    });
    await assistant.suggestAfterSweep(councilOff, [id]);
    expect(seen).toHaveLength(0);
    expect(await suggestionRows(ctx, id)).toHaveLength(0);

    expect(assistant.status(councilOff)).toMatchObject({ enabled: false, reason: expect.stringMatching(/aiEnabled/) });
    expect(assistant.status(ctx)).toEqual({ enabled: true, reason: null });
    // Both switches off: both reasons, so one restart fixes both.
    const bothOff = new AssistantService(mail, respondents, fakeTriage, config({ enabled: false, reason: 'ANTHROPIC_API_KEY is missing.' }));
    expect(bothOff.status(councilOff).reason).toMatch(/ANTHROPIC_API_KEY is missing\..*aiEnabled/);
  });

  it('counts a reading against the limit from the moment it starts, not when it answers', async () => {
    // Written only afterwards, a reading cut off part-way would be paid for and never
    // counted - and "ask again" could then spend without limit.
    const limited = new AssistantService(
      mail,
      respondents,
      fakeTriage,
      config({ dailyLimit: (await madeToday(ctx)) + 1 }),
    );
    const a = await arrive(ctx, person(), 'Swelling', 'My face is swollen.');
    const b = await arrive(ctx, person(), 'Another swelling', 'Mine too.');

    let midway: Awaited<ReturnType<typeof suggestionRows>> = [];
    let second: unknown;
    answer = async () => {
      // While the model "reads": the row is already there, saying it has not finished...
      midway = await suggestionRows(ctx, a);
      // ...and it already counts, so a second reading is refused at the limit.
      second = await limited.suggestFor(ctx, b).catch((e: unknown) => e);
      return ok(notComplaint());
    };
    const view = await limited.suggestFor(ctx, a);

    expect(midway).toHaveLength(1);
    expect(midway[0]).toMatchObject({ status: 'failed', decision: null, error: STILL_READING });
    expect(second).toMatchObject({ status: 429 });
    // The answer replaced that row rather than adding one.
    const after = await suggestionRows(ctx, a);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'pending', error: null, decision: 'not_a_complaint' });
    expect(view.status).toBe('pending');
    expect(await suggestionRows(ctx, b)).toHaveLength(0);
  });

  it('keeps a pending suggestion on the card when asking again fails', async () => {
    const id = await arrive(ctx, person(), 'Circular on CDE points', 'Please note.');
    const first = await assistant.suggestFor(ctx, id);
    answer = () => ({
      ok: false,
      error: 'Claude is busy or unavailable just now. Try again later.',
      model: 'fake-model',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      toolCalls: 0,
    });
    await assistant.suggestFor(ctx, id);

    expect((await suggestionRows(ctx, id)).map((r) => r.status).sort()).toEqual(['failed', 'pending']);
    // The newer row is the failure; the card still shows the suggestion that is live.
    const shown = (await asOfficer(ctx, (tx) => assistant.latestFor(tx, ctx, [id]))).get(id)!;
    expect(shown).toMatchObject({ id: first.id, status: 'pending' });
  });

  it('never puts the Council forward as the complainant', async () => {
    // The model named the Council - a forward the unwrapper missed, a "To:" line in the body.
    const id = await arrive(ctx, person(), 'Painful filling', 'The filling hurts.');
    answer = () =>
      ok(
        newComplaint({
          summary: 'Painful filling',
          complainantName: 'Registrar <registrar@asst.test>',
          complainantEmail: 'REGISTRAR@asst.test',
          respondents: [],
        }),
      );
    const view = await assistant.suggestFor(ctx, id);
    expect(view.newComplaint).toMatchObject({ complainantName: '', complainantEmail: null });

    // Nobody is put on a case as complaining until the officer says who.
    await expect(asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id))).rejects.toThrow(/who complained/);
    expect((await messageRow(ctx, id)).status).toBe('unfiled');
    const out = await asOfficer(ctx, (tx) =>
      assistant.accept(tx, ctx, id, { complainantName: 'Leela Prasad', complainantEmail: 'leela@example.in' }),
    );
    expect(out.caseNumber).toBeTruthy();
    expect((await suggestionRows(ctx, id))[0]).toMatchObject({ status: 'edited', outcome_agreed: true });
  });

  it("shows a message from the Council's own address as the office forwarding it, with no sender", async () => {
    const id = await arriveDirect(
      ctx,
      { name: 'Test Registrar', email: 'registrar@asst.test' },
      'Complaint received at the counter',
      'A patient came in to complain that her crown came off within a week.',
    );
    await assistant.suggestFor(ctx, id);
    const email = seen.at(-1)!;
    expect(email.fromAddress).toBeNull();
    expect(email.fromName).toBeNull();
    expect(email.forwardedBy).toMatch(/registrar@asst\.test/);
  });
});

describe('the sweep hook', () => {
  it('reads at most perSweep messages, one at a time, and a failure does not stop the next', async () => {
    const sweeper = new AssistantService(mail, respondents, fakeTriage, config({ perSweep: 2 }));
    const a = await arrive(ctx, person(), 'One', 'one');
    const b = await arrive(ctx, person(), 'Two', 'two');
    const c = await arrive(ctx, person(), 'Three', 'three');

    let n = 0;
    answer = () => {
      n++;
      if (n === 1) throw new Error('boom');
      return ok(notComplaint());
    };
    await sweeper.suggestAfterSweep({ ...ctx }, [a, b, c]);

    expect(seen).toHaveLength(2);
    expect((await suggestionRows(ctx, a)).map((r) => r.status)).toEqual(['failed']);
    expect((await suggestionRows(ctx, b)).map((r) => r.status)).toEqual(['pending']);
    // Beyond the per-sweep cap: left for the officer to ask about.
    expect(await suggestionRows(ctx, c)).toHaveLength(0);
  });

  it('sweeps arriving while it reads join the one reader: never two readings at once', async () => {
    // The sweep does not wait for the assistant (sweep.ts), so a second sweep can hand over
    // mail while the first batch is still being read. One drain, one reading at a time.
    const sweeper = new AssistantService(mail, respondents, fakeTriage, config({ perSweep: 5 }));
    const a = await arrive(ctx, person(), 'First', 'one');
    const b = await arrive(ctx, person(), 'Second', 'two');
    const c = await arrive(ctx, person(), 'Third', 'three');

    let reading = 0;
    let most = 0;
    answer = async () => {
      reading++;
      most = Math.max(most, reading);
      await new Promise((r) => setTimeout(r, 15));
      reading--;
      return ok(notComplaint());
    };
    const first = sweeper.suggestAfterSweep(ctx, [a, b]);
    const second = sweeper.suggestAfterSweep(ctx, [c]);
    await Promise.all([first, second]);
    await sweeper.whenIdle();

    expect(most).toBe(1);
    expect(seen).toHaveLength(3);
    for (const id of [a, b, c]) {
      expect((await suggestionRows(ctx, id)).map((r) => r.status)).toEqual(['pending']);
    }
  });
});

// ─── The lookups ─────────────────────────────────────────────────────────────

describe('what the model may look up', () => {
  const tools = registerTools(ctx, respondents);

  it('finds a case by the sender, says how, and never hands back an email address or phone number', async () => {
    const live = await caseFrom(ctx);
    await asOfficer(ctx, (tx) =>
      tx.execute(sql`
        UPDATE party SET mobile = '98450 12345', mobile_normalised = '9845012345'
        WHERE council_id = ${councilId}::uuid AND email = ${live.who.email}
      `),
    );

    const byEmail = await tools.searchCases(live.who.email.toUpperCase());
    expect(byEmail.map((h) => h.caseNumber)).toEqual([live.caseNumber]);
    expect(byEmail[0]!.matchedOn).toContain('email address');
    expect(byEmail[0]!.complainantName).toBe(live.who.name);
    expect(byEmail[0]!.closed).toBe(false);

    const byPhone = await tools.searchCases('+91 98450 12345');
    expect(byPhone.map((h) => h.caseNumber)).toContain(live.caseNumber);
    expect(byPhone.find((h) => h.caseNumber === live.caseNumber)!.matchedOn).toContain('phone number');

    // Names in any order, and the honorific does not get in the way.
    const [first, second] = live.who.name.split(' ');
    const byName = await tools.searchCases(`Smt. ${second} ${first}`);
    expect(byName.map((h) => h.caseNumber)).toEqual([live.caseNumber]);
    expect(byName[0]!.matchedOn).toContain('complainant name');

    const byNumber = await tools.searchCases(live.caseNumber.toLowerCase());
    expect(byNumber[0]!.matchedOn).toContain('case number');

    for (const hits of [byEmail, byPhone, byName, byNumber]) {
      const text = JSON.stringify(hits);
      expect(text).not.toContain('@');
      expect(text).not.toContain('9845012345');
      expect(text).not.toContain('98450');
    }
  });

  it('never returns a case cancelled as opened in error, by search or by number', async () => {
    const gone = await caseFrom(ctx);
    await asOfficer(ctx, (tx) =>
      lifecycle.cancel(tx, ctx, { caseFileId: gone.caseFileId, reason: 'Duplicate of another case' }),
    );

    expect(await tools.searchCases(gone.who.email)).toEqual([]);
    expect(await tools.searchCases(gone.who.name)).toEqual([]);
    expect(await tools.searchCases(gone.caseNumber)).toEqual([]);
    expect(await tools.getCase(gone.caseNumber)).toBeNull();
    expect(await tools.getCase('ASST/COMP/2026-27/9999')).toBeNull();
  });

  it('shows a closed case, marked closed', async () => {
    const shut = await caseFrom(ctx);
    await asOfficer(ctx, (tx) =>
      tx.execute(sql`
        UPDATE case_file SET state = 'closed', closed_at = now(), closure_reason = 'withdrawn'
        WHERE id = ${shut.caseFileId}::uuid
      `),
    );
    const hits = await tools.searchCases(shut.who.email);
    expect(hits[0]!.closed).toBe(true);
    expect((await tools.getCase(shut.caseNumber))!.closedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('gives a case by number: parties by name, dentists, and letters by subject and date only', async () => {
    const live = await caseFrom(ctx);
    await asOfficer(ctx, (tx) =>
      respondents.add(tx, ctx, {
        caseFileId: live.caseFileId,
        fullName: `Dr Ramesh ${TAG}`,
        email: 'rbhat@clinic.example',
        mobile: '9876543210',
        clinicName: 'Smile Dental',
      }),
    );

    const detail = (await tools.getCase(live.caseNumber.toLowerCase()))!;
    expect(detail.caseNumber).toBe(live.caseNumber);
    expect(detail.complainantName).toBe(live.who.name);
    expect(detail.respondents).toEqual([
      { name: `Dr Ramesh ${TAG}`, registrationNo: null, clinicName: 'Smile Dental' },
    ]);
    const inbound = detail.recentLetters.filter((l) => l.direction === 'in');
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ subject: expect.stringMatching(/Crown/), date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    for (const l of detail.recentLetters) {
      expect(Object.keys(l).sort()).toEqual(['date', 'direction', 'subject']);
    }

    const text = JSON.stringify(detail);
    expect(text).not.toContain('@');
    expect(text).not.toContain('9876543210');
    expect(text).not.toMatch(/My crown came off/); // the letter's body
  });

  it('finds a dentist the register has met, with their history, and without their contacts', async () => {
    const live = await caseFrom(ctx);
    const named = await asOfficer(ctx, (tx) =>
      respondents.add(tx, ctx, {
        caseFileId: live.caseFileId,
        fullName: `Dr Suma ${TAG}`,
        email: 'suma@clinic.example',
        mobile: '9000011111',
      }),
    );
    const hits = await tools.searchDentists(`Suma ${TAG}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      partyId: named.partyId,
      name: `Dr Suma ${TAG}`,
      priorCases: 1,
      source: 'seen_before',
    });
    expect(JSON.stringify(hits)).not.toContain('@');
    expect(JSON.stringify(hits)).not.toContain('9000011111');

    // As the model writes names - honorific, punctuation, surname first - it is still found.
    // Passed through whole, "Dr. TAG Suma" found nobody, and accepting would have made a
    // second record for a dentist the register already holds.
    const reordered = await tools.searchDentists(`Dr. ${TAG} Suma`);
    expect(reordered.map((h) => h.partyId)).toEqual([named.partyId]);
    expect(await tools.searchDentists(`Dr. ${TAG} Somebody`)).toEqual([]);
  });

  it('finds a dentist in the register of dentists by a number written any way', async () => {
    const digits = String(Date.now()).slice(-7);
    await asOfficer(ctx, (tx) =>
      tx.execute(sql`
        INSERT INTO registered_dentist (council_id, registration_no, full_name)
        VALUES (${councilId}::uuid, ${`KA-${digits}`}, ${`Dr Listed ${TAG}`})
      `),
    );
    const hits = await tools.searchDentists(`ka ${digits}`);
    expect(hits).toEqual([
      expect.objectContaining({ name: `Dr Listed ${TAG}`, partyId: null, registrationNo: `KA-${digits}`, source: 'register' }),
    ]);
  });

  it('takes contact details out of summaries and letter subjects, which senders wrote', async () => {
    const who = person();
    const id = await arrive(ctx, who, 'Complaint - please call 9845012345 / ravi@example.in', 'Call me.');
    const opened = await asOfficer(ctx, (tx) => mail.openCase(tx, ctx, { mailMessageId: id }));
    const detail = (await tools.getCase(opened.caseNumber))!;
    const hits = await tools.searchCases(who.name);
    const text = JSON.stringify([detail, hits]);
    expect(text).not.toContain('9845012345');
    expect(text).not.toContain('ravi@example.in');
    expect(detail.summary).toContain('[number removed]');
    expect(detail.recentLetters.some((l) => l.subject.includes('[address removed]'))).toBe(true);
  });

  it('opens a case by a number written loosely', async () => {
    const live = await caseFrom(ctx);
    // ASST/COMP/2026-27/0012 as "asst-comp-2026-27-12".
    const loose = live.caseNumber.toLowerCase().replace(/\//g, '-').replace(/-0+(\d)/, '-$1');
    expect((await tools.getCase(loose))?.caseNumber).toBe(live.caseNumber);
  });
});

// ─── Accepting ───────────────────────────────────────────────────────────────

describe('accepting a suggestion', () => {
  it('new complaint: opens the case through the ordinary path and names known and new dentists', async () => {
    // A dentist the register already knows, from an earlier case.
    const earlier = await caseFrom(ctx);
    const known = await asOfficer(ctx, (tx) =>
      respondents.add(tx, ctx, { caseFileId: earlier.caseFileId, fullName: `Dr Known ${TAG}` }),
    );

    const who = person();
    const id = await arrive(ctx, who, 'Implant failed', 'The implant failed after a month.');
    answer = () =>
      ok(
        newComplaint({
          summary: 'Implant failed within a month',
          complainantName: who.name,
          complainantEmail: who.email,
          respondents: [
            {
              name: `Dr Known ${TAG}`,
              registrationNo: null,
              clinicName: null,
              isEstablishment: false,
              partyId: known.partyId,
              registeredDentistId: null,
            },
            {
              name: `Dr New ${TAG}`,
              registrationNo: null,
              clinicName: 'Bright Smile',
              isEstablishment: false,
              partyId: null,
              registeredDentistId: null,
            },
          ],
        }),
      );
    await assistant.suggestFor(ctx, id);

    const out = await asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id));
    expect(out.caseNumber).toMatch(/^ASST\/COMP\/\d{4}-\d{2}\/\d{4}$/);

    await asOfficer(ctx, async (tx) => {
      const c = await tx.execute<{ summary: string }>(sql`
        SELECT summary FROM case_file WHERE id = ${out.caseFileId!}::uuid
      `);
      expect(c.rows[0]!.summary).toBe('Implant failed within a month');

      const parties = await tx.execute<{ role: string; party_id: string; full_name: string; email: string | null }>(sql`
        SELECT cp.role::text AS role, cp.party_id, p.full_name, p.email
        FROM case_party cp JOIN party p ON p.id = cp.party_id
        WHERE cp.case_file_id = ${out.caseFileId!}::uuid
        ORDER BY cp.created_at, p.full_name
      `);
      const complainant = parties.rows.find((p) => p.role === 'complainant')!;
      expect(complainant.full_name).toBe(who.name);
      expect(complainant.email).toBe(who.email);

      const dentists = parties.rows.filter((p) => p.role === 'respondent_dentist');
      expect(dentists.map((d) => d.full_name).sort()).toEqual([`Dr Known ${TAG}`, `Dr New ${TAG}`].sort());
      // The known dentist is the SAME person - which is what gives the committee the history.
      expect(dentists.find((d) => d.full_name === `Dr Known ${TAG}`)!.party_id).toBe(known.partyId);

      const r = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int n FROM case_respondent WHERE case_file_id = ${out.caseFileId!}::uuid
      `);
      expect(r.rows[0]!.n).toBe(2);
    });

    expect(await messageRow(ctx, id)).toMatchObject({ status: 'filed', case_file_id: out.caseFileId });

    // Recorded once, as accepted - not ALSO as handled by the openCase it called.
    const rows = await suggestionRows(ctx, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'accepted',
      outcome_action: 'opened_case',
      outcome_agreed: true,
      outcome_case_file_id: out.caseFileId,
      acted_by: officer,
    });

    const view = (await asOfficer(ctx, (tx) => assistant.latestFor(tx, ctx, [id]))).get(id)!;
    expect(view.outcome).toMatchObject({
      action: 'opened_case',
      caseFileId: out.caseFileId,
      caseNumber: out.caseNumber,
      agreed: true,
    });
  });

  it('new complaint, changed before accepting: edited, and still agreed', async () => {
    const who = person();
    const id = await arrive(ctx, who, 'Braces hurt', 'My braces hurt.');
    answer = () =>
      ok(newComplaint({ summary: 'Braces', complainantName: who.name, complainantEmail: who.email, respondents: [] }));
    await assistant.suggestFor(ctx, id);

    const out = await asOfficer(ctx, (tx) =>
      assistant.accept(tx, ctx, id, { summary: 'Pain from orthodontic braces' }),
    );
    const rows = await suggestionRows(ctx, id);
    expect(rows[0]).toMatchObject({ status: 'edited', outcome_agreed: true, outcome_case_file_id: out.caseFileId });

    // Overrides that repeat the suggestion are not changes.
    const id2 = await arrive(ctx, who, 'Braces hurt again', 'Still hurting.');
    await assistant.suggestFor(ctx, id2);
    await asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id2, { summary: 'Braces', complainantName: who.name }));
    expect((await suggestionRows(ctx, id2))[0]!.status).toBe('accepted');
  });

  it('follow-up: files the message on the case, resolving the number live', async () => {
    const existing = await caseFrom(ctx);
    const id = await arrive(ctx, existing.who, 'More bills', 'Attaching the bills you asked for.');
    // Written lower-case by the model; stored and matched as the register writes it.
    answer = () => ok(followUp(existing.caseNumber.toLowerCase()));
    const view = await assistant.suggestFor(ctx, id);
    expect(view.followUp).toMatchObject({
      caseFileId: existing.caseFileId,
      caseNumber: existing.caseNumber,
      closed: false,
    });

    const out = await asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id));
    expect(out).toMatchObject({ caseFileId: existing.caseFileId, caseNumber: existing.caseNumber });
    expect(await messageRow(ctx, id)).toMatchObject({ status: 'filed', case_file_id: existing.caseFileId });
    expect((await suggestionRows(ctx, id))[0]).toMatchObject({
      status: 'accepted',
      outcome_action: 'filed_on_case',
      outcome_agreed: true,
      outcome_case_file_id: existing.caseFileId,
    });
  });

  it('follow-up filed on a DIFFERENT case: edited, and counted as a disagreement', async () => {
    const suggested = await caseFrom(ctx);
    const actual = await caseFrom(ctx);
    const id = await arrive(ctx, suggested.who, 'About my case', 'Any update?');
    answer = () => ok(followUp(suggested.caseNumber));
    await assistant.suggestFor(ctx, id);

    await asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id, { caseFileId: actual.caseFileId }));
    expect((await suggestionRows(ctx, id))[0]).toMatchObject({
      status: 'edited',
      outcome_agreed: false,
      outcome_case_file_id: actual.caseFileId,
    });
  });

  it('follow-up on a case cancelled since: not offered, and refused without a case chosen', async () => {
    const gone = await caseFrom(ctx);
    const id = await arrive(ctx, gone.who, 'Follow up', 'Any news?');
    answer = () => ok(followUp(gone.caseNumber));
    await assistant.suggestFor(ctx, id);
    await asOfficer(ctx, (tx) =>
      lifecycle.cancel(tx, ctx, { caseFileId: gone.caseFileId, reason: 'Opened twice by mistake' }),
    );

    const view = (await asOfficer(ctx, (tx) => assistant.latestFor(tx, ctx, [id]))).get(id)!;
    expect(view.followUp).toMatchObject({ caseNumber: gone.caseNumber, caseFileId: null });
    await expect(asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id))).rejects.toMatchObject({ status: 409 });
    expect((await suggestionRows(ctx, id))[0]!.status).toBe('pending');
  });

  it('follow-up on a closed case: offered, but marked closed, so the screens can confirm first', async () => {
    const shut = await caseFrom(ctx);
    await asOfficer(ctx, (tx) =>
      tx.execute(sql`
        UPDATE case_file SET state = 'closed', closed_at = now(), closure_reason = 'withdrawn'
        WHERE id = ${shut.caseFileId}::uuid
      `),
    );
    const id = await arrive(ctx, shut.who, 'Settlement never paid', 'The amount agreed was never paid.');
    answer = () => ok(followUp(shut.caseNumber));
    const view = await assistant.suggestFor(ctx, id);
    expect(view.followUp).toMatchObject({ caseFileId: shut.caseFileId, closed: true });
  });

  it('new complaint, a dentist matched in the register of dentists: linked by the register\'s own number', async () => {
    // The email wrote the number its own way; the link is the register entry the lookup
    // matched, not that spelling.
    const regNo = `KB-${String(Date.now()).slice(-6)}1`;
    const rd = await asOfficer(ctx, (tx) =>
      tx.execute<{ id: string }>(sql`
        INSERT INTO registered_dentist (council_id, registration_no, full_name)
        VALUES (${councilId}::uuid, ${regNo}, ${`Dr Regd ${TAG}`}) RETURNING id
      `),
    );
    const rdId = rd.rows[0]!.id;
    const who = person();
    const id = await arrive(ctx, who, 'Bridge failed', 'My bridge failed.');
    answer = () =>
      ok(
        newComplaint({
          summary: 'Bridge failed',
          complainantName: who.name,
          complainantEmail: who.email,
          respondents: [
            {
              name: `Dr Regd ${TAG}`,
              registrationNo: regNo.replace('-', ' '),
              clinicName: null,
              isEstablishment: false,
              partyId: null,
              registeredDentistId: rdId,
            },
          ],
        }),
      );
    await assistant.suggestFor(ctx, id);
    const out = await asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id));
    const linked = await asOfficer(ctx, (tx) =>
      tx.execute<{ registered_dentist_id: string | null }>(sql`
        SELECT p.registered_dentist_id FROM case_party cp JOIN party p ON p.id = cp.party_id
        WHERE cp.case_file_id = ${out.caseFileId!}::uuid AND cp.role = 'respondent_dentist'
      `),
    );
    expect(linked.rows.map((r) => r.registered_dentist_id)).toEqual([rdId]);
  });

  it('new complaint, a number that belongs to somebody else in the register: refused, naming both', async () => {
    // Accepting names a new person with the number, and that joins them to whoever holds it.
    const regNo = `KC-${String(Date.now()).slice(-6)}2`;
    await asOfficer(ctx, (tx) =>
      tx.execute(sql`
        INSERT INTO registered_dentist (council_id, registration_no, full_name)
        VALUES (${councilId}::uuid, ${regNo}, ${`Dr Holder ${TAG}`})
      `),
    );
    const who = person();
    const id = await arrive(ctx, who, 'Crown cracked', 'It cracked.');
    answer = () =>
      ok(
        newComplaint({
          summary: 'Crown cracked',
          complainantName: who.name,
          complainantEmail: who.email,
          respondents: [
            {
              name: 'Dr Ravi Kumar',
              registrationNo: regNo,
              clinicName: null,
              isEstablishment: false,
              partyId: null,
              registeredDentistId: null,
            },
          ],
        }),
      );
    await assistant.suggestFor(ctx, id);
    await expect(asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id))).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(new RegExp(`belongs to Dr Holder ${TAG}.*not to Dr Ravi Kumar`)),
    });
    expect((await messageRow(ctx, id)).status).toBe('unfiled');
    expect((await suggestionRows(ctx, id))[0]!.status).toBe('pending');
  });

  it('not a complaint: sets it aside with the reason, saying it was the assistant’s suggestion', async () => {
    const id = await arrive(ctx, person(), 'Conference invitation', 'You are invited.');
    answer = () => ok(notComplaint('An invitation to a conference.'));
    await assistant.suggestFor(ctx, id);

    expect(await asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id))).toEqual({});
    expect(await messageRow(ctx, id)).toMatchObject({
      status: 'dismissed',
      dismissed_reason: `${SET_ASIDE_PREFIX}An invitation to a conference.`,
    });
    expect((await suggestionRows(ctx, id))[0]).toMatchObject({
      status: 'accepted',
      outcome_action: 'set_aside',
      outcome_agreed: true,
    });

    // With the reason changed: edited, and the officer's reason is the one recorded.
    const id2 = await arrive(ctx, person(), 'Another invitation', 'Please come.');
    await assistant.suggestFor(ctx, id2);
    await asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id2, { reason: 'Advertising.' }));
    expect((await messageRow(ctx, id2)).dismissed_reason).toBe(`${SET_ASIDE_PREFIX}Advertising.`);
    expect((await suggestionRows(ctx, id2))[0]).toMatchObject({
      status: 'edited',
      outcome_agreed: true,
      outcome_note: 'Advertising.',
    });
  });

  it('unsure: there is nothing to accept', async () => {
    const id = await arrive(ctx, person(), 'Hello', 'Hello.');
    answer = () => ok(unsure());
    await assistant.suggestFor(ctx, id);
    await expect(asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id))).rejects.toMatchObject({ status: 409 });
    expect((await messageRow(ctx, id)).status).toBe('unfiled');
  });

  it('a failure part-way leaves nothing behind: no case, no number spent, no outcome', async () => {
    const id = await arrive(ctx, person(), 'Half done', 'Half.');
    answer = () =>
      ok(newComplaint({ summary: 'Half done', complainantName: 'Somebody', complainantEmail: null, respondents: [] }));
    await assistant.suggestFor(ctx, id);
    // Cases, and the serials issued so far: a number taken and then dropped would be a gap
    // in a legal register.
    const count = () =>
      asOfficer(ctx, (tx) =>
        tx.execute<{ n: string }>(sql`
          SELECT (SELECT count(*) FROM case_file WHERE council_id = ${councilId}::uuid)::text || '/' ||
                 (SELECT coalesce(sum(next_value), 0) FROM number_sequence
                   WHERE council_id = ${councilId}::uuid)::text AS n
        `),
      ).then((r) => r.rows[0]!.n);
    const before = await count();

    // The case opens, then naming the dentist fails: a person the register does not hold.
    await expect(
      asOfficer(ctx, (tx) =>
        assistant.accept(tx, ctx, id, {
          respondents: [
            {
              name: 'Dr Nobody',
              registrationNo: null,
              clinicName: null,
              isEstablishment: false,
              partyId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
              registeredDentistId: null,
            },
          ],
        }),
      ),
    ).rejects.toThrow(/not in the register/);

    expect(await count()).toBe(before);
    expect((await messageRow(ctx, id)).status).toBe('unfiled');
    expect((await suggestionRows(ctx, id))[0]!.status).toBe('pending');
  });
});

// ─── Rejecting, and the ordinary buttons ─────────────────────────────────────

describe('rejecting a suggestion', () => {
  it('records the rejection and the note, and leaves the message in the tray', async () => {
    const id = await arrive(ctx, person(), 'Denture broke', 'My denture broke.');
    await assistant.suggestFor(ctx, id);

    expect(await asOfficer(ctx, (tx) => assistant.reject(tx, ctx, id, 'It is a complaint.'))).toEqual({ ok: true });
    expect((await suggestionRows(ctx, id))[0]).toMatchObject({
      status: 'rejected',
      outcome_action: 'rejected',
      outcome_agreed: null,
      outcome_note: 'It is a complaint.',
      acted_by: officer,
    });
    expect((await messageRow(ctx, id)).status).toBe('unfiled');

    // Nothing pending any more, so nothing to accept or reject again.
    await expect(asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id))).rejects.toMatchObject({ status: 409 });
    await expect(asOfficer(ctx, (tx) => assistant.reject(tx, ctx, id))).rejects.toMatchObject({ status: 409 });

    // And the officer then dealing with it by hand does not rewrite the rejection.
    await asOfficer(ctx, (tx) => mail.openCase(tx, ctx, { mailMessageId: id }));
    expect((await suggestionRows(ctx, id))[0]!.status).toBe('rejected');
  });
});

describe('the officer using the ordinary buttons instead', () => {
  it('a suggested new complaint, set aside by hand: handled, and a disagreement', async () => {
    const id = await arrive(ctx, person(), 'Spam?', 'Buy now.');
    answer = () =>
      ok(newComplaint({ summary: 'Something', complainantName: 'X', complainantEmail: null, respondents: [] }));
    await assistant.suggestFor(ctx, id);

    await asOfficer(ctx, (tx) => mail.dismiss(tx, ctx, { mailMessageId: id, reason: 'Advertising, not a complaint.' }));
    expect((await suggestionRows(ctx, id))[0]).toMatchObject({
      status: 'handled',
      outcome_action: 'set_aside',
      outcome_agreed: false,
      outcome_note: 'Advertising, not a complaint.',
      acted_by: officer,
    });
  });

  it('a suggested follow-up, filed by hand on the same case: agreed; on another: not', async () => {
    const target = await caseFrom(ctx);
    const other = await caseFrom(ctx);

    const same = await arrive(ctx, target.who, 'Re: my case', 'Update.');
    answer = () => ok(followUp(target.caseNumber));
    await assistant.suggestFor(ctx, same);
    await asOfficer(ctx, (tx) => mail.fileOnCase(tx, ctx, { mailMessageId: same, caseFileId: target.caseFileId }));
    expect((await suggestionRows(ctx, same))[0]).toMatchObject({
      status: 'handled',
      outcome_action: 'filed_on_case',
      outcome_agreed: true,
      outcome_case_file_id: target.caseFileId,
    });

    const elsewhere = await arrive(ctx, target.who, 'Re: my case again', 'Update.');
    await assistant.suggestFor(ctx, elsewhere);
    await asOfficer(ctx, (tx) => mail.fileOnCase(tx, ctx, { mailMessageId: elsewhere, caseFileId: other.caseFileId }));
    expect((await suggestionRows(ctx, elsewhere))[0]).toMatchObject({
      status: 'handled',
      outcome_agreed: false,
      outcome_case_file_id: other.caseFileId,
    });
  });

  it('a suggested set-aside, opened as a case by hand: a disagreement, with the case recorded', async () => {
    const id = await arrive(ctx, person(), 'Actually a complaint', 'I was hurt.');
    answer = () => ok(notComplaint());
    await assistant.suggestFor(ctx, id);
    const opened = await asOfficer(ctx, (tx) => mail.openCase(tx, ctx, { mailMessageId: id }));
    expect((await suggestionRows(ctx, id))[0]).toMatchObject({
      status: 'handled',
      outcome_action: 'opened_case',
      outcome_agreed: false,
      outcome_case_file_id: opened.caseFileId,
    });
  });

  it('unsure, then anything at all: handled, agreeing with nothing and disagreeing with nothing', async () => {
    const id = await arrive(ctx, person(), 'Unclear', 'Hmm.');
    answer = () => ok(unsure());
    await assistant.suggestFor(ctx, id);
    await asOfficer(ctx, (tx) => mail.dismiss(tx, ctx, { mailMessageId: id, reason: 'Nothing to act on.' }));
    expect((await suggestionRows(ctx, id))[0]).toMatchObject({
      status: 'handled',
      outcome_action: 'set_aside',
      outcome_agreed: null,
    });
  });

  it('a message with no suggestion is simply dealt with', async () => {
    const id = await arrive(ctx, person(), 'No suggestion', 'Plain.');
    await asOfficer(ctx, (tx) => mail.dismiss(tx, ctx, { mailMessageId: id, reason: 'Not a complaint.' }));
    expect(await suggestionRows(ctx, id)).toHaveLength(0);
  });
});

// ─── The report ──────────────────────────────────────────────────────────────

describe('the monthly report', () => {
  it('counts every status, the honest agreement figure and the cost', async () => {
    const c = reportCtx;
    const month = todayIn('Asia/Kolkata').slice(0, 7);

    // 1. Accepted as it was: agreed.
    const m1 = await arrive(c, person(), 'Circular one', 'A circular.');
    answer = () => ok(notComplaint());
    await assistant.suggestFor(c, m1);
    await asOfficer(c, (tx) => assistant.accept(tx, c, m1));

    // 2. Suggested a complaint; the officer set it aside by hand: disagreed.
    const m2 = await arrive(c, person(), 'Report subject two', 'Text.');
    answer = () =>
      ok(newComplaint({ summary: 'S', complainantName: 'N', complainantEmail: null, respondents: [] }));
    await assistant.suggestFor(c, m2);
    await asOfficer(c, (tx) => mail.dismiss(tx, c, { mailMessageId: m2, reason: 'Not a complaint at all.' }));

    // 3. Suggested a follow-up; the officer rejected it: disagreed, by rejection.
    const m3 = await arrive(c, person(), 'Report subject three', 'Text.');
    answer = () => ok(followUp('ASRP/COMP/2026-27/0099'));
    await assistant.suggestFor(c, m3);
    await asOfficer(c, (tx) => assistant.reject(tx, c, m3, 'Wrong case.'));

    // 4. Unsure; the officer opened a case: neither.
    const m4 = await arrive(c, person(), 'Report subject four', 'Text.');
    answer = () => ok(unsure());
    await assistant.suggestFor(c, m4);
    await asOfficer(c, (tx) => mail.openCase(tx, c, { mailMessageId: m4 }));

    // 5. Failed, at a cost.
    const m5 = await arrive(c, person(), 'Report subject five', 'Text.');
    answer = () => ({
      ok: false,
      error: 'Timed out.',
      model: 'fake-model',
      usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.002,
      toolCalls: 0,
    });
    await assistant.suggestFor(c, m5);

    // 6. Asked twice: one superseded, one pending.
    const m6 = await arrive(c, person(), 'Report subject six', 'Text.');
    answer = () => ok(notComplaint());
    await assistant.suggestFor(c, m6);
    await assistant.suggestFor(c, m6);

    const report = await asOfficer(c, (tx) => assistant.report(tx, c, month));
    expect(report).toMatchObject({ enabled: true, reason: null, model: 'fake-model', month });
    expect(report.totals).toEqual({
      pending: 1,
      accepted: 1,
      edited: 0,
      rejected: 1,
      handled: 2,
      superseded: 1,
      failed: 1,
    });
    expect(report.agreement.byDecision).toEqual({
      new_complaint: { agreed: 0, disagreed: 1 },
      follow_up: { agreed: 0, disagreed: 1 },
      not_a_complaint: { agreed: 1, disagreed: 0 },
      unsure: { agreed: 0, disagreed: 0 },
    });
    expect(report.agreement.overall).toEqual({ agreed: 1, disagreed: 2 });
    // Six calls at a cent and one failure at a fifth of one - failures and superseded
    // suggestions included, because they were paid for.
    expect(report.costUsd).toBeCloseTo(0.062, 6);

    expect(report.recentDisagreements.map((d) => d.mailMessageId).sort()).toEqual([m2, m3].sort());
    const rejected = report.recentDisagreements.find((d) => d.mailMessageId === m3)!;
    expect(rejected).toMatchObject({
      subject: 'Report subject three',
      decision: 'follow_up',
      outcomeAction: 'rejected',
      note: 'Wrong case.',
    });

    // Another month is empty, not an error.
    const empty = await asOfficer(c, (tx) => assistant.report(tx, c, '2020-01'));
    expect(empty.totals.pending).toBe(0);
    expect(empty.costUsd).toBe(0);

    // Off, the report says which switch: the page can only tell whoever runs the app what
    // to fix if the reason reaches it.
    const off = await asOfficer(c, (tx) => assistant.report(tx, { ...c, config: KSDC_CONFIG }, month));
    expect(off).toMatchObject({ enabled: false, reason: expect.stringMatching(/aiEnabled/) });
    await expect(asOfficer(c, (tx) => assistant.report(tx, c, '2026-13'))).rejects.toMatchObject({ status: 400 });
  });
});
