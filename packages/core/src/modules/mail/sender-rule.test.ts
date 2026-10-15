import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import { closeDb, initDb, withCouncil, type Tx } from '@ksdc/db';
import { KSDC_CONFIG, type CouncilConfig } from '@ksdc/config';
import { CaseIntakeService } from '../cases/case-intake.service.js';
import { CaseLifecycleService } from '../cases/case-lifecycle.service.js';
import { CorrespondenceService } from '../correspondence/correspondence.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { FollowupService, type EngineContext } from '../followups/followup.service.js';
import { LocalStorage } from '../documents/storage.js';
import { seedCouncilAndOfficer } from '../../test-support/fixtures.js';
import { describeOutcome, parseArgs } from '../../../scripts/apply-sender-rule.js';
import { MailIntakeService } from './mail-intake.service.js';
import { applySenderRule, SWITCHED_ON_SUFFIX } from './sender-rule.js';
import { forTheAssistant } from './sweep.js';

/**
 * "Only the Registrar's mail reaches the tray", against a real database.
 *
 * KSDC's complaints come to the intake mailbox only as forwards from the Registrar. With
 * the council's list set (intakeSenders), every message falls into one of four kinds, by
 * the address that SENT it to the intake mailbox:
 *
 *   - an account notice from the mail provider: set aside by its own rule, as before;
 *   - any other address not on the list: set aside on arrival, with a reason, untouched;
 *   - a listed address the mail provider confirmed: exactly as before the list existed;
 *   - a listed address it could not confirm: in the tray, marked, and never filing itself.
 *
 * And with no list, nothing changes at all.
 */

const councilId = 'c0a61111-1111-4111-8111-111111111111';
const officer = 'c0a62222-2222-4222-8222-222222222222';
// seedCouncilAndOfficer gives the council registrar@srul.test as its own address.
const REGISTRAR = 'registrar@srul.test';

const followups = new FollowupService();
const lifecycle = new CaseLifecycleService(followups);
const intake = new CaseIntakeService(followups);
const correspondence = new CorrespondenceService(lifecycle, followups);
const storage = new LocalStorage();
const documents = new DocumentsService(storage);
const mail = new MailIntakeService(storage, intake, correspondence, documents, followups);

const RULE: CouncilConfig = { ...KSDC_CONFIG, intakeSenders: [REGISTRAR] };
const NO_RULE: CouncilConfig = { ...KSDC_CONFIG, intakeSenders: [] };
const ctx: EngineContext = { councilId, userId: officer, config: RULE };
const ctxNoRule: EngineContext = { councilId, userId: officer, config: NO_RULE };

beforeAll(async () => {
  initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId }, (tx) =>
    seedCouncilAndOfficer(tx, { councilId, officerId: officer, code: 'SRUL' }),
  );
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  // Nothing is deleted anywhere in this database, so each test retires what came before.
  await withCouncil({ councilId }, async (tx) => {
    await tx.execute(sql`UPDATE mail_message SET status = 'dismissed', dismissed_at = now(),
                           dismissed_reason = 'test reset'
                         WHERE council_id = ${councilId}::uuid AND status = 'unfiled'`);
  });
});

const asOfficer = <T>(fn: (tx: Tx) => Promise<T>) => withCouncil({ councilId, userId: officer }, fn);

/** What Gmail writes on top of a forward from the Registrar that it could confirm. */
const GMAIL_CONFIRMED = [
  'Authentication-Results: mx.google.com;',
  '       dkim=pass header.i=@srul.test header.s=default header.b=Xq3vK9aB;',
  '       spf=pass (google.com: domain of registrar@srul.test designates 192.0.2.10 as permitted sender) smtp.mailfrom=registrar@srul.test;',
  '       dmarc=none (p=NONE sp=NONE dis=NONE) header.from=srul.test',
];
/** And on one it could not: sent from somewhere else with the Registrar's address typed in. */
const GMAIL_UNCONFIRMED = [
  'Authentication-Results: mx.google.com;',
  '       spf=softfail (google.com: domain of transitioning registrar@srul.test does not designate 198.51.100.7 as permitted sender) smtp.mailfrom=registrar@srul.test;',
  '       dmarc=none (p=NONE sp=NONE dis=NONE) header.from=srul.test',
];

// A one-pixel PNG: a file the register stores, so staging can be seen to have happened.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let seq = 0;
/** A message as Gmail hands it over: its own headers on top, then the sender's. */
async function message(args: {
  auth?: string[];
  from: string;
  subject: string;
  body: string;
  png?: boolean;
}) {
  seq++;
  const boundary = `b-${seq}`;
  const head = [
    ...(args.auth ?? []),
    `From: ${args.from}`,
    'To: intake@srul.test',
    `Subject: ${args.subject}`,
    `Message-ID: <srul-${seq}-${Math.random().toString(36).slice(2)}@mail.test>`,
    'Date: Wed, 15 Oct 2026 10:14:00 +0530',
  ];
  const lines = args.png
    ? [
        ...head,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        args.body,
        `--${boundary}`,
        'Content-Type: image/png; name="bill.png"',
        'Content-Disposition: attachment; filename="bill.png"',
        'Content-Transfer-Encoding: base64',
        '',
        PNG.toString('base64'),
        `--${boundary}--`,
      ]
    : [...head, 'Content-Type: text/plain; charset=utf-8', '', args.body];
  const bytes = Buffer.from(lines.join('\r\n'), 'utf8');
  return { parsed: await simpleParser(bytes), raw: bytes };
}

/** The Registrar forwarding a reply that quotes a case number. */
function registrarForward(auth: string[], caseNumber: string, png = false) {
  return message({
    auth,
    from: `Registrar SRUL <${REGISTRAR}>`,
    subject: `Fwd: Re: Documents required [${caseNumber}]`,
    body: [
      'Please file.',
      '',
      '---------- Forwarded message ---------',
      'From: Kavitha Devi <kdevi@example.in>',
      'Date: Tue, 14 Oct 2026 at 19:12',
      `Subject: Re: Documents required [${caseNumber}]`,
      `To: <${REGISTRAR}>`,
      '',
      'I am attaching the bills you asked for.',
    ].join('\r\n'),
    png,
  });
}

/** Marketing mail, well signed by its own sender, quoting a case number for good measure. */
function marketing(caseNumber = 'none') {
  return message({
    auth: [
      'Authentication-Results: mx.google.com;',
      '       dkim=pass header.i=@mail.adobe.example header.s=s1;',
      '       spf=pass smtp.mailfrom=bounce@mail.adobe.example',
    ],
    from: 'Adobe <mail@mail.adobe.example>',
    subject: `Your free trial ends soon (ref ${caseNumber})`,
    body: 'Upgrade today and save 40 per cent.',
    png: true,
  });
}

const ingest = (tx: Tx, c: EngineContext, m: Awaited<ReturnType<typeof message>>) =>
  mail.ingest(tx, c, m.parsed, { mailbox: 'intake@srul.test/INBOX', uid: 5000 + ++seq, uidValidity: '1', raw: m.raw });

/** A case waiting for the complainant's documents - what a reply quoting it would satisfy. */
async function caseWaitingForDocuments(tx: Tx) {
  const opened = await intake.create(tx, ctx, {
    summary: 'Crown came off',
    receivedAt: new Date('2026-10-01T04:00:00Z'),
    complainant: { fullName: 'Kavitha Devi', email: 'kdevi@example.in' },
  });
  await lifecycle.apply(tx, ctx, { caseFileId: opened.caseFileId, event: 'REQUEST_DOCUMENTS' });
  return opened;
}

const waitingForDocuments = async (tx: Tx, caseFileId: string) =>
  (await followups.liveForCase(tx, ctx, caseFileId)).some((f) => f.stage === 'await_patient_docs');

async function stored(tx: Tx, id: string) {
  const rows = await tx.execute<{
    status: string;
    sender_check: string | null;
    dismissed_reason: string | null;
    suggested_case_file_id: string | null;
    suggestion_note: string | null;
    staged: number;
  }>(sql`
    SELECT m.status::text, m.sender_check, m.dismissed_reason, m.suggested_case_file_id,
           m.suggestion_note,
           (SELECT count(*)::int FROM mail_attachment a
             WHERE a.mail_message_id = m.id AND a.staging_key IS NOT NULL) AS staged
    FROM mail_message m WHERE m.council_id = ${councilId}::uuid AND m.id = ${id}::uuid
  `);
  return rows.rows[0]!;
}

describe('a forward from the Registrar that Gmail confirmed', () => {
  it('is taken exactly as before: quoting a case number, it files itself and stops the reminder', async () => {
    await asOfficer(async (tx) => {
      const opened = await caseWaitingForDocuments(tx);
      const out = await ingest(tx, ctx, await registrarForward(GMAIL_CONFIRMED, opened.caseNumber, true));

      expect(out).toMatchObject({ status: 'filed', autoFiledTo: opened.caseFileId, senderCheck: 'verified' });
      expect(out.note).toMatch(/Filed automatically/);
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(false);
      expect((await stored(tx, out.mailMessageId)).sender_check).toBe('verified');
      expect(forTheAssistant({ ...out, duplicate: false })).toBe(false); // filed: nothing to ask
    });
  });

  it('waits in the tray, unmarked, when it quotes nothing - and the assistant reads it', async () => {
    await asOfficer(async (tx) => {
      const out = await ingest(
        tx,
        ctx,
        await message({ auth: GMAIL_CONFIRMED, from: REGISTRAR, subject: 'Fwd: Complaint', body: 'Please log this.' }),
      );
      expect(out).toMatchObject({ status: 'unfiled', senderCheck: 'verified' });
      expect(out.note ?? '').not.toMatch(/could not confirm/);
      expect(forTheAssistant(out)).toBe(true);
      const card = (await mail.tray(tx, ctx)).find((c) => c.id === out.mailMessageId)!;
      expect(card.sender_check).toBe('verified');
    });
  });
});

describe('a forward from the Registrar that Gmail could NOT confirm', () => {
  it('quoting a case number, is NOT filed - the case is only suggested, and its reminder stays open', async () => {
    await asOfficer(async (tx) => {
      const opened = await caseWaitingForDocuments(tx);
      const out = await ingest(tx, ctx, await registrarForward(GMAIL_UNCONFIRMED, opened.caseNumber, true));

      expect(out).toMatchObject({ status: 'unfiled', autoFiledTo: null, senderCheck: 'unverified' });
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);
      const correspondenceOnCase = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM correspondence
        WHERE council_id = ${councilId}::uuid AND case_file_id = ${opened.caseFileId}::uuid AND direction = 'in'
      `);
      expect(correspondenceOnCase.rows[0]!.n).toBe(0);

      // Still suggested, with the reason it did not file itself, in plain words.
      const row = await stored(tx, out.mailMessageId);
      expect(row).toMatchObject({ status: 'unfiled', sender_check: 'unverified', suggested_case_file_id: opened.caseFileId, staged: 1 });
      expect(row.suggestion_note).toMatch(/^Gmail could not confirm that this came from the Council's own mail server/);
      expect(row.suggestion_note).toContain(REGISTRAR);
      expect(row.suggestion_note).toContain(`It quotes ${opened.caseNumber}`);
      expect(row.suggestion_note).not.toMatch(/Filed automatically/);

      const card = (await mail.tray(tx, ctx)).find((c) => c.id === out.mailMessageId)!;
      expect(card.sender_check).toBe('unverified');
      const page = await mail.get(tx, ctx, out.mailMessageId);
      expect(page!.message.sender_check).toBe('unverified');
      expect(page!.candidates.map((c) => c.caseFileId)).toContain(opened.caseFileId);
    });
  });

  it('is never set aside, is not read by the automatic assistant, and files by hand as usual', async () => {
    await asOfficer(async (tx) => {
      const opened = await caseWaitingForDocuments(tx);
      const out = await ingest(tx, ctx, await registrarForward([], opened.caseNumber));
      expect(out).toMatchObject({ status: 'unfiled', senderCheck: 'unverified' });
      expect(forTheAssistant(out)).toBe(false);
      expect(await mail.hasUnconfirmedSender(tx, ctx, out.mailMessageId)).toBe(true);

      // The officer, satisfied it is genuine, files it: the ordinary button, the ordinary result.
      await mail.fileOnCase(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect((await stored(tx, out.mailMessageId)).status).toBe('filed');
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(false);
    });
  });
});

describe('mail from any other address', () => {
  it('is set aside on arrival with the reason, its files kept, and nothing matched or filed', async () => {
    await asOfficer(async (tx) => {
      const opened = await caseWaitingForDocuments(tx);
      const out = await ingest(tx, ctx, await marketing(opened.caseNumber));

      expect(out).toMatchObject({ status: 'dismissed', autoFiledTo: null, senderCheck: 'not_allowed', councilCopy: false });
      expect(out.attachmentsStored).toBe(1);
      expect(forTheAssistant(out)).toBe(false);
      const row = await stored(tx, out.mailMessageId);
      expect(row).toMatchObject({ status: 'dismissed', sender_check: 'not_allowed', suggested_case_file_id: null, suggestion_note: null, staged: 1 });
      expect(row.dismissed_reason).toBe(
        `Not from ${REGISTRAR}, the only address complaints are forwarded from. ` +
          'Set aside automatically - bring it back if it is a complaint.',
      );
      // Quoting a case number did not put it on the case, or stop its reminder.
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);

      // Not in the tray; in "Set aside", with its reason on the card.
      expect((await mail.tray(tx, ctx)).some((c) => c.id === out.mailMessageId)).toBe(false);
      const card = (await mail.tray(tx, ctx, 'dismissed')).find((c) => c.id === out.mailMessageId)!;
      expect(card.dismissed_reason).toBe(row.dismissed_reason);
      expect(card.sender_check).toBe('not_allowed');
      expect(await mail.setAsideFromOtherSendersToday(tx, ctx)).toBeGreaterThanOrEqual(1);
    });
  });

  it('can be brought back, and is then an ordinary message - filed only by the officer, files and all', async () => {
    await asOfficer(async (tx) => {
      const opened = await caseWaitingForDocuments(tx);
      const out = await ingest(tx, ctx, await marketing(opened.caseNumber));
      const before = await mail.setAsideFromOtherSendersToday(tx, ctx);

      await mail.restore(tx, ctx, { mailMessageId: out.mailMessageId });
      const row = await stored(tx, out.mailMessageId);
      expect(row).toMatchObject({ status: 'unfiled', dismissed_reason: null, staged: 1 });
      expect((await mail.tray(tx, ctx)).some((c) => c.id === out.mailMessageId)).toBe(true);
      // Brought back, it no longer counts as set aside today.
      expect(await mail.setAsideFromOtherSendersToday(tx, ctx)).toBe(before - 1);
      // Nothing filed it on the way back; the case still waits.
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);

      const filed = await mail.fileOnCase(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(filed.documentsFiled).toBe(1);
    });
  });

  it("from the mail provider about the account, keeps the account notice's own reason", async () => {
    await asOfficer(async (tx) => {
      const out = await ingest(
        tx,
        ctx,
        await message({ from: 'Google <no-reply@accounts.google.com>', subject: 'Security alert', body: 'A new sign-in.' }),
      );
      expect(out).toMatchObject({ status: 'dismissed', senderCheck: 'not_allowed' });
      expect((await stored(tx, out.mailMessageId)).dismissed_reason).toMatch(/^An account notice from the mail provider/);
    });
  });

  it('is judged by who sent it here, not by the complainant inside a forward', async () => {
    await asOfficer(async (tx) => {
      // The complainant's own address is on no list: the Registrar's forward of it is fine...
      const fwd = await ingest(
        tx,
        ctx,
        await message({
          auth: GMAIL_CONFIRMED,
          from: REGISTRAR,
          subject: 'Fwd: My complaint',
          body: ['---------- Forwarded message ---------', 'From: A Patient <patient@example.in>', 'Subject: My complaint', '', 'My crown came off.'].join('\r\n'),
        }),
      );
      expect(fwd).toMatchObject({ status: 'unfiled', senderCheck: 'verified' });
      // ...and a forward BY somebody else of the Registrar's own letter is not.
      const other = await ingest(
        tx,
        ctx,
        await message({
          from: 'A Patient <patient@example.in>',
          subject: 'Fwd: Letter from the Council',
          body: ['---------- Forwarded message ---------', `From: Registrar <${REGISTRAR}>`, 'Subject: Your complaint', '', 'Please send the bills.'].join('\r\n'),
        }),
      );
      expect(other).toMatchObject({ status: 'dismissed', senderCheck: 'not_allowed' });
    });
  });

  it("is judged by the address, not by the Registrar's address written as the display name", async () => {
    await asOfficer(async (tx) => {
      const opened = await caseWaitingForDocuments(tx);
      // Gmail's header even passes - for the address's real domain, which is not the list's.
      const spoof = await ingest(
        tx,
        ctx,
        await message({
          auth: GMAIL_CONFIRMED,
          from: `"${REGISTRAR}" <x@evil.example>`,
          subject: `Fwd: Re: Documents required [${opened.caseNumber}]`,
          body: 'Bills attached.',
        }),
      );
      expect(spoof).toMatchObject({ status: 'dismissed', senderCheck: 'not_allowed', autoFiledTo: null });
      expect((await stored(tx, spoof.mailMessageId)).dismissed_reason).toMatch(/^Not from registrar@srul\.test/);
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);
    });
  });
});

describe('with no list configured', () => {
  it('changes nothing: any sender reaches the tray, and a quoted case number still files itself', async () => {
    await asOfficer(async (tx) => {
      const ad = await ingest(tx, ctxNoRule, await marketing());
      expect(ad).toMatchObject({ status: 'unfiled', senderCheck: null });
      expect((await stored(tx, ad.mailMessageId)).sender_check).toBeNull();
      expect(forTheAssistant(ad)).toBe(true);

      const opened = await caseWaitingForDocuments(tx);
      const reply = await ingest(tx, ctxNoRule, await registrarForward([], opened.caseNumber));
      expect(reply).toMatchObject({ status: 'filed', autoFiledTo: opened.caseFileId, senderCheck: null });
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(false);
    });
  });
});

describe('applying the rule to mail already in the tray (mail:apply-sender-rule)', () => {
  it('on a dry run, counts by address what it would set aside, and changes nothing', async () => {
    await asOfficer(async (tx) => {
      // What arrived before the rule was switched on.
      const ad1 = await ingest(tx, ctxNoRule, await marketing());
      const ad2 = await ingest(tx, ctxNoRule, await marketing());
      const google = await ingest(tx, ctxNoRule, await message({ from: 'google-noreply@google.com', subject: 'Tips', body: 'Get more from Gmail.' }));
      const registrar = await ingest(tx, ctxNoRule, await message({ from: REGISTRAR, subject: 'Fwd: Complaint', body: 'Please log.' }));

      const out = await applySenderRule(tx, ctx, { confirm: false });
      expect(out).toEqual({
        listed: [REGISTRAR],
        bySender: [
          { sender: 'mail@mail.adobe.example', messages: 2 },
          { sender: 'google-noreply@google.com', messages: 1 },
        ],
        total: 3,
        unreadable: 0,
        applied: false,
      });
      for (const m of [ad1, ad2, google, registrar]) {
        expect((await stored(tx, m.mailMessageId)).status).toBe('unfiled');
      }

      // What the command prints: addresses and counts, never a subject or a word of a message.
      const printed = describeOutcome(out, false).join('\n');
      expect(printed).toContain('Would set aside 3 waiting message(s) from 2 other address(es)');
      expect(printed).toMatch(/2 {2}mail@mail\.adobe\.example/);
      expect(printed).toContain('Nothing was changed. Run again with --confirm');
      expect(printed).not.toMatch(/free trial|Tips|Fwd|Upgrade|Please log/i);
    });
  });

  it('with --confirm, sets aside only waiting mail from other addresses, with the reason', async () => {
    await asOfficer(async (tx) => {
      const ad = await ingest(tx, ctxNoRule, await marketing());
      const registrar = await ingest(tx, ctxNoRule, await message({ from: REGISTRAR, subject: 'Fwd: Complaint', body: 'Please log.' }));
      // Already on a case, and already set aside by the officer: neither is touched.
      const opened = await caseWaitingForDocuments(tx);
      const filed = await ingest(tx, ctxNoRule, await message({ from: 'patient@example.in', subject: `Re: [${opened.caseNumber}]`, body: 'Bills attached.' }));
      expect(filed.status).toBe('filed');
      const dismissed = await ingest(tx, ctxNoRule, await marketing());
      await mail.dismiss(tx, ctx, { mailMessageId: dismissed.mailMessageId, reason: 'Advertising.' });

      expect(parseArgs(['--', '--confirm'])).toEqual({ confirm: true });
      expect(parseArgs([])).toEqual({ confirm: false });
      expect(() => parseArgs(['--confirmed'])).toThrow(/Unknown option/);

      const out = await applySenderRule(tx, ctx, { confirm: true });
      expect(out).toMatchObject({ total: 1, applied: true, bySender: [{ sender: 'mail@mail.adobe.example', messages: 1 }] });
      expect(describeOutcome(out, true).join('\n')).toContain('Set aside 1 waiting message(s)');

      const setAside = await stored(tx, ad.mailMessageId);
      expect(setAside.status).toBe('dismissed');
      expect(setAside.dismissed_reason).toBe(
        `Not from ${REGISTRAR}, the only address complaints are forwarded from. ` +
          `Set aside automatically - bring it back if it is a complaint. ${SWITCHED_ON_SUFFIX}`,
      );
      expect((await stored(tx, registrar.mailMessageId)).status).toBe('unfiled');
      expect((await stored(tx, filed.mailMessageId)).status).toBe('filed');
      expect((await stored(tx, dismissed.mailMessageId)).dismissed_reason).toBe('Advertising.');

      // Marked as the rule's doing, as on arrival - which is what keeps a second run off it.
      expect(setAside.sender_check).toBe('not_allowed');

      // And it can be put back like anything else set aside...
      await mail.restore(tx, ctx, { mailMessageId: ad.mailMessageId });
      expect((await stored(tx, ad.mailMessageId)).status).toBe('unfiled');

      // ...and a second run leaves it where the officer put it.
      const again = await applySenderRule(tx, ctx, { confirm: true });
      expect(again).toMatchObject({ total: 0, applied: false, bySender: [] });
      expect(await stored(tx, ad.mailMessageId)).toMatchObject({ status: 'unfiled', dismissed_reason: null });
    });
  });

  it('never sets aside again a message set aside on arrival that the officer put back', async () => {
    await asOfficer(async (tx) => {
      // The rule is on: a patient writes directly, and is set aside on arrival...
      const direct = await ingest(
        tx,
        ctx,
        await message({ from: 'A Patient <patient@example.in>', subject: 'My complaint', body: 'My crown came off.' }),
      );
      expect(await stored(tx, direct.mailMessageId)).toMatchObject({ status: 'dismissed', sender_check: 'not_allowed' });
      // ...the officer sees it is a complaint and puts it back...
      await mail.restore(tx, ctx, { mailMessageId: direct.mailMessageId });

      // ...and the tidy-up, run afterwards, does not undo that.
      const dry = await applySenderRule(tx, ctx, { confirm: false });
      expect(dry.total).toBe(0);
      const out = await applySenderRule(tx, ctx, { confirm: true });
      expect(out).toMatchObject({ total: 0, applied: false });
      expect(await stored(tx, direct.mailMessageId)).toMatchObject({
        status: 'unfiled',
        dismissed_reason: null,
        sender_check: 'not_allowed',
      });
    });
  });

  it('never sets aside a "could not be read" card, and says how many there are', async () => {
    await asOfficer(async (tx) => {
      const meta = () => {
        const raw = Buffer.from(`unreadable ${++seq} ${Math.random()}`, 'utf8');
        return { mailbox: 'intake@srul.test/INBOX', uid: 5000 + ++seq, uidValidity: '1', raw };
      };
      // Not parsed at all: no sender is known ("unknown").
      const blank = await mail.recordUnreadable(tx, ctxNoRule, null, meta(), 'a malformed part');
      // Parsed, then failed later: it keeps a real sender, who is on no list.
      const parsedOther = await message({ from: 'A Patient <patient@example.in>', subject: 'Complaint', body: 'Please help.' });
      const named = await mail.recordUnreadable(tx, ctxNoRule, parsedOther.parsed, meta(), 'a storage error');
      const ad = await ingest(tx, ctxNoRule, await marketing());

      const dry = await applySenderRule(tx, ctx, { confirm: false });
      expect(dry).toMatchObject({ total: 1, unreadable: 2, bySender: [{ sender: 'mail@mail.adobe.example', messages: 1 }] });
      expect(describeOutcome(dry, false).join('\n')).toContain(
        'Left in the tray: 2 message(s) that could not be read automatically.',
      );

      const out = await applySenderRule(tx, ctx, { confirm: true });
      expect(out).toMatchObject({ total: 1, unreadable: 2, applied: true });
      expect((await stored(tx, ad.mailMessageId)).status).toBe('dismissed');
      for (const id of [blank!, named!]) {
        expect(await stored(tx, id)).toMatchObject({ status: 'unfiled', dismissed_reason: null });
      }
    });
  });

  it('does nothing at all when the council has no list', async () => {
    await asOfficer(async (tx) => {
      const ad = await ingest(tx, ctxNoRule, await marketing());
      const out = await applySenderRule(tx, ctxNoRule, { confirm: true });
      expect(out).toEqual({ listed: [], bySender: [], total: 0, unreadable: 0, applied: false });
      expect((await stored(tx, ad.mailMessageId)).status).toBe('unfiled');
      expect(describeOutcome(out, true).join('\n')).toMatch(/No sender rule is switched on/);
    });
  });
});
