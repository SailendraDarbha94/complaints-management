import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import { PDFDocument } from 'pdf-lib';
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
import { AssistantService, FILED_AS_COPY_NOTE, SET_ASIDE_PREFIX, STILL_READING } from './assistant.service.js';
import { OWN_MAILBOX_MARK } from '../mail/council-copy.js';
import { assistantConfigFromEnv, playbookVersionOf, type AssistantConfig } from './config.js';
import { registerTools } from './register-tools.js';
import type {
  AttachmentReadRecord,
  AttachmentReadResult,
  RunTriage,
  TriageEmail,
  TriageOptions,
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
let seenOpts: TriageOptions[] = [];
const fakeTriage: RunTriage = async (email, tools, opts) => {
  seen.push(email);
  seenOpts.push(opts);
  return answer(email, tools);
};

function ok(proposal: TriageProposal, costUsd = 0.01, attachmentsRead: AttachmentReadRecord[] = []): TriageResult {
  return {
    ok: true,
    proposal,
    model: 'fake-model',
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, cacheWriteTokens: 0 },
    costUsd,
    toolCalls: 2,
    attachmentsRead,
  };
}
const notComplaint = (reason = 'A circular from another body, not a complaint.'): TriageProposal => ({
  decision: 'not_a_complaint',
  confidence: 'high',
  reasoning: 'It is a circular addressed to every council.',
  notComplaint: { reason },
  followUp: null,
  newComplaint: null,
  councilCopy: null,
});
const followUp = (caseNumber: string): TriageProposal => ({
  decision: 'follow_up',
  confidence: 'high',
  reasoning: 'The same complainant writing about the same crown.',
  notComplaint: null,
  followUp: { caseNumber, because: 'Same complainant, same treatment.' },
  newComplaint: null,
  councilCopy: null,
});
const newComplaint = (nc: NonNullable<TriageProposal['newComplaint']>): TriageProposal => ({
  decision: 'new_complaint',
  confidence: 'medium',
  reasoning: 'A patient describing treatment that went wrong.',
  notComplaint: null,
  followUp: null,
  newComplaint: nc,
  councilCopy: null,
});
const unsure = (): TriageProposal => ({
  decision: 'unsure',
  confidence: 'low',
  reasoning: 'Too little in the message to tell.',
  notComplaint: null,
  followUp: null,
  newComplaint: null,
  councilCopy: null,
});
const councilCopy = (caseNumber: string): TriageProposal => ({
  decision: 'council_letter_copy',
  confidence: 'high',
  reasoning: "A copy of the Council's documents letter, sent to the complainant on that case.",
  notComplaint: null,
  followUp: null,
  newComplaint: null,
  councilCopy: { caseNumber, letter: 'documents request', because: 'Quotes the case; sent to its complainant.' },
});

function config(over: Partial<AssistantConfig> = {}): AssistantConfig {
  return {
    enabled: true,
    reason: null,
    automatic: true,
    model: 'fake-model',
    effort: 'medium',
    dailyLimit: 10_000,
    perSweep: 5,
    maxToolCalls: 8,
    // Off, as it ships: the file reader's own tests below switch it on.
    readAttachments: false,
    maxAttachmentReads: 3,
    maxPdfPages: 10,
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
assistant = new AssistantService(mail, respondents, storage, fakeTriage, config());

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
  // The mailbox named with its account, as the reader names it: that is how the register
  // knows intake@asst.test is the Council's own address. Without it, the Registrar writing
  // to intake@asst.test would look like the Council writing to an outsider - a copy of a
  // Council letter (council-copy.ts) - rather than the office forwarding a complaint.
  const out = await asOfficer(c, (tx) =>
    mail.ingest(tx, c, parsed, {
      mailbox: 'intake@asst.test/INBOX',
      uid: 1000 + seq,
      uidValidity: '1',
      raw: bytes,
    }),
  );
  expect(out.status).toBe('unfiled');
  return out.mailMessageId;
}

/**
 * A letter the Council sent from its own address to somebody outside it, with the intake
 * mailbox in Cc - a copy of a Council letter, as the register recognises one.
 */
async function arriveCopy(
  c: EngineContext,
  to: { name: string; email: string },
  subject: string,
  body = 'Sir/Madam, please send the bills and a timeline of your treatment.',
): Promise<string> {
  seq++;
  const council = c.councilId === councilId ? 'asst' : 'asrp';
  const bytes = Buffer.from(
    [
      `From: Test Registrar <registrar@${council}.test>`,
      `To: ${to.name} <${to.email}>`,
      `Cc: intake@${council}.test`,
      `Subject: ${subject}`,
      `Message-ID: <asst-copy-${TAG}-${seq}@mail.test>`,
      'Date: Wed, 7 Oct 2026 10:14:00 +0530',
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
  expect(out).toMatchObject({ status: 'unfiled', councilCopy: true });
  return out.mailMessageId;
}

/** The documents letter, drafted on the case and confirmed sent - "I have sent this". */
async function sendDocumentsLetter(c: EngineContext, caseFileId: string): Promise<string> {
  return asOfficer(c, async (tx) => {
    const draft = await correspondence.draft(tx, c, { caseFileId, kind: 'request_docs' });
    await correspondence.markSent(tx, c, {
      correspondenceId: draft.correspondenceId,
      sentAt: new Date(Date.now() - 24 * 3600_000),
    });
    return draft.correspondenceId;
  });
}

/** What a case holds: its letters each way, and whether it is waiting for documents. */
async function caseState(c: EngineContext, caseFileId: string) {
  return asOfficer(c, async (tx) => {
    const rows = await tx.execute<{ inbound: number; outbound: number }>(sql`
      SELECT count(*) FILTER (WHERE direction = 'in')::int AS inbound,
             count(*) FILTER (WHERE direction = 'out')::int AS outbound
      FROM correspondence WHERE council_id = ${c.councilId}::uuid AND case_file_id = ${caseFileId}::uuid
    `);
    const waiting = (await followups.liveForCase(tx, c, caseFileId)).some((f) => f.stage === 'await_patient_docs');
    return { ...rows.rows[0]!, waitingForDocuments: waiting };
  });
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
      attachments_read: AttachmentReadRecord[];
    }>(sql`
      SELECT status::text, decision::text, outcome_action, outcome_agreed, outcome_case_file_id,
             outcome_note, acted_by, created_by, cost_usd, input_tokens, playbook_version, error,
             proposal, attachments_read
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
    // The Council's letter templates, which a copy of one of its letters is recognised by.
    await withCouncil({ councilId: cid, userId: oid }, (tx) =>
      correspondence.seedTemplates(tx, { councilId: cid, userId: oid, config: AI_ON }),
    );
  }
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  seen = [];
  seenOpts = [];
  answer = () => ok(notComplaint());
});

// ─── Switching it on ─────────────────────────────────────────────────────────

describe('whether the assistant is on', () => {
  // Never a real key: these only check that one is present.
  const KEY = { ANTHROPIC_API_KEY: 'placeholder-not-a-real-key' };

  it('is off by default, and says why', () => {
    const c = assistantConfigFromEnv({});
    expect(c.enabled).toBe(false);
    expect(c.reason).toBe('MAIL_ASSISTANT is not set to on or ask.');
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

  it('has an "ask" mode: on, but reading only what the officer asks about', () => {
    const ask = assistantConfigFromEnv({ ...KEY, MAIL_ASSISTANT: 'ask' });
    expect(ask).toMatchObject({ enabled: true, reason: null, automatic: false });
    expect(assistantConfigFromEnv({ ...KEY, MAIL_ASSISTANT: 'on' }).automatic).toBe(true);
    // Off is off, whichever way it is spelled wrongly.
    expect(assistantConfigFromEnv({ ...KEY, MAIL_ASSISTANT: 'asked' })).toMatchObject({ enabled: false, automatic: false });
    expect(assistantConfigFromEnv({ MAIL_ASSISTANT: 'ask' }).reason).toBe('ANTHROPIC_API_KEY is missing.');
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

  it('reads attachments only when that is switched on too, within two limits of its own', () => {
    // Off by default, even with the assistant on: a file read is a file sent to Anthropic.
    const plain = assistantConfigFromEnv({ ...KEY, MAIL_ASSISTANT: 'on' });
    expect(plain).toMatchObject({ enabled: true, readAttachments: false, maxAttachmentReads: 3, maxPdfPages: 10 });
    expect(assistantConfigFromEnv({})).toMatchObject({ readAttachments: false, maxAttachmentReads: 3, maxPdfPages: 10 });

    const reading = assistantConfigFromEnv({
      ...KEY,
      MAIL_ASSISTANT: 'on',
      MAIL_ASSISTANT_ATTACHMENTS: 'on',
      MAIL_ASSISTANT_MAX_ATTACHMENT_READS: '5',
      MAIL_ASSISTANT_MAX_PDF_PAGES: '20',
    });
    expect(reading).toMatchObject({ enabled: true, readAttachments: true, maxAttachmentReads: 5, maxPdfPages: 20 });

    // Spelled one way. Anything else leaves the reader off - and the assistant on, because
    // the email-only assistant is the one the Council agreed to.
    for (const v of ['true', '1', 'yes', 'ON ', 'off']) {
      expect(assistantConfigFromEnv({ ...KEY, MAIL_ASSISTANT: 'on', MAIL_ASSISTANT_ATTACHMENTS: v })).toMatchObject({
        enabled: true,
        readAttachments: false,
      });
    }

    // A limit that cannot be read, or of nothing, is a misconfiguration: off, by name.
    const noFiles = assistantConfigFromEnv({ ...KEY, MAIL_ASSISTANT: 'on', MAIL_ASSISTANT_MAX_ATTACHMENT_READS: '0' });
    expect(noFiles.enabled).toBe(false);
    expect(noFiles.reason).toMatch(/MAIL_ASSISTANT_MAX_ATTACHMENT_READS must be a whole number from 1 to 10/);
    // And a ceiling: a slipped extra zero must not send a hundred files of one email.
    const tooMany = assistantConfigFromEnv({ ...KEY, MAIL_ASSISTANT: 'on', MAIL_ASSISTANT_MAX_ATTACHMENT_READS: '50' });
    expect(tooMany.enabled).toBe(false);
    expect(tooMany.reason).toMatch(/MAIL_ASSISTANT_MAX_ATTACHMENT_READS must be a whole number from 1 to 10/);
    expect(assistantConfigFromEnv({ ...KEY, MAIL_ASSISTANT: 'on', MAIL_ASSISTANT_MAX_ATTACHMENT_READS: '10' })).toMatchObject({
      enabled: true,
      maxAttachmentReads: 10,
    });
    const pages = assistantConfigFromEnv({ ...KEY, MAIL_ASSISTANT: 'on', MAIL_ASSISTANT_MAX_PDF_PAGES: 'ten' });
    expect(pages.enabled).toBe(false);
    expect(pages.reason).toMatch(/MAIL_ASSISTANT_MAX_PDF_PAGES/);
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
      ['attachments', 'body', 'dateText', 'forwardedBy', 'fromAddress', 'fromName', 'subject', 'to'].sort(),
    );
  });

  it('asks nothing at all when switched off, and says why', async () => {
    const off = new AssistantService(
      mail,
      respondents,
      storage,
      fakeTriage,
      config({ enabled: false, automatic: false, reason: 'MAIL_ASSISTANT is not set to on or ask.' }),
    );
    const id = await arrive(ctx, person(), 'Bleeding gums', 'My gums bleed.');

    await expect(off.suggestFor(ctx, id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/switched off.*MAIL_ASSISTANT is not set to on or ask/),
    });
    await off.suggestAfterSweep(ctx, [id]);

    expect(seen).toHaveLength(0);
    expect(await suggestionRows(ctx, id)).toHaveLength(0);
    expect(off.status()).toEqual({
      enabled: false,
      reason: 'MAIL_ASSISTANT is not set to on or ask.',
      automatic: false,
      readsAttachments: false,
    });
  });

  it('in "ask" mode reads nothing by itself, but answers when the officer asks', async () => {
    // For trying the assistant on mail the officer chose - their own made-up complaints -
    // before the Council has agreed that real complainants' mail may go to the model.
    const askOnly = new AssistantService(mail, respondents, storage, fakeTriage, config({ automatic: false }));
    const id = await arrive(ctx, person(), 'Loose crown', 'My crown came off twice.');

    await askOnly.suggestAfterSweep(ctx, [id]);
    expect(seen).toHaveLength(0);
    expect(await suggestionRows(ctx, id)).toHaveLength(0);

    const asked = await askOnly.suggestFor(ctx, id);
    expect(seen).toHaveLength(1);
    expect(asked.status).toBe('pending');
    expect(askOnly.status(ctx)).toEqual({ enabled: true, reason: null, automatic: false, readsAttachments: false });
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
      storage,
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
      attachmentsRead: [],
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
    expect(assistant.status(ctx)).toEqual({ enabled: true, reason: null, automatic: true, readsAttachments: false });
    // Both switches off: both reasons, so one restart fixes both.
    const bothOff = new AssistantService(mail, respondents, storage, fakeTriage, config({ enabled: false, automatic: false, reason: 'ANTHROPIC_API_KEY is missing.' }));
    expect(bothOff.status(councilOff).reason).toMatch(/ANTHROPIC_API_KEY is missing\..*aiEnabled/);
  });

  it('counts a reading against the limit from the moment it starts, not when it answers', async () => {
    // Written only afterwards, a reading cut off part-way would be paid for and never
    // counted - and "ask again" could then spend without limit.
    const limited = new AssistantService(
      mail,
      respondents,
      storage,
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
      attachmentsRead: [],
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

  it("shows the original's To line - in a forward, where the complaint was sent, not where it was forwarded", async () => {
    const id = await arrive(ctx, person(), 'Crown fell out', 'The crown fell out.');
    await assistant.suggestFor(ctx, id);
    expect(seen.at(-1)!.to).toMatch(/registrar@asst\.test/);
    expect(seen.at(-1)!.to).not.toMatch(/intake@asst\.test/);
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
    const sweeper = new AssistantService(mail, respondents, storage, fakeTriage, config({ perSweep: 2 }));
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
    const sweeper = new AssistantService(mail, respondents, storage, fakeTriage, config({ perSweep: 5 }));
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

// ─── Reading attachments ─────────────────────────────────────────────────────

describe('reading an attachment', () => {
  // The bytes are real - a PNG, a PDF made here, a Word file - and go through the real
  // ingest, the real store and the real attachment-prep. Only the model is fake: each test
  // has it ask for files the way the engine would.

  /** A one-pixel PNG: as far as the reader is concerned, a phone photo of a bill. */
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  /** A second, different image. Trailing bytes after IEND leave it a PNG. */
  const PNG2 = Buffer.concat([PNG, Buffer.from('second photo', 'latin1')]);
  /** A Word file is a zip, which the register refuses at ingest: it sniffs as nothing it keeps. */
  const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 1)]);
  const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  async function pdfOf(pages: number): Promise<Buffer> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
    return Buffer.from(await doc.save());
  }

  type File = { filename: string; type: string; bytes: Buffer };

  /** A complainant's own email with files attached, as a mail server hands it over. */
  async function arriveWithFiles(c: EngineContext, subject: string, files: File[]): Promise<string> {
    seq++;
    const who = person();
    const bytes = Buffer.from(
      [
        `From: ${who.name} <${who.email}>`,
        'To: intake@asst.test',
        `Subject: ${subject}`,
        `Message-ID: <asst-files-${TAG}-${seq}@mail.test>`,
        'Date: Wed, 17 Sep 2026 10:14:00 +0530',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="part"',
        '',
        '--part',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Please see the attached.',
        ...files.flatMap((f) => [
          '--part',
          `Content-Type: ${f.type}`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${f.filename}"`,
          '',
          f.bytes.toString('base64'),
        ]),
        '--part--',
        '',
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

  /** What the engine would report for a file it sent. */
  function record(email: TriageEmail, ref: string, r: AttachmentReadResult): AttachmentReadRecord {
    return {
      ref,
      filename: email.attachments.find((a) => a.ref === ref)!.filename,
      pagesSent: r.ok ? r.pagesSent : null,
      pagesTotal: r.ok ? r.pagesTotal : null,
    };
  }

  const refOf = (email: TriageEmail, filename: string) => email.attachments.find((a) => a.filename === filename)!.ref;

  // On, as MAIL_ASSISTANT_ATTACHMENTS=on would make it, with PDFs cut at two pages.
  const reader = new AssistantService(
    mail,
    respondents,
    storage,
    fakeTriage,
    config({ readAttachments: true, maxAttachmentReads: 3, maxPdfPages: 2 }),
  );

  it('lists every attachment by ref, and each ref opens the file listed under it', async () => {
    const id = await arriveWithFiles(ctx, 'Complaint enclosed', [
      { filename: 'letter.pdf', type: 'application/pdf', bytes: await pdfOf(3) },
      { filename: 'bill.png', type: 'image/png', bytes: PNG },
      { filename: 'notes.docx', type: DOCX_TYPE, bytes: DOCX },
    ]);
    const opened: Record<string, AttachmentReadResult> = {};
    answer = async (email, tools) => {
      for (const a of email.attachments) opened[a.ref] = await tools.readAttachment(a.ref);
      return ok(notComplaint());
    };
    await reader.suggestFor(ctx, id);

    // a1, a2, a3 - in the order the register lists them, which is the order the reader
    // resolves them in.
    const email = seen.at(-1)!;
    const listed = await asOfficer(ctx, (tx) =>
      tx.execute<{ filename: string }>(sql`
        SELECT filename FROM mail_attachment
        WHERE council_id = ${councilId}::uuid AND mail_message_id = ${id}::uuid
        ORDER BY created_at, id
      `),
    );
    expect(email.attachments.map((a) => a.ref)).toEqual(['a1', 'a2', 'a3']);
    expect(email.attachments.map((a) => a.filename)).toEqual(listed.rows.map((r) => r.filename));
    expect(email.attachments.map((a) => a.filename).sort()).toEqual(['bill.png', 'letter.pdf', 'notes.docx']);
    // Refused files are listed too - the model is told a file came - but marked unkept.
    const named = (f: string) => email.attachments.find((a) => a.filename === f)!;
    expect(named('notes.docx')).toMatchObject({ stored: false, contentType: DOCX_TYPE });
    expect(named('letter.pdf')).toMatchObject({ stored: true, contentType: 'application/pdf' });
    expect(named('bill.png')).toMatchObject({ stored: true, contentType: 'image/png' });

    // The staged PDF, cut to the configured two pages of its three.
    expect(opened[refOf(email, 'letter.pdf')]).toMatchObject({
      ok: true,
      kind: 'pdf',
      mediaType: 'application/pdf',
      pagesTotal: 3,
      pagesSent: 2,
    });
    // The staged image, as it came.
    const image = opened[refOf(email, 'bill.png')]!;
    expect(image).toMatchObject({ ok: true, kind: 'image', mediaType: 'image/png', pagesTotal: null, pagesSent: null });
    expect(image.ok && image.data.equals(PNG)).toBe(true);
    // The refused file says why, in words, and nothing is fetched for it.
    expect(opened[refOf(email, 'notes.docx')]).toEqual({
      ok: false,
      reason: expect.stringMatching(/did not keep this file.*Not a kind the register stores/),
    });

    // And the engine was told it may read, and how many.
    expect(seenOpts.at(-1)).toMatchObject({ readAttachments: true, maxAttachmentReads: 3 });
    // So are the screens - before anything is asked - but only while the assistant is on.
    expect(reader.status(ctx)).toMatchObject({ enabled: true, readsAttachments: true });
    expect(reader.status({ ...ctx, config: KSDC_CONFIG })).toMatchObject({ enabled: false, readsAttachments: false });
  });

  it('records on the suggestion exactly what was sent, from the moment it is handed over, and the card shows it', async () => {
    const id = await arriveWithFiles(ctx, 'Referral from the district office', [
      { filename: 'referral.pdf', type: 'application/pdf', bytes: await pdfOf(3) },
      { filename: 'photo.png', type: 'image/png', bytes: PNG },
    ]);
    let midway: Awaited<ReturnType<typeof suggestionRows>> = [];
    answer = async (email, tools) => {
      const pdfRef = refOf(email, 'referral.pdf');
      const pngRef = refOf(email, 'photo.png');
      const pdf = await tools.readAttachment(pdfRef);
      const png = await tools.readAttachment(pngRef);
      // Already on the row, while the model is still reading: a reading cut off here has
      // still sent both.
      midway = await suggestionRows(ctx, id);
      return ok(notComplaint(), 0.03, [record(email, pdfRef, pdf), record(email, pngRef, png)]);
    };
    const view = await reader.suggestFor(ctx, id);

    expect(midway).toHaveLength(1);
    expect(midway[0]).toMatchObject({ status: 'failed', error: STILL_READING });
    expect(midway[0]!.attachments_read.map((r) => r.filename).sort()).toEqual(['photo.png', 'referral.pdf']);

    // The card: file names and pages, not the model's refs.
    expect(view.status).toBe('pending');
    expect(view.attachmentsRead).toEqual([
      { filename: 'referral.pdf', pagesSent: 2, pagesTotal: 3 },
      { filename: 'photo.png', pagesSent: null, pagesTotal: null },
    ]);
    const shown = (await asOfficer(ctx, (tx) => assistant.latestFor(tx, ctx, [id]))).get(id)!;
    expect(shown.attachmentsRead).toEqual(view.attachmentsRead);
    // The row keeps the refs as well, for tracing a reading back to the files.
    const rows = await suggestionRows(ctx, id);
    expect(rows[0]!.attachments_read).toEqual([
      { ref: refOf(seen.at(-1)!, 'referral.pdf'), filename: 'referral.pdf', pagesSent: 2, pagesTotal: 3 },
      { ref: refOf(seen.at(-1)!, 'photo.png'), filename: 'photo.png', pagesSent: null, pagesTotal: null },
    ]);

    // A reading that read nothing records nothing - and the card it replaces the first one
    // on still says what the first one sent.
    answer = () => ok(notComplaint());
    const plain = await reader.suggestFor(ctx, id);
    expect(plain.attachmentsRead).toEqual([]);
    expect(plain.otherReadingsSent).toEqual([
      { filename: 'referral.pdf', pagesSent: 2, pagesTotal: 3 },
      { filename: 'photo.png', pagesSent: null, pagesTotal: null },
    ]);
    expect(view.otherReadingsSent).toEqual([]);
  });

  it('shows what a failed "ask again" sent, though the card still shows the pending suggestion', async () => {
    const id = await arriveWithFiles(ctx, 'Letter about my case', [
      { filename: 'letter.pdf', type: 'application/pdf', bytes: await pdfOf(3) },
      { filename: 'photo.png', type: 'image/png', bytes: PNG },
    ]);
    // First reading: the photo, then a suggestion.
    answer = async (email, tools) => {
      const ref = refOf(email, 'photo.png');
      return ok(notComplaint(), 0.01, [record(email, ref, await tools.readAttachment(ref))]);
    };
    const first = await reader.suggestFor(ctx, id);
    // Asked again: it opens the letter (and the photo once more), then fails.
    answer = async (email, tools) => {
      const sent: AttachmentReadRecord[] = [];
      for (const f of ['letter.pdf', 'photo.png']) {
        const ref = refOf(email, f);
        sent.push(record(email, ref, await tools.readAttachment(ref)));
      }
      return {
        ok: false,
        error: 'Claude is busy or unavailable just now. Try again later.',
        model: 'fake-model',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.02,
        toolCalls: 0,
        attachmentsRead: sent,
      };
    };
    const again = await reader.suggestFor(ctx, id);
    expect(again.status).toBe('failed');

    // The card shows the suggestion still live - and that the letter went too. The photo
    // is named once, by the reading shown.
    const shown = (await asOfficer(ctx, (tx) => assistant.latestFor(tx, ctx, [id]))).get(id)!;
    expect(shown).toMatchObject({ id: first.id, status: 'pending' });
    expect(shown.attachmentsRead).toEqual([{ filename: 'photo.png', pagesSent: null, pagesTotal: null }]);
    expect(shown.otherReadingsSent).toEqual([{ filename: 'letter.pdf', pagesSent: 2, pagesTotal: 3 }]);
  });

  it('keeps the record on a failed reading, and on one the engine threw out of', async () => {
    const id = await arriveWithFiles(ctx, 'Scanned complaint', [
      { filename: 'scan.pdf', type: 'application/pdf', bytes: await pdfOf(1) },
      { filename: 'bill.png', type: 'image/png', bytes: PNG },
    ]);

    // The engine read a file, then failed: the file went all the same.
    answer = async (email, tools) => {
      const ref = refOf(email, 'scan.pdf');
      const r = await tools.readAttachment(ref);
      return {
        ok: false,
        error: 'The assistant stopped after too many lookups.',
        model: 'fake-model',
        usage: { inputTokens: 4000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.02,
        toolCalls: 8,
        attachmentsRead: [record(email, ref, r)],
      };
    };
    const failed = await reader.suggestFor(ctx, id);
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringMatching(/too many lookups/) });
    expect(failed.attachmentsRead).toEqual([{ filename: 'scan.pdf', pagesSent: 1, pagesTotal: 1 }]);

    // The engine read a file and then threw. Nobody can say whether it reached Anthropic,
    // so it is recorded as having gone.
    answer = async (email, tools) => {
      await tools.readAttachment(refOf(email, 'bill.png'));
      throw new Error('socket hang up');
    };
    const thrown = await reader.suggestFor(ctx, id);
    expect(thrown).toMatchObject({ status: 'failed', error: expect.stringMatching(/could not be reached/) });
    expect(thrown.attachmentsRead).toEqual([{ filename: 'bill.png', pagesSent: null, pagesTotal: null }]);
    // Shown on this card, the earlier failure's file is not lost from view either.
    expect(thrown.otherReadingsSent).toEqual([{ filename: 'scan.pdf', pagesSent: 1, pagesTotal: 1 }]);

    const rows = await suggestionRows(ctx, id);
    expect(rows.map((r) => r.attachments_read.map((a) => a.filename))).toEqual([['scan.pdf'], ['bill.png']]);
  });

  it("opens only this message's files, whatever ref the model writes", async () => {
    const other = await arriveWithFiles(ctx, 'Somebody else entirely', [
      { filename: 'their-bill.png', type: 'image/png', bytes: PNG },
      { filename: 'their-notes.docx', type: DOCX_TYPE, bytes: DOCX },
    ]);
    const otherIds = await asOfficer(ctx, (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT id FROM mail_attachment
        WHERE council_id = ${councilId}::uuid AND mail_message_id = ${other}::uuid
      `),
    );
    const id = await arriveWithFiles(ctx, 'My letter', [
      { filename: 'mine.pdf', type: 'application/pdf', bytes: await pdfOf(1) },
    ]);

    const asked: Record<string, AttachmentReadResult> = {};
    answer = async (_email, tools) => {
      // The other message has an a2; this one does not.
      for (const ref of ['a2', ' A1 ', 'a0', '../a1', otherIds.rows[0]!.id, 'their-bill.png']) {
        asked[ref] = await tools.readAttachment(ref);
      }
      return ok(notComplaint());
    };
    await reader.suggestFor(ctx, id);

    expect(asked['a2']).toEqual({
      ok: false,
      reason: expect.stringMatching(/no attachment "a2" on this email\. Its attachments are a1\./),
    });
    // Written loosely, a1 is still this message's a1 - its PDF, not the other's image.
    expect(asked[' A1 ']).toMatchObject({ ok: true, kind: 'pdf', pagesTotal: 1 });
    for (const ref of ['a0', '../a1', otherIds.rows[0]!.id, 'their-bill.png']) {
      expect(asked[ref]).toMatchObject({ ok: false });
    }

    // An email with no files at all says so.
    const bare = await arrive(ctx, person(), 'No files', 'Nothing attached.');
    let none: AttachmentReadResult | undefined;
    answer = async (_email, tools) => {
      none = await tools.readAttachment('a1');
      return ok(notComplaint());
    };
    await reader.suggestFor(ctx, bare);
    expect(none).toEqual({ ok: false, reason: 'This email has no attachments.' });
  });

  it('reads a file from the case document it became, and not one withdrawn as misfiled', async () => {
    // A message opened as a case, the case then cancelled as opened in error: the message
    // is back in the tray, and its files are documents on the cancelled case. The staged
    // copy MOVED when it became a document, so the staging key names nothing any more.
    const id = await arriveWithFiles(ctx, 'Bill for the crown', [
      { filename: 'bill.png', type: 'image/png', bytes: PNG },
      { filename: 'xray.png', type: 'image/png', bytes: PNG2 },
    ]);
    const opened = await asOfficer(ctx, (tx) => mail.openCase(tx, ctx, { mailMessageId: id }));
    expect(opened.documentsFiled).toBe(2);
    await asOfficer(ctx, (tx) =>
      lifecycle.cancel(tx, ctx, { caseFileId: opened.caseFileId, reason: 'Opened twice by mistake' }),
    );
    expect((await messageRow(ctx, id)).status).toBe('unfiled');

    const files = await asOfficer(ctx, (tx) =>
      tx.execute<{ filename: string; staging_key: string; document_id: string | null }>(sql`
        SELECT filename, staging_key, document_id FROM mail_attachment
        WHERE council_id = ${councilId}::uuid AND mail_message_id = ${id}::uuid
      `),
    );
    const bill = files.rows.find((f) => f.filename === 'bill.png')!;
    const xray = files.rows.find((f) => f.filename === 'xray.png')!;
    expect(bill.document_id).not.toBeNull();
    await expect(storage.read(bill.staging_key)).rejects.toThrow();

    // The X-ray turns out to be another patient's.
    await asOfficer(ctx, (tx) =>
      documents.markMisfiled(tx, ctx, { documentId: xray.document_id!, reason: "Another patient's X-ray" }),
    );

    const got: Record<string, AttachmentReadResult> = {};
    answer = async (email, tools) => {
      for (const a of email.attachments) got[a.filename] = await tools.readAttachment(a.ref);
      return ok(notComplaint());
    };
    const view = await reader.suggestFor(ctx, id);

    expect(got['bill.png']).toMatchObject({ ok: true, kind: 'image', mediaType: 'image/png' });
    expect(got['bill.png']!.ok && got['bill.png']!.data.equals(PNG)).toBe(true);
    expect(got['xray.png']).toEqual({ ok: false, reason: expect.stringMatching(/withdrawn from the case as misfiled/) });
    expect(view.status).toBe('pending');
  });

  it('reads from the document when the officer files the message while the model is reading', async () => {
    // The staged file moves to the case document the moment the case is opened; the staging
    // key still names where it was. Looked for there, the file would be "not found".
    const id = await arriveWithFiles(ctx, 'Bills', [{ filename: 'bill.png', type: 'image/png', bytes: PNG }]);
    let got: AttachmentReadResult | undefined;
    answer = async (email, tools) => {
      await asOfficer(ctx, (tx) => mail.openCase(tx, ctx, { mailMessageId: id }));
      got = await tools.readAttachment('a1');
      return ok(notComplaint(), 0.01, [record(email, 'a1', got)]);
    };
    const view = await reader.suggestFor(ctx, id);

    expect(got).toMatchObject({ ok: true, kind: 'image' });
    expect(got!.ok && got!.data.equals(PNG)).toBe(true);
    // Not a suggestion for a message already dealt with - but what was sent is still recorded.
    expect(view).toMatchObject({ status: 'failed', error: expect.stringMatching(/dealt with while/) });
    expect(view.attachmentsRead).toEqual([{ filename: 'bill.png', pagesSent: null, pagesTotal: null }]);
  });

  it('switched off, refuses every file - the model sees names only, and nothing is recorded', async () => {
    const id = await arriveWithFiles(ctx, 'Letter attached', [
      { filename: 'letter.pdf', type: 'application/pdf', bytes: await pdfOf(1) },
    ]);
    let r: AttachmentReadResult | undefined;
    answer = async (_email, tools) => {
      // An engine that offered the tool anyway gets nothing from it.
      r = await tools.readAttachment('a1');
      return ok(notComplaint());
    };
    const view = await assistant.suggestFor(ctx, id);

    expect(seenOpts.at(-1)).toMatchObject({ readAttachments: false });
    expect(seen.at(-1)!.attachments).toEqual([
      { ref: 'a1', filename: 'letter.pdf', contentType: 'application/pdf', stored: true },
    ]);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/switched off.*MAIL_ASSISTANT_ATTACHMENTS/) });
    expect(view.attachmentsRead).toEqual([]);
    expect((await suggestionRows(ctx, id))[0]!.attachments_read).toEqual([]);
  });

  it('never hands over more files than its limit, however the engine asks', async () => {
    const twoOnly = new AssistantService(
      mail,
      respondents,
      storage,
      fakeTriage,
      config({ readAttachments: true, maxAttachmentReads: 2, maxPdfPages: 10 }),
    );
    const id = await arriveWithFiles(ctx, 'Everything I have', [
      { filename: 'letter.pdf', type: 'application/pdf', bytes: await pdfOf(1) },
      { filename: 'bill.png', type: 'image/png', bytes: PNG },
      { filename: 'notes.docx', type: DOCX_TYPE, bytes: DOCX },
      { filename: 'photo.png', type: 'image/png', bytes: PNG2 },
    ]);

    const order: Array<[string, boolean]> = [];
    let atOnce: AttachmentReadResult[] = [];
    let handedOver: AttachmentReadRecord[] = [];
    answer = async (email, tools) => {
      // A refused file costs nothing from the budget...
      for (const f of ['notes.docx', 'letter.pdf']) {
        order.push([f, (await tools.readAttachment(refOf(email, f))).ok]);
      }
      // ...and two asked for at once at the last place: exactly one gets it.
      const refs = [refOf(email, 'bill.png'), refOf(email, 'photo.png')];
      atOnce = await Promise.all(refs.map((ref) => tools.readAttachment(ref)));
      // While still reading: what has been handed over is already on the row.
      handedOver = (await suggestionRows(ctx, id))[0]!.attachments_read;
      return ok(notComplaint());
    };
    await twoOnly.suggestFor(ctx, id);

    expect(order).toEqual([
      ['notes.docx', false],
      ['letter.pdf', true],
    ]);
    expect(atOnce.filter((r) => r.ok)).toHaveLength(1);
    expect(atOnce.find((r) => !r.ok)).toEqual({ ok: false, reason: expect.stringMatching(/At most 2 attachment/) });
    // Two files, not three - and not the refused one.
    expect(handedOver.map((r) => r.filename)).toHaveLength(2);
    expect(handedOver.map((r) => r.filename)).toContain('letter.pdf');
    expect(handedOver.map((r) => r.filename)).not.toContain('notes.docx');
  });

  it("refuses, before handing it over, a file the engine's budget for the email would refuse", async () => {
    // Two 60-page PDFs are 120 pages, past the 100 one email may send. The engine would
    // refuse the second; the reader refuses it first, so it is neither counted against the
    // read limit nor written onto the suggestion as sent.
    const longPdfs = new AssistantService(
      mail,
      respondents,
      storage,
      fakeTriage,
      config({ readAttachments: true, maxAttachmentReads: 2, maxPdfPages: 60 }),
    );
    const id = await arriveWithFiles(ctx, 'Two bundles', [
      { filename: 'first.pdf', type: 'application/pdf', bytes: await pdfOf(60) },
      { filename: 'second.pdf', type: 'application/pdf', bytes: await pdfOf(60) },
      { filename: 'bill.png', type: 'image/png', bytes: PNG },
    ]);
    const got: Record<string, AttachmentReadResult> = {};
    let handedOver: AttachmentReadRecord[] = [];
    answer = async (email, tools) => {
      for (const f of ['first.pdf', 'second.pdf', 'bill.png']) got[f] = await tools.readAttachment(refOf(email, f));
      handedOver = (await suggestionRows(ctx, id))[0]!.attachments_read;
      return ok(notComplaint());
    };
    await longPdfs.suggestFor(ctx, id);

    expect(got['first.pdf']).toMatchObject({ ok: true, pagesSent: 60 });
    expect(got['second.pdf']).toEqual({ ok: false, reason: expect.stringMatching(/too many pages to send together/) });
    // Its read place given back: the picture is the second of two.
    expect(got['bill.png']).toMatchObject({ ok: true, kind: 'image' });
    expect(handedOver.map((r) => r.filename)).toEqual(['first.pdf', 'bill.png']);
  });
});

// ─── The lookups ─────────────────────────────────────────────────────────────

describe('what the model may look up', () => {
  // The file reader is the attachment tests' business; here it is off, and points at no
  // message at all.
  const tools = registerTools(ctx, respondents, {
    mailMessageId: '00000000-0000-4000-8000-0000000000aa',
    storage,
    enabled: false,
    maxReads: 3,
    maxPdfPages: 10,
  });

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

// ─── Copies of the Council's own letters ─────────────────────────────────────

describe("a copy of a letter the Council sent", () => {
  it('is shown to the model as the Council writing to the person it went to - not as a forward with no sender', async () => {
    const who = person('Rekha');
    const id = await arriveCopy(ctx, who, 'Your complaint - documents still awaited');
    // Ask mode, or the officer pressing the button: a copy can still be asked about.
    answer = () => ok(unsure());
    await assistant.suggestFor(ctx, id);
    const email = seen.at(-1)!;
    expect(email.fromAddress).toBe('registrar@asst.test');
    expect(email.forwardedBy).toBeNull();
    expect(email.to).toContain(who.email);
  });

  it('a letter of ours forwarding a complaint on to the dentist is shown whole, as the Council writing', async () => {
    const complainant = person('Kavya');
    const dentistAt = person('Mehta');
    seq++;
    const bytes = Buffer.from(
      [
        'From: Test Registrar <registrar@asst.test>',
        `To: Dr Mehta <${dentistAt.email}>`,
        'Cc: intake@asst.test',
        'Subject: Fwd: Complaint against you',
        `Message-ID: <asst-onward-${TAG}-${seq}@mail.test>`,
        'Date: Wed, 7 Oct 2026 10:14:00 +0530',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Dear Doctor, the complaint below has been received against you.',
        '',
        '---------- Forwarded message ---------',
        `From: ${complainant.name} <${complainant.email}>`,
        'Date: Sat, 20 Sep 2026 at 09:00',
        'Subject: Complaint about my crown',
        'To: <registrar@asst.test>',
        '',
        'The crown came off within a week.',
      ].join('\r\n'),
      'utf8',
    );
    const out = await asOfficer(ctx, async (tx) =>
      mail.ingest(tx, ctx, await simpleParser(bytes), {
        mailbox: 'intake@asst.test/INBOX',
        uid: 1000 + seq,
        uidValidity: '1',
        raw: bytes,
      }),
    );
    expect(out.councilCopy).toBe(true);
    answer = () => ok(unsure());
    await assistant.suggestFor(ctx, out.mailMessageId);
    const email = seen.at(-1)!;
    expect(email.fromAddress).toBe('registrar@asst.test');
    expect(email.forwardedBy).toBeNull();
    expect(email.to).toContain(dentistAt.email);
    expect(email.subject).toBe('Fwd: Complaint against you');
    expect(email.body).toContain('Dear Doctor, the complaint below');
    expect(email.body).toContain('The crown came off within a week.');
    expect(email.dateText).not.toMatch(/20 Sep/);
  });

  it('is never read automatically: the sweep spends nothing on it, and reads the mail beside it', async () => {
    const sweeper = new AssistantService(mail, respondents, storage, fakeTriage, config({ perSweep: 5 }));
    const copy = await arriveCopy(ctx, person('Sunil'), 'Your complaint - documents still awaited');
    const plain = await arrive(ctx, person(), 'A crown that came off', 'It came off.');
    await sweeper.suggestAfterSweep(ctx, [copy, plain]);
    await sweeper.whenIdle();
    expect(seen).toHaveLength(1);
    expect(await suggestionRows(ctx, copy)).toHaveLength(0);
    expect((await suggestionRows(ctx, plain)).map((r) => r.status)).toEqual(['pending']);
  });

  it('is stored with its case resolved live, and an answer without its section is not shown', async () => {
    const existing = await caseFrom(ctx);
    const id = await arriveCopy(ctx, existing.who, 'Your complaint - documents still awaited');
    answer = () => ok(councilCopy(existing.caseNumber.toLowerCase()));
    const view = await assistant.suggestFor(ctx, id);
    expect(view).toMatchObject({ status: 'pending', decision: 'council_letter_copy', followUp: null });
    expect(view.councilCopy).toEqual({
      caseFileId: existing.caseFileId,
      caseNumber: existing.caseNumber,
      letter: 'documents request',
      because: 'Quotes the case; sent to its complainant.',
      closed: false,
    });

    answer = () => ok({ ...councilCopy(existing.caseNumber), councilCopy: null });
    const broken = await assistant.suggestFor(ctx, id);
    expect(broken.status).toBe('failed');
  });

  it('accepted, is attached to the letter the case records as sent: nothing new, and the reminder keeps running', async () => {
    const existing = await caseFrom(ctx);
    const letterId = await sendDocumentsLetter(ctx, existing.caseFileId);
    const before = await caseState(ctx, existing.caseFileId);
    expect(before.waitingForDocuments).toBe(true);

    // Sent to an address the register does not hold, so it could not check the case by
    // itself and left it in the tray.
    const id = await arriveCopy(
      ctx,
      { name: existing.who.name, email: `other.${existing.who.email}` },
      `Documents required - ${existing.caseNumber}`,
    );
    answer = () => ok(councilCopy(existing.caseNumber));
    await assistant.suggestFor(ctx, id);

    const out = await asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id));
    expect(out).toMatchObject({ caseFileId: existing.caseFileId, caseNumber: existing.caseNumber });

    const after = await caseState(ctx, existing.caseFileId);
    expect(after).toEqual(before); // no letter added either way, and still waiting
    const msg = await asOfficer(ctx, (tx) =>
      tx.execute<{ status: string; correspondence_id: string | null }>(sql`
        SELECT status::text, correspondence_id FROM mail_message WHERE id = ${id}::uuid
      `),
    );
    expect(msg.rows[0]).toEqual({ status: 'filed', correspondence_id: letterId });
    expect((await suggestionRows(ctx, id))[0]).toMatchObject({
      status: 'accepted',
      outcome_action: 'filed_on_case',
      outcome_agreed: true,
      outcome_case_file_id: existing.caseFileId,
    });
  });

  it("accepted on a copy the register's own check missed: filed as a letter sent, never received, and no reminder moves", async () => {
    const existing = await caseFrom(ctx);
    await sendDocumentsLetter(ctx, existing.caseFileId);
    const before = await caseState(ctx, existing.caseFileId);

    // From the officer's own address outside the Council: the register cannot tell this is
    // the Council's letter. The assistant could.
    const id = await arriveDirect(
      ctx,
      { name: 'Dental Officer', email: `officer.home.${TAG.toLowerCase()}@example.in` },
      'Copy of the letter sent today',
      // No case number: one in the body would file the message by itself, as a reply.
      `Copy for the file of the reminder sent to ${existing.who.name} today.`,
    );
    answer = () => ok(councilCopy(existing.caseNumber));
    await assistant.suggestFor(ctx, id);
    await asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id));

    const after = await caseState(ctx, existing.caseFileId);
    expect(after.inbound).toBe(before.inbound);
    expect(after.outbound).toBe(before.outbound + 1);
    expect(after.waitingForDocuments).toBe(true);
    expect(await messageRow(ctx, id)).toMatchObject({ status: 'filed', case_file_id: existing.caseFileId });
  });

  it('accepted on another case than suggested: edited, and a disagreement', async () => {
    const suggested = await caseFrom(ctx);
    const actual = await caseFrom(ctx);
    const id = await arriveCopy(ctx, actual.who, 'Your complaint - documents still awaited');
    answer = () => ok(councilCopy(suggested.caseNumber));
    await assistant.suggestFor(ctx, id);
    await asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id, { caseFileId: actual.caseFileId }));
    expect((await suggestionRows(ctx, id))[0]).toMatchObject({
      status: 'edited',
      outcome_agreed: false,
      outcome_case_file_id: actual.caseFileId,
    });
  });

  it('on a case cancelled since: refused without a case chosen', async () => {
    const gone = await caseFrom(ctx);
    const id = await arriveCopy(ctx, gone.who, 'Your complaint - documents still awaited');
    answer = () => ok(councilCopy(gone.caseNumber));
    await assistant.suggestFor(ctx, id);
    await asOfficer(ctx, (tx) => lifecycle.cancel(tx, ctx, { caseFileId: gone.caseFileId, reason: 'Opened twice by mistake' }));
    const view = (await asOfficer(ctx, (tx) => assistant.latestFor(tx, ctx, [id]))).get(id)!;
    expect(view.councilCopy).toMatchObject({ caseNumber: gone.caseNumber, caseFileId: null });
    await expect(asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id))).rejects.toMatchObject({ status: 409 });
  });

  describe('the officer filing it with the ordinary buttons', () => {
    it('as a copy, on the suggested case: agreed', async () => {
      const target = await caseFrom(ctx);
      const id = await arriveCopy(ctx, target.who, 'Your complaint - documents still awaited');
      answer = () => ok(councilCopy(target.caseNumber));
      await assistant.suggestFor(ctx, id);
      await asOfficer(ctx, (tx) =>
        mail.fileCouncilCopy(tx, ctx, { mailMessageId: id, caseFileId: target.caseFileId, mode: 'record_only' }),
      );
      expect((await suggestionRows(ctx, id))[0]).toMatchObject({
        status: 'handled',
        outcome_action: 'filed_on_case',
        outcome_agreed: true,
        outcome_case_file_id: target.caseFileId,
        outcome_note: FILED_AS_COPY_NOTE,
      });
    });

    it('as a letter received, on the suggested case: not what it suggested', async () => {
      const target = await caseFrom(ctx);
      const id = await arrive(ctx, target.who, 'Re: my case', 'Update.');
      answer = () => ok(councilCopy(target.caseNumber));
      await assistant.suggestFor(ctx, id);
      await asOfficer(ctx, (tx) => mail.fileOnCase(tx, ctx, { mailMessageId: id, caseFileId: target.caseFileId }));
      expect((await suggestionRows(ctx, id))[0]).toMatchObject({ status: 'handled', outcome_agreed: false });
    });

    it('a follow-up suggested for a copy, which the officer filed as a copy: a disagreement, and no reminder closed', async () => {
      const target = await caseFrom(ctx);
      await sendDocumentsLetter(ctx, target.caseFileId);
      const id = await arriveCopy(ctx, target.who, 'Your complaint - documents still awaited');
      answer = () => ok(followUp(target.caseNumber));
      await assistant.suggestFor(ctx, id);
      // "Add to a case" on a copy files it as a copy (MailIntakeService.fileOnCase).
      await asOfficer(ctx, (tx) => mail.fileOnCase(tx, ctx, { mailMessageId: id, caseFileId: target.caseFileId }));
      // Said why, because "added it to a case" alone reads like what it suggested.
      expect((await suggestionRows(ctx, id))[0]).toMatchObject({
        status: 'handled',
        outcome_agreed: false,
        outcome_note: FILED_AS_COPY_NOTE,
      });
      expect((await caseState(ctx, target.caseFileId)).waitingForDocuments).toBe(true);
    });
  });

  it('a follow-up suggested for a copy and ACCEPTED on that case is counted exactly as the ordinary buttons count it', async () => {
    const target = await caseFrom(ctx);
    await sendDocumentsLetter(ctx, target.caseFileId);
    const id = await arriveCopy(ctx, target.who, 'Your complaint - documents still awaited');
    answer = () => ok(followUp(target.caseNumber));
    await assistant.suggestFor(ctx, id);
    await asOfficer(ctx, (tx) => assistant.accept(tx, ctx, id));
    expect((await suggestionRows(ctx, id))[0]).toMatchObject({
      status: 'edited',
      outcome_action: 'filed_on_case',
      outcome_agreed: false,
      outcome_case_file_id: target.caseFileId,
      outcome_note: FILED_AS_COPY_NOTE,
    });
    // Filed as the copy it is, all the same: nothing received, the reminder still running.
    expect((await caseState(ctx, target.caseFileId)).waitingForDocuments).toBe(true);
  });

  it("marks the intake mailbox's own address in the To line, so an unread office forward is not taken for our letter", async () => {
    seq++;
    const intake = `ksdc.intake.${TAG.toLowerCase()}@gmail.com`;
    const bytes = Buffer.from(
      [
        'From: Test Registrar <registrar@asst.test>',
        `To: ${intake}`,
        'Subject: Fwd: Treatment complaint',
        `Message-ID: <asst-unread-${TAG}-${seq}@mail.test>`,
        'Date: Wed, 17 Sep 2026 10:14:00 +0530',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Please see below.',
        '',
        'The bridge fitted in August has come loose twice.',
      ].join('\r\n'),
      'utf8',
    );
    const out = await asOfficer(ctx, async (tx) =>
      mail.ingest(tx, ctx, await simpleParser(bytes), {
        mailbox: `${intake}/INBOX`,
        uid: 1000 + seq,
        uidValidity: '1',
        raw: bytes,
      }),
    );
    expect(out.councilCopy).toBe(false);
    answer = () => ok(unsure());
    await assistant.suggestFor(ctx, out.mailMessageId);
    const email = seen.at(-1)!;
    expect(email.to).toBe(`${intake} ${OWN_MAILBOX_MARK}`);
    expect(email.forwardedBy).toMatch(/registrar@asst\.test/);
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
      attachmentsRead: [],
    });
    await assistant.suggestFor(c, m5);

    // 6. Asked twice: one superseded, one pending.
    const m6 = await arrive(c, person(), 'Report subject six', 'Text.');
    answer = () => ok(notComplaint());
    await assistant.suggestFor(c, m6);
    await assistant.suggestFor(c, m6);

    // 7. A copy of a Council letter, accepted: agreed, in a column of its own.
    const kase = await caseFrom(c);
    const m7 = await arriveCopy(c, kase.who, 'Your complaint - documents still awaited');
    answer = () => ok(councilCopy(kase.caseNumber));
    await assistant.suggestFor(c, m7);
    await asOfficer(c, (tx) => assistant.accept(tx, c, m7));

    const report = await asOfficer(c, (tx) => assistant.report(tx, c, month));
    expect(report).toMatchObject({ enabled: true, reason: null, model: 'fake-model', month });
    expect(report.totals).toEqual({
      pending: 1,
      accepted: 2,
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
      council_letter_copy: { agreed: 1, disagreed: 0 },
      unsure: { agreed: 0, disagreed: 0 },
    });
    expect(report.agreement.overall).toEqual({ agreed: 2, disagreed: 2 });
    // Seven calls at a cent and one failure at a fifth of one - failures and superseded
    // suggestions included, because they were paid for.
    expect(report.costUsd).toBeCloseTo(0.072, 6);

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
