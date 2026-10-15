import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import { closeDb, initDb, withCouncil, type Tx } from '@ksdc/db';
import { KSDC_CONFIG, type CouncilConfig } from '@ksdc/config';
import { CaseIntakeService } from '../cases/case-intake.service.js';
import { CaseLifecycleService } from '../cases/case-lifecycle.service.js';
import { CorrespondenceService } from '../correspondence/correspondence.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { FollowupService, type EngineContext } from '../followups/followup.service.js';
import { LocalStorage, STAGING_PREFIX } from '../documents/storage.js';
import { makeRespondent, seedCouncilAndOfficer } from '../../test-support/fixtures.js';
import { MailIntakeService } from './mail-intake.service.js';

/**
 * Copies of the Council's own letters arriving in the intake mailbox, against a real
 * database.
 *
 * The promise these tests hold the register to: a copy of a letter the Council sent is
 * NEVER recorded as a letter received and NEVER closes a reminder. It is attached to the
 * letter the case already records, or - only when the officer says so - records that letter.
 * Its case number is checked against the person it was sent to. Invented names throughout.
 */

const councilId = 'cc0a1111-1111-4111-8111-111111111111';
const officer = 'cc0a2222-2222-4222-8222-222222222222';
const MAILBOX = 'intake@ccpy.test/INBOX';

const followups = new FollowupService();
const lifecycle = new CaseLifecycleService(followups);
const intake = new CaseIntakeService(followups);
const correspondence = new CorrespondenceService(lifecycle, followups);
const storage = new LocalStorage();
const documents = new DocumentsService(storage);
const mail = new MailIntakeService(storage, intake, correspondence, documents, followups);

// No sender rule (intakeSenders) here: these messages come from test addresses, not the
// Registrar's, and are about everything else the tray does. The rule has its own tests in
// mail/sender-rule.test.ts.
const config: CouncilConfig = { ...KSDC_CONFIG, intakeSenders: [] };
const ctx: EngineContext = { councilId, userId: officer, config };

/** A one-pixel PNG: what the officer attached to the letter from the case. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** When the letters in these tests went out, and when their copies arrived. */
const SENT = new Date('2026-10-10T06:00:00Z');
const COPY_DATE = 'Sat, 11 Oct 2026 10:00:00 +0530';

beforeAll(async () => {
  initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId }, async (tx) => {
    await seedCouncilAndOfficer(tx, { councilId, officerId: officer, code: 'CCPY' });
    await tx.execute(sql`
      INSERT INTO council_config (council_id, config)
      VALUES (${councilId}::uuid, ${JSON.stringify(KSDC_CONFIG)}::jsonb)
      ON CONFLICT (council_id) DO UPDATE SET config = EXCLUDED.config
    `);
  });
  await withCouncil({ councilId, userId: officer }, (tx) => correspondence.seedTemplates(tx, ctx));
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
    await tx.execute(sql`UPDATE follow_up SET status = 'cancelled', resolution_note = 'test reset'
                         WHERE council_id = ${councilId}::uuid AND status IN ('open','snoozed')`);
  });
});

const asOfficer = <T>(fn: (tx: Tx) => Promise<T>) => withCouncil({ councilId, userId: officer }, fn);

let seq = 0;
/** An address nobody else in this file uses. */
const someone = (who: string) => `${who}.${++seq}.${randomUUID().slice(0, 6)}@example.in`;

const mime = (lines: string[]) => Buffer.from(lines.join('\r\n'), 'utf8');

async function ingest(tx: Tx, bytes: Buffer, mailbox = MAILBOX) {
  return mail.ingest(tx, ctx, await simpleParser(bytes), { mailbox, uid: ++seq, uidValidity: '1', raw: bytes });
}

/**
 * The officer forwarding a copy of a letter the Council sent to the intake address, as
 * Gmail lays a forward out. With a file attached, when given one.
 */
function forwardedCopy(args: {
  subject: string;
  to: string;
  file?: Buffer;
  /** When the forward itself was sent. */
  date?: string;
  /** The forwarded header's own date line, as Gmail writes it. */
  dateLine?: string;
}): Buffer {
  seq++;
  const text = [
    'For the record.',
    '',
    '---------- Forwarded message ---------',
    'From: Registrar CCPY <registrar@ccpy.test>',
    `Date: ${args.dateLine ?? 'Fri, 10 Oct 2026 at 11:30'}`,
    `Subject: ${args.subject}`,
    `To: ${args.to}`,
    '',
    'Sir/Madam, please send the bills, prescriptions and a timeline of your treatment.',
  ];
  const head = [
    'From: Registrar CCPY <registrar@ccpy.test>',
    'To: intake@ccpy.test',
    `Subject: Fwd: ${args.subject}`,
    `Message-ID: <copy-${seq}@ccpy.test>`,
    `Date: ${args.date ?? COPY_DATE}`,
  ];
  if (!args.file) {
    return mime([...head, 'Content-Type: text/plain; charset=utf-8', '', ...text]);
  }
  return mime([
    ...head,
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    ...text,
    '--b1',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="opg.png"',
    '',
    args.file.toString('base64'),
    '--b1--',
    '',
  ]);
}

/** A letter sent from Council webmail to a dentist, with the intake address in Cc. */
function ccCopy(args: { subject: string; to: string; date?: string }): Buffer {
  seq++;
  return mime([
    'From: Registrar CCPY <registrar@ccpy.test>',
    `To: ${args.to}`,
    'Cc: intake@ccpy.test',
    `Subject: ${args.subject}`,
    `Message-ID: <cc-${seq}@ccpy.test>`,
    `Date: ${args.date ?? COPY_DATE}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Dear Doctor, you are called upon to explain the treatment given.',
  ]);
}

async function openCase(tx: Tx, email: string, name = 'Kavya Rao') {
  return intake.create(tx, ctx, {
    summary: 'Crown came off',
    receivedAt: new Date('2026-09-20T04:00:00Z'),
    complainant: { fullName: name, email },
  });
}

/** The documents letter drafted on the case and confirmed sent - "I have sent this". */
async function sendDocumentsLetter(tx: Tx, caseFileId: string) {
  const draft = await correspondence.draft(tx, ctx, { caseFileId, kind: 'request_docs' });
  await correspondence.markSent(tx, ctx, { correspondenceId: draft.correspondenceId, sentAt: SENT });
  return draft;
}

const count = async (tx: Tx, query: ReturnType<typeof sql>) =>
  Number((await tx.execute<{ n: number }>(query)).rows[0]!.n);

const letters = (tx: Tx, caseFileId: string, direction?: 'in' | 'out') =>
  count(
    tx,
    sql`SELECT count(*)::int n FROM correspondence WHERE case_file_id = ${caseFileId}::uuid
        AND (${direction ?? null}::text IS NULL OR direction::text = ${direction ?? null})`,
  );

const milestones = (tx: Tx, caseFileId: string) =>
  count(tx, sql`SELECT count(*)::int n FROM case_milestone WHERE case_file_id = ${caseFileId}::uuid`);

const waitingForDocuments = async (tx: Tx, caseFileId: string) =>
  (await followups.liveForCase(tx, ctx, caseFileId)).some((f) => f.stage === 'await_patient_docs');

async function stored(tx: Tx, id: string) {
  const rows = await tx.execute<{
    status: string;
    case_file_id: string | null;
    correspondence_id: string | null;
    suggested_case_file_id: string | null;
  }>(sql`
    SELECT status::text, case_file_id, correspondence_id, suggested_case_file_id
    FROM mail_message WHERE id = ${id}::uuid
  `);
  return rows.rows[0]!;
}

describe('a copy of a letter the case already records as sent', () => {
  it('(a) files itself against that letter: no new letter, the reminder runs on, no second document', async () => {
    await asOfficer(async (tx) => {
      const email = someone('kavya');
      const opened = await openCase(tx, email);

      // The OPG on the case, which the officer attached to the letter from there.
      const key = `${STAGING_PREFIX}${randomUUID()}`;
      await storage.write(key, PNG, 'image/png');
      const doc = await documents.commit(tx, ctx, {
        caseFileId: opened.caseFileId,
        storageKey: key,
        title: 'OPG',
        originalFilename: 'opg.png',
      });

      const draft = await sendDocumentsLetter(tx, opened.caseFileId);
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);
      const before = await letters(tx, opened.caseFileId);

      const out = await ingest(tx, forwardedCopy({ subject: draft.subject, to: `Kavya Rao <${email}>`, file: PNG }));

      expect(out.councilCopy).toBe(true);
      expect(out.status).toBe('filed');
      expect(out.autoFiledTo).toBe(opened.caseFileId);
      expect(out.note).toMatch(/Filed as the copy of "Documents required - .*", recorded as sent on 10 Oct\./);

      const m = await stored(tx, out.mailMessageId);
      expect(m.correspondence_id).toBe(draft.correspondenceId);
      // Nothing new on the case: not a letter received, not a second letter sent.
      expect(await letters(tx, opened.caseFileId)).toBe(before);
      expect(await letters(tx, opened.caseFileId, 'in')).toBe(0);
      // The Council asking for documents is not the documents arriving.
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);

      // The same OPG is not filed a second time; the attachment points at the one there.
      const docs = await documents.listForCase(tx, ctx, opened.caseFileId);
      expect(docs).toHaveLength(1);
      const att = await tx.execute<{ document_id: string | null; skipped_reason: string | null }>(sql`
        SELECT document_id, skipped_reason FROM mail_attachment WHERE mail_message_id = ${out.mailMessageId}::uuid
      `);
      expect(att.rows[0]!.document_id).toBe(doc.documentId);
      expect(att.rows[0]!.skipped_reason).toMatch(/Already on the case/);
      // And it is not left for the reader to retry.
      expect(await mail.fileHeldAttachments(tx, ctx)).toBe(0);
    });
  });

  it('is NOT filed against that letter when the sender rule is on and Gmail could not confirm the sender', async () => {
    await asOfficer(async (tx) => {
      // The rule on (sender-rule.test.ts has the rest of it); this forward carries no
      // Authentication-Results from Gmail, so its Registrar address is unconfirmed.
      const ruleCtx: EngineContext = { ...ctx, config: { ...config, intakeSenders: ['registrar@ccpy.test'] } };
      const email = someone('kavya');
      const opened = await openCase(tx, email);
      const draft = await sendDocumentsLetter(tx, opened.caseFileId);
      const before = await letters(tx, opened.caseFileId);

      const bytes = forwardedCopy({ subject: draft.subject, to: `Kavya Rao <${email}>` });
      const out = await mail.ingest(tx, ruleCtx, await simpleParser(bytes), { mailbox: MAILBOX, uid: ++seq, uidValidity: '1', raw: bytes });

      expect(out).toMatchObject({ councilCopy: true, status: 'unfiled', autoFiledTo: null, senderCheck: 'unverified' });
      expect(out.note).toMatch(/^Gmail could not confirm that this came from the Council's own mail server/);
      expect(out.note).toMatch(/has not been filed there on its own/);
      const m = await stored(tx, out.mailMessageId);
      expect(m).toMatchObject({ status: 'unfiled', case_file_id: null, correspondence_id: null, suggested_case_file_id: opened.caseFileId });
      // Nothing on the case: no letter, no copy linked, and its reminder runs on.
      expect(await letters(tx, opened.caseFileId)).toBe(before);
      expect(await letters(tx, opened.caseFileId, 'in')).toBe(0);
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);
    });
  });
});

describe('a copy of a letter the case does not record', () => {
  it('(b) when the step was recorded with the step button only: tray, and record-only with the reason', async () => {
    await asOfficer(async (tx) => {
      const email = someone('arun');
      const opened = await openCase(tx, email);
      await lifecycle.apply(tx, ctx, {
        caseFileId: opened.caseFileId,
        event: 'REQUEST_DOCUMENTS',
        occurredAt: new Date('2026-10-09T06:00:00Z'),
      });

      const out = await ingest(
        tx,
        forwardedCopy({ subject: `Documents required - ${opened.caseNumber}`, to: email }),
      );
      expect(out.status).toBe('unfiled');
      // The card says what the page will offer: the step is taken, so the copy is put on
      // file - never "record it", which the page would then refuse.
      expect(out.note).toMatch(
        /already records this step \(documents asked for on 9 Oct\), so it is not recorded again - open the message to put the copy on file\./,
      );
      expect(out.note).not.toMatch(/no record of this letter/);
      expect((await stored(tx, out.mailMessageId)).suggested_case_file_id).toBe(opened.caseFileId);

      const plan = await mail.councilCopyPlan(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
      });
      expect(plan.check).toBe('confirmed');
      expect(plan.kind).toBe('request_docs');
      expect(plan.event).toBe('REQUEST_DOCUMENTS');
      expect(plan.eventAvailable).toBe(false);
      expect(plan.actions).toEqual(['record_only']);
      expect(plan.explanation).toMatch(/already moved past this step \(documents asked for on 9 Oct\)/);

      const outBefore = await letters(tx, opened.caseFileId, 'out');
      const milestonesBefore = await milestones(tx, opened.caseFileId);
      const filed = await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'record_only',
      });
      expect(filed.filedAs).toBe('record_only');
      expect(filed.transitioned).toBeNull();

      expect(await letters(tx, opened.caseFileId, 'out')).toBe(outBefore + 1);
      expect(await letters(tx, opened.caseFileId, 'in')).toBe(0);
      const row = await tx.execute<{ kind: string; sent_at: Date | null; to_email: string | null }>(sql`
        SELECT kind::text, sent_at, to_email FROM correspondence WHERE id = ${filed.correspondenceId}::uuid
      `);
      expect(row.rows[0]!.kind).toBe('request_docs');
      expect(row.rows[0]!.sent_at).not.toBeNull();
      expect(row.rows[0]!.to_email).toBe(email);
      expect(await milestones(tx, opened.caseFileId)).toBe(milestonesBefore);
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);
    });
  });

  it('(f) nothing recorded, case just received: "record it as sent" is the documents request itself', async () => {
    await asOfficer(async (tx) => {
      const email = someone('meera');
      const opened = await openCase(tx, email);
      const out = await ingest(
        tx,
        forwardedCopy({ subject: `Documents required - ${opened.caseNumber}`, to: email }),
      );
      expect(out.status).toBe('unfiled');

      const plan = await mail.councilCopyPlan(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
      });
      expect(plan.actions).toEqual(['record_sent', 'record_only']);
      expect(plan.eventAvailable).toBe(true);
      expect(plan.effect).toMatch(/starts the reminder for the documents, due in 7 working days/);

      const filed = await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'record_sent',
        sentAt: SENT,
      });
      expect(filed.transitioned).toBe('REQUEST_DOCUMENTS');

      const letter = await tx.execute<{ kind: string; direction: string; sent_at: Date }>(sql`
        SELECT kind::text, direction::text, sent_at FROM correspondence WHERE id = ${filed.correspondenceId}::uuid
      `);
      expect(letter.rows[0]).toMatchObject({ kind: 'request_docs', direction: 'out' });
      expect(new Date(letter.rows[0]!.sent_at).toISOString()).toBe(SENT.toISOString());

      const requested = await tx.execute<{ occurred_at: Date }>(sql`
        SELECT occurred_at FROM case_milestone
        WHERE case_file_id = ${opened.caseFileId}::uuid AND milestone = 'documents_requested'
      `);
      expect(new Date(requested.rows[0]!.occurred_at).toISOString()).toBe(SENT.toISOString());
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);
      expect((await stored(tx, out.mailMessageId)).correspondence_id).toBe(filed.correspondenceId);
    });
  });

  it('(g) a draft of it exists: recording it as sent uses the draft, not a second letter', async () => {
    await asOfficer(async (tx) => {
      const email = someone('farah');
      const opened = await openCase(tx, email);
      const draft = await correspondence.draft(tx, ctx, { caseFileId: opened.caseFileId, kind: 'request_docs' });

      const out = await ingest(tx, forwardedCopy({ subject: draft.subject, to: email }));
      expect(out.status).toBe('unfiled');
      const plan = await mail.councilCopyPlan(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
      });
      expect(plan.draft?.id).toBe(draft.correspondenceId);

      const filed = await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'record_sent',
        sentAt: SENT,
      });
      expect(filed.correspondenceId).toBe(draft.correspondenceId);
      expect(
        await count(
          tx,
          sql`SELECT count(*)::int n FROM correspondence
              WHERE case_file_id = ${opened.caseFileId}::uuid AND kind = 'request_docs'`,
        ),
      ).toBe(1);
    });
  });

  it('(h) a notice to a dentist: refused without the dentist, counted against them with one', async () => {
    await asOfficer(async (tx) => {
      const opened = await openCase(tx, someone('nisha'));
      await lifecycle.apply(tx, ctx, { caseFileId: opened.caseFileId, event: 'MARK_COMPLETE_ON_ARRIVAL' });
      const dentist = await makeRespondent(tx, { councilId, caseFileId: opened.caseFileId, name: 'Dr. P. Shetty' });

      const out = await ingest(
        tx,
        ccCopy({ subject: `Explanation called for - ${opened.caseNumber}`, to: `Dr. P. Shetty <${someone('shetty')}>` }),
      );
      expect(out.councilCopy).toBe(true);
      expect(out.status).toBe('unfiled');

      const plan = await mail.councilCopyPlan(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
      });
      expect(plan.needsRespondent).toBe(true);
      expect(plan.respondents.map((r) => r.id)).toEqual([dentist.caseRespondentId]);

      await expect(
        mail.fileCouncilCopy(tx, ctx, {
          mailMessageId: out.mailMessageId,
          caseFileId: opened.caseFileId,
          mode: 'record_sent',
          sentAt: SENT,
        }),
      ).rejects.toThrow(/which dentist/);

      const filed = await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'record_sent',
        sentAt: SENT,
        caseRespondentId: dentist.caseRespondentId,
      });
      expect(filed.transitioned).toBe('ISSUE_RESPONDENT_NOTICE');

      const notice = await tx.execute<{ service_mode: string; seq_no: number; correspondence_id: string }>(sql`
        SELECT service_mode::text, seq_no, correspondence_id FROM respondent_notice
        WHERE case_respondent_id = ${dentist.caseRespondentId}::uuid
      `);
      expect(notice.rows).toHaveLength(1);
      expect(notice.rows[0]).toMatchObject({ service_mode: 'email', seq_no: 1, correspondence_id: filed.correspondenceId });
      const count1 = await tx.execute<{ notice_count: number }>(sql`
        SELECT notice_count FROM case_respondent WHERE id = ${dentist.caseRespondentId}::uuid
      `);
      expect(Number(count1.rows[0]!.notice_count)).toBe(1);
    });
  });

  it('refuses a "sent" date that has not come yet', async () => {
    await asOfficer(async (tx) => {
      const email = someone('tara');
      const opened = await openCase(tx, email);
      const out = await ingest(tx, forwardedCopy({ subject: `Documents required - ${opened.caseNumber}`, to: email }));
      await expect(
        mail.fileCouncilCopy(tx, ctx, {
          mailMessageId: out.mailMessageId,
          caseFileId: opened.caseFileId,
          mode: 'record_only',
          sentAt: new Date(Date.now() + 3 * 86_400_000),
        }),
      ).rejects.toThrow(/has not come yet/);
    });
  });
});

describe('checking the case number against the person it was sent to', () => {
  it('(c) the number of one case, the recipient on another: not filed, both named, the quoted one first', async () => {
    await asOfficer(async (tx) => {
      const a = await openCase(tx, someone('anil'));
      const bEmail = someone('bhavya');
      const b = await openCase(tx, bEmail, 'Bhavya S');

      const out = await ingest(tx, forwardedCopy({ subject: `Documents required - ${a.caseNumber}`, to: bEmail }));
      expect(out.councilCopy).toBe(true);
      expect(out.status).toBe('unfiled');
      expect(out.autoFiledTo).toBeNull();
      expect(out.note).toContain(a.caseNumber);
      expect(out.note).toContain(b.caseNumber);
      expect(out.note).toContain(bEmail);
      expect(out.note).toMatch(/right person/);

      const page = await mail.get(tx, ctx, out.mailMessageId);
      expect(page!.candidates.map((c) => c.caseFileId)).toEqual([a.caseFileId, b.caseFileId]);
      expect((await stored(tx, out.mailMessageId)).suggested_case_file_id).toBe(a.caseFileId);
      expect(await letters(tx, a.caseFileId, 'in')).toBe(0);
      expect(await letters(tx, b.caseFileId, 'in')).toBe(0);

      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: a.caseFileId });
      expect(plan.check).toBe('mismatch');
      expect(plan.checkNote).toContain(b.caseNumber);
    });
  });

  it('(d) a recipient on file nowhere: tray, suggesting the quoted case, unchecked', async () => {
    await asOfficer(async (tx) => {
      const r = await openCase(tx, someone('ramesh'));
      const stranger = someone('stranger');
      const out = await ingest(tx, forwardedCopy({ subject: `Documents required - ${r.caseNumber}`, to: stranger }));
      expect(out.status).toBe('unfiled');
      expect(out.note).toMatch(/not on file on any case/);
      expect((await stored(tx, out.mailMessageId)).suggested_case_file_id).toBe(r.caseFileId);

      const card = (await mail.tray(tx, ctx)).find((c) => c.id === out.mailMessageId)!;
      expect(card.suggested_case_file_id).toBe(r.caseFileId);
      expect(card.councilCopy?.recipients.map((x) => x.email)).toEqual([stranger]);
      expect(card.complainant).toBeNull();

      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: r.caseFileId });
      expect(plan.check).toBe('unverified');
    });
  });

  it('(e) no number at all: the case the recipient is on is suggested, never filed to', async () => {
    await asOfficer(async (tx) => {
      const email = someone('sunil');
      const s = await openCase(tx, email);
      const out = await ingest(tx, forwardedCopy({ subject: 'Your complaint to the Council', to: email }));
      expect(out.status).toBe('unfiled');
      expect(out.note).toContain(`who is on ${s.caseNumber}`);
      expect((await stored(tx, out.mailMessageId)).suggested_case_file_id).toBe(s.caseFileId);
    });
  });
});

describe('the other buttons, on a copy', () => {
  it('(i) "Add to a case" never records a letter received and never closes a reminder', async () => {
    await asOfficer(async (tx) => {
      const email = someone('divya');
      const opened = await openCase(tx, email);
      await lifecycle.apply(tx, ctx, { caseFileId: opened.caseFileId, event: 'REQUEST_DOCUMENTS', occurredAt: SENT });
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);

      const out = await ingest(tx, forwardedCopy({ subject: `Documents required - ${opened.caseNumber}`, to: email }));
      await mail.fileOnCase(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });

      expect(await letters(tx, opened.caseFileId, 'in')).toBe(0);
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);
      const m = await stored(tx, out.mailMessageId);
      expect(m.status).toBe('filed');
      const linked = await tx.execute<{ direction: string }>(sql`
        SELECT direction::text FROM correspondence WHERE id = ${m.correspondence_id}::uuid
      `);
      expect(linked.rows[0]!.direction).toBe('out');
    });
  });

  it('(i) "Add to a case" attaches the copy to the recorded letter when there is one', async () => {
    await asOfficer(async (tx) => {
      const email = someone('gita');
      const opened = await openCase(tx, email);
      const draft = await sendDocumentsLetter(tx, opened.caseFileId);
      // The recipient's address is not on file anywhere, so it does not file itself...
      const out = await ingest(tx, forwardedCopy({ subject: draft.subject, to: `Kavya Rao <${someone('elsewhere')}>` }));
      expect(out.status).toBe('unfiled');
      // ...and the officer adds it to the case. The letter is the complainant's, and the copy
      // went to the complainant by name, so it is that letter beyond doubt. (To an address and
      // name that are nobody's, it might be another letter: see "a copy of one dentist's
      // notice", where "Add to a case" sends the officer to the message instead.)
      await mail.fileOnCase(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect((await stored(tx, out.mailMessageId)).correspondence_id).toBe(draft.correspondenceId);
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);
    });
  });

  it('(j) is never opened as a case', async () => {
    await asOfficer(async (tx) => {
      const out = await ingest(tx, forwardedCopy({ subject: 'Documents required', to: someone('hari') }));
      const before = await count(tx, sql`SELECT count(*)::int n FROM case_file WHERE council_id = ${councilId}::uuid`);
      await expect(mail.openCase(tx, ctx, { mailMessageId: out.mailMessageId })).rejects.toThrow(
        /copy of a letter the Council sent, not a complaint/,
      );
      expect(await count(tx, sql`SELECT count(*)::int n FROM case_file WHERE council_id = ${councilId}::uuid`)).toBe(before);
    });
  });

  it('is not read by the automatic assistant', async () => {
    await asOfficer(async (tx) => {
      const out = await ingest(tx, forwardedCopy({ subject: 'Documents required', to: someone('isha') }));
      expect(out.councilCopy).toBe(true);
      expect(await mail.isCouncilCopy(tx, ctx, out.mailMessageId)).toBe(true);
    });
  });
});

describe('what must not change', () => {
  it('(k) an office forward the unwrapper did not recognise is still a complaint waiting for its complainant', async () => {
    await asOfficer(async (tx) => {
      for (const mailbox of [MAILBOX, 'INBOX']) {
        seq++;
        const bytes = mime([
          'From: Registrar CCPY <registrar@ccpy.test>',
          'To: intake@ccpy.test',
          'Subject: Fwd: Treatment complaint',
          `Message-ID: <unreadable-${seq}@ccpy.test>`,
          'Date: Thu, 17 Sep 2026 12:02:00 +0530',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Please see below.',
          '',
          'The bridge fitted in August has come loose twice.',
        ]);
        const out = await ingest(tx, bytes, mailbox);
        expect(out.councilCopy).toBe(false);
        expect(out.status).toBe('unfiled');
        const card = (await mail.tray(tx, ctx)).find((c) => c.id === out.mailMessageId)!;
        expect(card.councilCopy).toBeNull();
        expect(card.complainant).toBeNull();
        await expect(mail.openCase(tx, ctx, { mailMessageId: out.mailMessageId })).rejects.toThrow(
          /Council's own address/,
        );
      }
    });
  });

  it("(l) a patient's reply quoting the number still files itself as received and answers the reminder", async () => {
    await asOfficer(async (tx) => {
      const email = someone('lakshmi');
      const opened = await openCase(tx, email);
      const draft = await sendDocumentsLetter(tx, opened.caseFileId);
      seq++;
      const out = await ingest(
        tx,
        mime([
          `From: Lakshmi <${email}>`,
          'To: intake@ccpy.test',
          `Subject: Re: ${draft.subject}`,
          `Message-ID: <reply-${seq}@example.in>`,
          'Date: Sun, 12 Oct 2026 09:00:00 +0530',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'The bills are attached.',
          '',
          '> Sir/Madam, please send the bills, prescriptions and a timeline.',
        ]),
      );
      expect(out.councilCopy).toBe(false);
      expect(out.autoFiledTo).toBe(opened.caseFileId);
      expect(await letters(tx, opened.caseFileId, 'in')).toBe(1);
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(false);
    });
  });
});

describe('the case page', () => {
  it('(m) never shows a copy of our letter as the complaint', async () => {
    await asOfficer(async (tx) => {
      // Opened by hand, from a paper letter: no mail on it yet.
      const email = someone('usha');
      const opened = await openCase(tx, email);

      const copy = await ingest(tx, forwardedCopy({ subject: `Documents required - ${opened.caseNumber}`, to: email }));
      await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: copy.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'record_only',
      });

      let rows = await mail.mailForCase(tx, ctx, opened.caseFileId);
      expect(rows.map((r) => [r.id, r.council_copy])).toEqual([[copy.mailMessageId, true]]);
      expect(rows.find((r) => !r.council_copy)).toBeUndefined();

      // The complainant's own email, filed later but sent earlier... or later: either way it
      // is the complaint, and it comes first.
      seq++;
      const own = await ingest(
        tx,
        mime([
          `From: Usha <${email}>`,
          'To: intake@ccpy.test',
          'Subject: My complaint about the crown',
          `Message-ID: <complaint-${seq}@example.in>`,
          'Date: Sun, 12 Oct 2026 09:00:00 +0530',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'The crown came off within a week.',
        ]),
      );
      await mail.fileOnCase(tx, ctx, { mailMessageId: own.mailMessageId, caseFileId: opened.caseFileId });

      rows = await mail.mailForCase(tx, ctx, opened.caseFileId);
      expect(rows[0]!.id).toBe(own.mailMessageId);
      expect(rows[0]!.council_copy).toBe(false);
      expect(rows[1]!.id).toBe(copy.mailMessageId);
      expect(rows[1]!.council_copy).toBe(true);
    });
  });
});

// ─── Found in review ─────────────────────────────────────────────────────────

/** A dentist named on the case, with an address on file when given one. */
async function dentist(tx: Tx, caseFileId: string, name: string, email?: string) {
  const d = await makeRespondent(tx, { councilId, caseFileId, name });
  if (email) await tx.execute(sql`UPDATE party SET email = ${email} WHERE id = ${d.partyId}::uuid`);
  return d;
}

const noticesTo = async (tx: Tx, caseRespondentId: string) =>
  Number(
    (
      await tx.execute<{ notice_count: number }>(sql`
        SELECT notice_count FROM case_respondent WHERE id = ${caseRespondentId}::uuid
      `)
    ).rows[0]!.notice_count,
  );

const waitingForExplanation = async (tx: Tx, caseFileId: string) =>
  (await followups.liveForCase(tx, ctx, caseFileId)).some((f) => f.stage === 'await_respondent_explanation');

/** A case past scrutiny, ready for a notice to a dentist. */
async function caseForNotices(tx: Tx, email = someone('comp')) {
  const opened = await openCase(tx, email);
  await lifecycle.apply(tx, ctx, { caseFileId: opened.caseFileId, event: 'MARK_COMPLETE_ON_ARRIVAL' });
  return opened;
}

/** "Explanation called for", drafted for one dentist and confirmed sent. */
async function sendNotice(tx: Tx, caseFileId: string, caseRespondentId: string, sentAt = SENT) {
  const draft = await correspondence.draft(tx, ctx, {
    caseFileId,
    kind: 'respondent_explanation_sought',
    caseRespondentId,
  });
  await correspondence.markSent(tx, ctx, { correspondenceId: draft.correspondenceId, sentAt, caseRespondentId });
  return draft;
}

/**
 * A reply written in Outlook, which quotes the letter it answers under a rule of
 * underscores, or under "-----Original Message-----" - From/Sent/To/Subject and all.
 */
function outlookReply(args: {
  subject: string;
  quotedTo: string;
  rule: 'underscores' | 'original_message';
  words: string;
}): string[] {
  return [
    args.words,
    '',
    args.rule === 'underscores' ? '________________________________' : '-----Original Message-----',
    'From: Registrar CCPY <registrar@ccpy.test>',
    'Sent: Friday, October 10, 2026 11:30 AM',
    `To: ${args.quotedTo}`,
    `Subject: ${args.subject}`,
    '',
    'Sir/Madam, please send the bills, prescriptions and a timeline of your treatment.',
  ];
}

describe('a reply that quotes our letter is a reply, whatever client wrote it', () => {
  for (const rule of ['underscores', 'original_message'] as const) {
    it(`a patient's Outlook reply (${rule}), sent directly: filed as received, the reminder closes`, async () => {
      await asOfficer(async (tx) => {
        const email = someone('ravi');
        const opened = await openCase(tx, email);
        const draft = await sendDocumentsLetter(tx, opened.caseFileId);
        expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);
        seq++;
        const out = await ingest(
          tx,
          mime([
            `From: Ravi Kumar <${email}>`,
            'To: Registrar CCPY <registrar@ccpy.test>',
            'Cc: intake@ccpy.test',
            `Subject: RE: ${draft.subject}`,
            `Message-ID: <outlook-${seq}@example.in>`,
            'Date: Sat, 11 Oct 2026 09:00:00 +0530',
            'Content-Type: text/plain; charset=utf-8',
            '',
            ...outlookReply({
              subject: draft.subject,
              quotedTo: `Ravi Kumar <${email}>`,
              rule,
              words: 'The bills you asked for are attached.',
            }),
          ]),
        );
        expect(out.councilCopy).toBe(false);
        expect(out.autoFiledTo).toBe(opened.caseFileId);
        expect(await letters(tx, opened.caseFileId, 'in')).toBe(1);
        expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(false);
      });
    });

    it(`the same reply (${rule}) forwarded by the office from Gmail: still a reply`, async () => {
      await asOfficer(async (tx) => {
        const email = someone('ravi');
        const opened = await openCase(tx, email);
        const draft = await sendDocumentsLetter(tx, opened.caseFileId);
        seq++;
        const out = await ingest(
          tx,
          mime([
            'From: Registrar CCPY <registrar@ccpy.test>',
            'To: intake@ccpy.test',
            `Subject: Fwd: RE: ${draft.subject}`,
            `Message-ID: <fwd-reply-${seq}@ccpy.test>`,
            'Date: Sat, 11 Oct 2026 10:00:00 +0530',
            'Content-Type: text/plain; charset=utf-8',
            '',
            '---------- Forwarded message ---------',
            `From: Ravi Kumar <${email}>`,
            'Date: Sat, 11 Oct 2026 at 09:00',
            `Subject: RE: ${draft.subject}`,
            'To: Registrar CCPY <registrar@ccpy.test>',
            '',
            ...outlookReply({
              subject: draft.subject,
              quotedTo: `Ravi Kumar <${email}>`,
              rule,
              words: 'The bills you asked for are attached.',
            }),
          ]),
        );
        expect(out.councilCopy).toBe(false);
        expect(out.autoFiledTo).toBe(opened.caseFileId);
        expect(await letters(tx, opened.caseFileId, 'in')).toBe(1);
        expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(false);
      });
    });
  }

  it("a dentist's Outlook explanation answers the notice it quotes", async () => {
    await asOfficer(async (tx) => {
      const opened = await caseForNotices(tx);
      const drEmail = someone('mehta');
      const dr = await dentist(tx, opened.caseFileId, 'Dr. S. Mehta', drEmail);
      const notice = await sendNotice(tx, opened.caseFileId, dr.caseRespondentId);
      expect(await waitingForExplanation(tx, opened.caseFileId)).toBe(true);
      seq++;
      const out = await ingest(
        tx,
        mime([
          `From: Dr. S. Mehta <${drEmail}>`,
          'To: intake@ccpy.test',
          `Subject: RE: ${notice.subject}`,
          `Message-ID: <expl-${seq}@clinic.example>`,
          'Date: Sat, 11 Oct 2026 09:00:00 +0530',
          'Content-Type: text/plain; charset=utf-8',
          '',
          ...outlookReply({
            subject: notice.subject,
            quotedTo: `Dr. S. Mehta <${drEmail}>`,
            rule: 'original_message',
            words: 'My explanation is as follows.',
          }),
        ]),
      );
      expect(out.councilCopy).toBe(false);
      expect(out.autoFiledTo).toBe(opened.caseFileId);
      expect(await waitingForExplanation(tx, opened.caseFileId)).toBe(false);
    });
  });

  it('the officer can say a message taken for a copy is not one, and file it as received', async () => {
    await asOfficer(async (tx) => {
      const email = someone('veena');
      const opened = await openCase(tx, email);
      await sendDocumentsLetter(tx, opened.caseFileId);
      const out = await ingest(tx, forwardedCopy({ subject: 'About my complaint', to: email }));
      expect(out.councilCopy).toBe(true);

      // The page says, before it is pressed, which reminders it will stop.
      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.waitingForReply.map((w) => w.stage)).toEqual(['await_patient_docs']);
      expect(plan.waitingForReply[0]!.label).toMatch(/Complainant to send bills/);

      await mail.fileOnCase(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        asReceived: true,
      });
      expect(await letters(tx, opened.caseFileId, 'in')).toBe(1);
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(false);

      // Recorded as what arrived: the forward's own text, never the Council as the sender
      // nor the Council's quoted letter as the words received.
      const received = await tx.execute<{ from_email: string | null; body: string }>(sql`
        SELECT from_email, body FROM correspondence
        WHERE case_file_id = ${opened.caseFileId}::uuid AND direction = 'in'
      `);
      expect(received.rows[0]!.from_email).toBeNull();
      expect(received.rows[0]!.body).toContain('For the record.');

      // And the answer is kept: the page no longer calls it the Council's letter.
      expect(await mail.isCouncilCopy(tx, ctx, out.mailMessageId)).toBe(false);
      const page = await mail.get(tx, ctx, out.mailMessageId);
      expect(page!.message.councilCopy).toBeNull();
    });
  });

  it('the answer outlives a cancelled case: back in the tray, it is not a copy again', async () => {
    await asOfficer(async (tx) => {
      const email = someone('veena');
      const first = await openCase(tx, email);
      const out = await ingest(tx, forwardedCopy({ subject: 'About my complaint', to: email }));
      await mail.fileOnCase(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: first.caseFileId, asReceived: true });

      await lifecycle.cancel(tx, ctx, { caseFileId: first.caseFileId, reason: 'Opened twice by mistake' });
      const card = (await mail.tray(tx, ctx)).find((c) => c.id === out.mailMessageId);
      expect(card).toBeDefined();
      expect(card!.councilCopy).toBeNull();

      // Filed again with the ordinary button, it goes on as received, with no second override.
      const second = await openCase(tx, email);
      await mail.fileOnCase(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: second.caseFileId });
      expect(await letters(tx, second.caseFileId, 'in')).toBe(1);
    });
  });
});


describe('a second copy of a letter already copied', () => {
  it('is never taken for an unrecorded letter: no second notice, no second letter', async () => {
    await asOfficer(async (tx) => {
      const opened = await caseForNotices(tx);
      const drEmail = someone('quadri');
      const dr = await dentist(tx, opened.caseFileId, 'Dr. Q. Quadri', drEmail);
      const notice = await sendNotice(tx, opened.caseFileId, dr.caseRespondentId);

      // The Cc copy files itself against the notice...
      const cc = await ingest(tx, ccCopy({ subject: notice.subject, to: `Dr. Q. Quadri <${drEmail}>` }));
      expect(cc.status).toBe('filed');
      expect((await stored(tx, cc.mailMessageId)).correspondence_id).toBe(notice.correspondenceId);
      const outBefore = await letters(tx, opened.caseFileId, 'out');

      // ...and the officer forwards the same letter for the record as well.
      const fwd = await ingest(tx, forwardedCopy({ subject: notice.subject, to: `Dr. Q. Quadri <${drEmail}>` }));
      expect(fwd.status).toBe('unfiled');
      expect(fwd.note).toMatch(/a copy of it is already on file/);
      expect(fwd.note).not.toMatch(/no record/);

      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: fwd.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.actions).toEqual(['link']);
      expect(plan.recordedLetter).toMatchObject({ id: notice.correspondenceId, how: 'already_copied' });
      expect(plan.explanation).not.toMatch(/no record/);

      // Recording it again is refused, however it is asked for.
      for (const mode of ['record_sent', 'record_only'] as const) {
        await expect(
          tx.transaction((sp) =>
            mail.fileCouncilCopy(sp, ctx, {
              mailMessageId: fwd.mailMessageId,
              caseFileId: opened.caseFileId,
              mode,
              caseRespondentId: dr.caseRespondentId,
            }),
          ),
        ).rejects.toThrow(/now records this letter as sent/);
      }
      // "Add to a case" puts it with the first copy.
      await mail.fileOnCase(tx, ctx, { mailMessageId: fwd.mailMessageId, caseFileId: opened.caseFileId });
      expect((await stored(tx, fwd.mailMessageId)).correspondence_id).toBe(notice.correspondenceId);
      expect(await noticesTo(tx, dr.caseRespondentId)).toBe(1);
      expect(await letters(tx, opened.caseFileId, 'out')).toBe(outBefore);
    });
  });
});

describe('who a letter went to', () => {
  it("two notices of one kind on one day: each copy goes with its own dentist's letter", async () => {
    await asOfficer(async (tx) => {
      const opened = await caseForNotices(tx);
      const alphaEmail = someone('alpha');
      const betaEmail = someone('beta');
      const alpha = await dentist(tx, opened.caseFileId, 'Dr. Alpha', alphaEmail);
      const beta = await dentist(tx, opened.caseFileId, 'Dr. Beta', betaEmail);
      const toAlpha = await sendNotice(tx, opened.caseFileId, alpha.caseRespondentId);
      const toBeta = await sendNotice(tx, opened.caseFileId, beta.caseRespondentId);

      const betaCopy = await ingest(tx, ccCopy({ subject: toBeta.subject, to: `Dr. Beta <${betaEmail}>` }));
      expect(betaCopy.status).toBe('filed');
      expect((await stored(tx, betaCopy.mailMessageId)).correspondence_id).toBe(toBeta.correspondenceId);

      const alphaCopy = await ingest(tx, ccCopy({ subject: toAlpha.subject, to: `Dr. Alpha <${alphaEmail}>` }));
      expect(alphaCopy.status).toBe('filed');
      expect((await stored(tx, alphaCopy.mailMessageId)).correspondence_id).toBe(toAlpha.correspondenceId);
    });
  });

  it('two notices nothing tells apart are a question for the officer, not filed by themselves', async () => {
    await asOfficer(async (tx) => {
      const opened = await caseForNotices(tx);
      const alpha = await dentist(tx, opened.caseFileId, 'Dr. Alpha');
      const beta = await dentist(tx, opened.caseFileId, 'Dr. Beta');
      await sendNotice(tx, opened.caseFileId, alpha.caseRespondentId);
      const toBeta = await sendNotice(tx, opened.caseFileId, beta.caseRespondentId);
      // Recorded against the case by the address it went to, so the number is confirmed -
      // but under no name, either notice could be the one.
      const clinic = someone('clinic');
      await tx.execute(sql`
        UPDATE correspondence SET to_email = ${clinic}
        WHERE case_file_id = ${opened.caseFileId}::uuid AND kind = 'respondent_explanation_sought'
      `);
      const out = await ingest(tx, ccCopy({ subject: toBeta.subject, to: clinic }));
      expect(out.councilCopy).toBe(true);
      expect(out.status).toBe('unfiled');
      expect(out.note).toMatch(/more than one letter like/);
    });
  });

  it("record it as sent uses the draft written to the dentist picked, never another dentist's", async () => {
    await asOfficer(async (tx) => {
      const opened = await caseForNotices(tx);
      const alphaEmail = someone('alpha');
      const betaEmail = someone('beta');
      const alpha = await dentist(tx, opened.caseFileId, 'Dr. Alpha', alphaEmail);
      const beta = await dentist(tx, opened.caseFileId, 'Dr. Beta', betaEmail);
      // Beta's drafted first, so Alpha's is the newer draft.
      const betaDraft = await correspondence.draft(tx, ctx, {
        caseFileId: opened.caseFileId,
        kind: 'respondent_explanation_sought',
        caseRespondentId: beta.caseRespondentId,
      });
      const alphaDraft = await correspondence.draft(tx, ctx, {
        caseFileId: opened.caseFileId,
        kind: 'respondent_explanation_sought',
        caseRespondentId: alpha.caseRespondentId,
      });

      const out = await ingest(tx, ccCopy({ subject: betaDraft.subject, to: `Dr. Beta <${betaEmail}>` }));
      expect(out.status).toBe('unfiled');
      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.actions[0]).toBe('record_sent');
      expect(plan.draft?.id).toBe(betaDraft.correspondenceId);
      // The picker starts on the dentist the copy went to.
      expect(plan.respondents.filter((r) => r.sentTo).map((r) => r.id)).toEqual([beta.caseRespondentId]);

      const filed = await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'record_sent',
        sentAt: SENT,
        caseRespondentId: beta.caseRespondentId,
      });
      expect(filed.correspondenceId).toBe(betaDraft.correspondenceId);

      const rows = await tx.execute<{ id: string; sent_at: Date | null; to_email: string | null }>(sql`
        SELECT id, sent_at, to_email FROM correspondence
        WHERE case_file_id = ${opened.caseFileId}::uuid AND kind = 'respondent_explanation_sought'
      `);
      expect(rows.rows).toHaveLength(2);
      const byId = new Map(rows.rows.map((r) => [r.id, r]));
      expect(byId.get(betaDraft.correspondenceId)!.sent_at).not.toBeNull();
      expect(byId.get(betaDraft.correspondenceId)!.to_email).toBe(betaEmail);
      expect(byId.get(alphaDraft.correspondenceId)!.sent_at).toBeNull();
      expect(byId.get(alphaDraft.correspondenceId)!.to_email).toBeNull();

      const notice = await tx.execute<{ correspondence_id: string }>(sql`
        SELECT correspondence_id FROM respondent_notice WHERE case_respondent_id = ${beta.caseRespondentId}::uuid
      `);
      expect(notice.rows.map((r) => r.correspondence_id)).toEqual([betaDraft.correspondenceId]);
      expect(await noticesTo(tx, alpha.caseRespondentId)).toBe(0);
      expect(await noticesTo(tx, beta.caseRespondentId)).toBe(1);
    });
  });

  it('a hearing notice is the one to the side of the case it went to', async () => {
    await asOfficer(async (tx) => {
      const complainantEmail = someone('comp');
      const opened = await caseForNotices(tx, complainantEmail);
      const drEmail = someone('dr');
      await dentist(tx, opened.caseFileId, 'Dr. Hearing', drEmail);
      const subject = `Hearing before the Ethical Committee - ${opened.caseNumber}`;

      const toDentist = await ingest(tx, ccCopy({ subject, to: drEmail }));
      let plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: toDentist.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.kind).toBe('summons_respondent');
      expect(plan.kindOptions).toEqual([]);

      const toComplainant = await ingest(tx, ccCopy({ subject, to: complainantEmail }));
      plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: toComplainant.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.kind).toBe('summons_complainant');

      // To somebody on neither side: the officer is asked which, and the answer is used.
      const toStranger = await ingest(tx, ccCopy({ subject, to: someone('stranger') }));
      plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: toStranger.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.kindOptions.map((o) => o.kind)).toEqual(['summons_complainant', 'summons_respondent']);
      // Never a guess while the question is open.
      expect(plan.kind).toBeNull();
      expect(plan.kindLabel).toBeNull();
      plan = await mail.councilCopyPlan(tx, ctx, {
        mailMessageId: toStranger.mailMessageId,
        caseFileId: opened.caseFileId,
        kind: 'summons_respondent',
      });
      expect(plan.kind).toBe('summons_respondent');
      // Still offered once answered, so a wrong answer can be changed on the page.
      expect(plan.kindOptions.map((o) => o.kind)).toEqual(['summons_complainant', 'summons_respondent']);
      // An answer that is neither letter is not taken.
      plan = await mail.councilCopyPlan(tx, ctx, {
        mailMessageId: toStranger.mailMessageId,
        caseFileId: opened.caseFileId,
        kind: 'request_docs',
      });
      expect(plan.kind).toBeNull();
    });
  });

  it("with the question open nothing records it, and the complainant's own draft is never closed off", async () => {
    await asOfficer(async (tx) => {
      const complainantEmail = someone('comp');
      const opened = await caseForNotices(tx, complainantEmail);
      await dentist(tx, opened.caseFileId, 'Dr. Hearing', someone('dr'));
      const complainantDraft = await correspondence.draft(tx, ctx, {
        caseFileId: opened.caseFileId,
        kind: 'summons_complainant',
      });
      // The dentist's hearing notice, sent to the clinic's address, which is on file nowhere.
      const out = await ingest(tx, ccCopy({ subject: complainantDraft.subject, to: someone('clinic') }));
      expect(out.status).toBe('unfiled');

      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.kind).toBeNull();
      expect(plan.explanation).toMatch(/Say which letter it is/);

      for (const file of [
        (sp: Tx) => mail.fileOnCase(sp, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId }),
        (sp: Tx) =>
          mail.fileCouncilCopy(sp, ctx, {
            mailMessageId: out.mailMessageId,
            caseFileId: opened.caseFileId,
            mode: 'record_only',
            sentAt: SENT,
          }),
      ]) {
        await expect(tx.transaction((sp) => file(sp))).rejects.toThrow(/say which letter it is/);
      }
      const draft = await tx.execute<{ sent_at: Date | null }>(sql`
        SELECT sent_at FROM correspondence WHERE id = ${complainantDraft.correspondenceId}::uuid
      `);
      expect(draft.rows[0]!.sent_at).toBeNull();

      // Answered, it is filed as the dentist's notice, and the complainant's draft is left alone.
      const filed = await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'record_only',
        sentAt: SENT,
        kind: 'summons_respondent',
      });
      expect(filed.correspondenceId).not.toBe(complainantDraft.correspondenceId);
      const row = await tx.execute<{ kind: string }>(sql`
        SELECT kind::text FROM correspondence WHERE id = ${filed.correspondenceId}::uuid
      `);
      expect(row.rows[0]!.kind).toBe('summons_respondent');
    });
  });

});

describe('the recipient against the quoted case', () => {
  it('is checked on that case directly, however many other cases they are on', async () => {
    await asOfficer(async (tx) => {
      const email = someone('frequent');
      const quoted = await openCase(tx, email);
      for (let i = 0; i < 6; i++) await openCase(tx, email);
      // The quoted case ranks last of the seven.
      await tx.execute(sql`UPDATE case_file SET waiting_since = '2026-01-01' WHERE id = ${quoted.caseFileId}::uuid`);
      await sendDocumentsLetter(tx, quoted.caseFileId);

      const out = await ingest(tx, forwardedCopy({ subject: `Documents required - ${quoted.caseNumber}`, to: email }));
      expect(out.note).not.toMatch(/right person/);
      expect(out.autoFiledTo).toBe(quoted.caseFileId);
    });
  });

  it('an address only written to before on another case does not contradict the number', async () => {
    await asOfficer(async (tx) => {
      const authority = someone('health.dept');
      const r1 = await openCase(tx, someone('one'));
      const r2 = await openCase(tx, someone('two'));
      // A copy of a letter to the authority, put on R1: R1 now has a letter to that address.
      const first = await ingest(tx, forwardedCopy({ subject: `Reply to your reference - ${r1.caseNumber}`, to: authority }));
      await mail.fileCouncilCopy(tx, ctx, { mailMessageId: first.mailMessageId, caseFileId: r1.caseFileId, mode: 'record_only' });

      const second = await ingest(tx, forwardedCopy({ subject: `Reply to your reference - ${r2.caseNumber}`, to: authority }));
      expect(second.note).not.toMatch(/right person/);
      expect(second.note).toContain(r2.caseNumber);
      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: second.mailMessageId, caseFileId: r2.caseFileId });
      expect(plan.check).toBe('unverified');
      expect(plan.checkNote).not.toMatch(/right person/);
    });
  });
});

describe('when a forward is the only date there is', () => {
  it("a forward's own date line names the day: filed against the letter sent that day", async () => {
    await asOfficer(async (tx) => {
      const email = someone('late');
      const opened = await openCase(tx, email);
      const draft = await sendDocumentsLetter(tx, opened.caseFileId);
      // Forwarded three weeks after it went out.
      const out = await ingest(
        tx,
        forwardedCopy({ subject: draft.subject, to: email, date: 'Fri, 31 Oct 2026 10:00:00 +0530' }),
      );
      expect(out.status).toBe('filed');
      expect((await stored(tx, out.mailMessageId)).correspondence_id).toBe(draft.correspondenceId);
      const page = await mail.get(tx, ctx, out.mailMessageId);
      const copy = page!.message.councilCopy as { copyDate: Date; copyDateBasis: string };
      expect(new Date(copy.copyDate).toISOString()).toBe('2026-10-10T06:00:00.000Z');
      expect(copy.copyDateBasis).toBe('stated_day');
    });
  });

  it('a late forward with no readable day is offered the earlier letter, never "no record"', async () => {
    await asOfficer(async (tx) => {
      const opened = await caseForNotices(tx);
      const drEmail = someone('late.dr');
      const dr = await dentist(tx, opened.caseFileId, 'Dr. Late', drEmail);
      const notice = await sendNotice(tx, opened.caseFileId, dr.caseRespondentId);
      const out = await ingest(
        tx,
        forwardedCopy({
          subject: notice.subject,
          to: drEmail,
          date: 'Fri, 31 Oct 2026 10:00:00 +0530',
          dateLine: '10/10/2026 11:30',
        }),
      );
      expect(out.status).toBe('unfiled');
      expect(out.note).toMatch(/records a letter like this as sent on 10 Oct, more than a fortnight earlier/);
      expect(out.note).not.toMatch(/no record/);

      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.copyDateBasis).toBe('forwarded');
      expect(plan.recordedLetter).toMatchObject({ id: notice.correspondenceId, how: 'earlier' });
      // Linking first; recording a second notice is there, but never the recommendation.
      expect(plan.actions[0]).toBe('link');
      expect(plan.explanation).not.toMatch(/no record/);
      expect(plan.explanation).toContain('10/10/2026 11:30');

      // Whether it is that letter is the officer's to say: "Add to a case" does not guess.
      await expect(
        tx.transaction((sp) =>
          mail.fileOnCase(sp, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId }),
        ),
      ).rejects.toThrow(/say whether this is the copy of that letter or a new one/);
      await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'link',
      });
      expect((await stored(tx, out.mailMessageId)).correspondence_id).toBe(notice.correspondenceId);
      expect(await noticesTo(tx, dr.caseRespondentId)).toBe(1);
    });
  });

  it("a copy that shows only when it was forwarded is not put on file with the forward's day", async () => {
    await asOfficer(async (tx) => {
      const email = someone('undated');
      const opened = await openCase(tx, email);
      const out = await ingest(
        tx,
        forwardedCopy({
          subject: `Documents required - ${opened.caseNumber}`,
          to: email,
          date: 'Fri, 03 Oct 2026 10:00:00 +0530',
          dateLine: '18/09/2026 10:02',
        }),
      );
      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.copyDateBasis).toBe('forwarded');
      expect(plan.actions).toContain('record_only');
      const outBefore = await letters(tx, opened.caseFileId, 'out');

      await expect(
        tx.transaction((sp) =>
          mail.fileOnCase(sp, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId }),
        ),
      ).rejects.toThrow(/enter the day it was sent/);
      expect(await letters(tx, opened.caseFileId, 'out')).toBe(outBefore);

      // With the day the officer gives, it goes on.
      const filed = await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'record_only',
        sentAt: new Date('2026-09-18T06:00:00Z'),
      });
      const row = await tx.execute<{ sent_at: Date }>(sql`
        SELECT sent_at FROM correspondence WHERE id = ${filed.correspondenceId}::uuid
      `);
      expect(new Date(row.rows[0]!.sent_at).toISOString()).toBe('2026-09-18T06:00:00.000Z');
    });
  });
});


describe('a page that is out of date', () => {
  it('cannot record a notice the case has recorded since the page was loaded', async () => {
    await asOfficer(async (tx) => {
      const opened = await caseForNotices(tx);
      const drEmail = someone('stale');
      const dr = await dentist(tx, opened.caseFileId, 'Dr. Stale', drEmail);
      const draft = await correspondence.draft(tx, ctx, {
        caseFileId: opened.caseFileId,
        kind: 'respondent_explanation_sought',
        caseRespondentId: dr.caseRespondentId,
      });
      const out = await ingest(tx, ccCopy({ subject: draft.subject, to: drEmail }));
      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.actions[0]).toBe('record_sent');

      // In another tab: "I have sent this".
      await correspondence.markSent(tx, ctx, {
        correspondenceId: draft.correspondenceId,
        sentAt: SENT,
        caseRespondentId: dr.caseRespondentId,
      });
      const outBefore = await letters(tx, opened.caseFileId, 'out');

      // Back on the stale page.
      await expect(
        tx.transaction((sp) =>
          mail.fileCouncilCopy(sp, ctx, {
            mailMessageId: out.mailMessageId,
            caseFileId: opened.caseFileId,
            mode: 'record_sent',
            sentAt: SENT,
            caseRespondentId: dr.caseRespondentId,
          }),
        ),
      ).rejects.toThrow(/now records this letter as sent/);
      expect(await noticesTo(tx, dr.caseRespondentId)).toBe(1);
      expect(await letters(tx, opened.caseFileId, 'out')).toBe(outBefore);
    });
  });

  it('a draft does not make a step the case has moved past recordable', async () => {
    await asOfficer(async (tx) => {
      const email = someone('moved');
      const opened = await openCase(tx, email);
      const draft = await correspondence.draft(tx, ctx, { caseFileId: opened.caseFileId, kind: 'request_docs' });
      // The step recorded with the step button; the draft left unsent.
      await lifecycle.apply(tx, ctx, {
        caseFileId: opened.caseFileId,
        event: 'REQUEST_DOCUMENTS',
        occurredAt: new Date('2026-10-09T06:00:00Z'),
      });
      const out = await ingest(tx, forwardedCopy({ subject: draft.subject, to: email }));
      expect(out.note).toMatch(/already records this step/);

      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.actions).toEqual(['record_only']);
      expect(plan.explanation).toMatch(/already moved past this step/);
      await expect(
        tx.transaction((sp) =>
          mail.fileCouncilCopy(sp, ctx, {
            mailMessageId: out.mailMessageId,
            caseFileId: opened.caseFileId,
            mode: 'record_sent',
            sentAt: SENT,
          }),
        ),
      ).rejects.toThrow(/already moved past this step/);

      // Filed as a letter sent, the draft is that letter: one row, now sent, nothing moved.
      const milestonesBefore = await milestones(tx, opened.caseFileId);
      const filed = await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'record_only',
        sentAt: SENT,
      });
      expect(filed.correspondenceId).toBe(draft.correspondenceId);
      expect(
        await count(
          tx,
          sql`SELECT count(*)::int n FROM correspondence
              WHERE case_file_id = ${opened.caseFileId}::uuid AND kind = 'request_docs'`,
        ),
      ).toBe(1);
      expect(await milestones(tx, opened.caseFileId)).toBe(milestonesBefore);
    });
  });

  it('"Add to a case" closes off the draft, so "I have sent this" cannot record the letter twice', async () => {
    await asOfficer(async (tx) => {
      const email = someone('quick');
      const opened = await openCase(tx, email);
      const draft = await correspondence.draft(tx, ctx, { caseFileId: opened.caseFileId, kind: 'request_docs' });
      const out = await ingest(tx, forwardedCopy({ subject: draft.subject, to: email }));
      await mail.fileOnCase(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });

      expect((await stored(tx, out.mailMessageId)).correspondence_id).toBe(draft.correspondenceId);
      expect(
        await count(
          tx,
          sql`SELECT count(*)::int n FROM correspondence
              WHERE case_file_id = ${opened.caseFileId}::uuid AND kind = 'request_docs'`,
        ),
      ).toBe(1);
      // Never a reminder started by "Add to a case".
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(false);
      await expect(
        tx.transaction((sp) => correspondence.markSent(sp, ctx, { correspondenceId: draft.correspondenceId, sentAt: SENT })),
      ).rejects.toThrow(/already recorded as sent/);
    });
  });
});

describe('a copy back from a cancelled case', () => {
  it('loses the "already on the case" reason once its file becomes a document of the next case', async () => {
    await asOfficer(async (tx) => {
      const email = someone('moved.file');
      const first = await openCase(tx, email);
      const key = `${STAGING_PREFIX}${randomUUID()}`;
      await storage.write(key, PNG, 'image/png');
      await documents.commit(tx, ctx, { caseFileId: first.caseFileId, storageKey: key, title: 'OPG', originalFilename: 'opg.png' });
      const draft = await sendDocumentsLetter(tx, first.caseFileId);

      const out = await ingest(tx, forwardedCopy({ subject: draft.subject, to: email, file: PNG }));
      expect(out.status).toBe('filed');
      const attachment = async () =>
        (
          await tx.execute<{ document_id: string | null; skipped_reason: string | null }>(sql`
            SELECT document_id, skipped_reason FROM mail_attachment WHERE mail_message_id = ${out.mailMessageId}::uuid
          `)
        ).rows[0]!;
      expect((await attachment()).skipped_reason).toMatch(/Already on the case/);

      await lifecycle.cancel(tx, ctx, { caseFileId: first.caseFileId, reason: 'Opened twice by mistake' });
      const second = await openCase(tx, email);
      await mail.fileOnCase(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: second.caseFileId });

      const after = await attachment();
      expect(after.skipped_reason).toBeNull();
      const onSecond = await documents.listForCase(tx, ctx, second.caseFileId);
      expect(onSecond).toHaveLength(1);
      expect(after.document_id).toBe(onSecond[0]!.id);
    });
  });
});

// ─── Found in the second review ──────────────────────────────────────────────

/**
 * Roundcube's text part for a forward in HTML compose - the layout of the Council's own
 * webmail - which draws no separator above the forwarded message's header rows.
 */
function roundcubeForward(args: { subject: string; from: string; to: string; body: string[] }): Buffer {
  seq++;
  const row = (label: string, value: string) => [` \t\t${label}:`, ` \t\t${value}`, ''];
  return mime([
    'From: Registrar CCPY <registrar@ccpy.test>',
    'To: intake@ccpy.test',
    `Subject: Fwd: ${args.subject}`,
    `Message-ID: <rc-${seq}@ccpy.test>`,
    'Date: Sat, 11 Oct 2026 10:00:00 +0530',
    'Content-Type: text/plain; charset=utf-8',
    '',
    ...row('SUBJECT', args.subject),
    ...row('DATE', '2026-10-11 09:00'),
    ...row('FROM', args.from),
    ...row('TO', args.to),
    ...args.body,
  ]);
}

describe('a reply forwarded from the Council webmail, which draws no rule of its own', () => {
  for (const rule of ['underscores', 'original_message'] as const) {
    it(`a patient's Outlook reply (${rule}) forwarded from Roundcube is still a reply`, async () => {
      await asOfficer(async (tx) => {
        const email = someone('ravi');
        const opened = await openCase(tx, email);
        const draft = await sendDocumentsLetter(tx, opened.caseFileId);
        expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);

        const out = await ingest(
          tx,
          roundcubeForward({
            subject: `RE: ${draft.subject}`,
            from: `Ravi Kumar <${email}>`,
            to: 'Registrar CCPY <registrar@ccpy.test>',
            body: outlookReply({
              subject: draft.subject,
              quotedTo: `Ravi Kumar <${email}>`,
              rule,
              words: 'The bills you asked for are attached.',
            }),
          }),
        );
        expect(out.councilCopy).toBe(false);
        expect(out.autoFiledTo).toBe(opened.caseFileId);
        expect(await letters(tx, opened.caseFileId, 'in')).toBe(1);
        expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(false);
      });
    });
  }
});

describe('a complaint the register took for a copy of our letter', () => {
  it('can be opened as a case on the officer\'s word, recorded as what arrived', async () => {
    await asOfficer(async (tx) => {
      const asha = someone('asha');
      // Forwarded by the office, in a layout the register reads as the Council's own letter
      // to the complainant (the Council's earlier mail quoted under the complaint).
      const out = await ingest(tx, forwardedCopy({ subject: 'Your enquiry', to: `Asha Rao <${asha}>` }));
      expect(out.councilCopy).toBe(true);

      await expect(
        tx.transaction((sp) => mail.openCase(sp, ctx, { mailMessageId: out.mailMessageId })),
      ).rejects.toThrow(/copy of a letter the Council sent, not a complaint/);

      const opened = await mail.openCase(tx, ctx, {
        mailMessageId: out.mailMessageId,
        asComplaint: true,
        summary: 'Overcharged for a root canal',
        complainantName: 'Asha Rao',
        complainantEmail: asha,
      });
      const received = await tx.execute<{ from_email: string | null; body: string }>(sql`
        SELECT from_email, body FROM correspondence
        WHERE case_file_id = ${opened.caseFileId}::uuid AND direction = 'in'
      `);
      expect(received.rows).toHaveLength(1);
      expect(received.rows[0]!.from_email).toBeNull();
      expect(received.rows[0]!.body).toContain('For the record.');
      expect(await mail.isCouncilCopy(tx, ctx, out.mailMessageId)).toBe(false);
    });
  });

  it("still never opens one in the Council's own name", async () => {
    await asOfficer(async (tx) => {
      const out = await ingest(tx, forwardedCopy({ subject: 'Your enquiry', to: someone('asha') }));
      const before = await count(tx, sql`SELECT count(*)::int n FROM case_file WHERE council_id = ${councilId}::uuid`);
      await expect(
        tx.transaction((sp) =>
          mail.openCase(sp, ctx, { mailMessageId: out.mailMessageId, asComplaint: true, complainantName: '' }),
        ),
      ).rejects.toThrow(/Council's own address/);
      expect(await count(tx, sql`SELECT count(*)::int n FROM case_file WHERE council_id = ${councilId}::uuid`)).toBe(
        before,
      );
    });
  });
});

describe('a letter the Council sends that forwards something', () => {
  it('the complaint forwarded on to the dentist, intake in Cc, is our letter, not the complaint arriving', async () => {
    await asOfficer(async (tx) => {
      const email = someone('patient');
      const opened = await openCase(tx, email);
      await sendDocumentsLetter(tx, opened.caseFileId);
      const drEmail = someone('mehta');
      await dentist(tx, opened.caseFileId, 'Dr. Mehta', drEmail);
      seq++;
      const out = await ingest(
        tx,
        mime([
          'From: Registrar CCPY <registrar@ccpy.test>',
          `To: Dr Mehta <${drEmail}>`,
          'Cc: intake@ccpy.test',
          `Subject: Fwd: Complaint against you - ${opened.caseNumber}`,
          `Message-ID: <onward-${seq}@ccpy.test>`,
          'Date: Sat, 11 Oct 2026 10:00:00 +0530',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Dear Doctor, the complaint below has been received against you.',
          '',
          '---------- Forwarded message ---------',
          `From: Kavya Rao <${email}>`,
          'Date: Sat, 20 Sep 2026 at 09:00',
          'Subject: Complaint about my crown',
          'To: <registrar@ccpy.test>',
          '',
          'The crown came off within a week.',
        ]),
      );
      expect(out.councilCopy).toBe(true);
      expect(out.status).toBe('unfiled');
      expect(await letters(tx, opened.caseFileId, 'in')).toBe(0);
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(true);

      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.recipients.map((r) => r.email)).toEqual([drEmail]);
      expect(plan.check).toBe('confirmed');
      // Dated by its own sending, not by the complaint it carries.
      expect(plan.copyDateBasis).toBe('exact');
      expect(new Date(plan.copyDate).toISOString()).toBe('2026-10-11T04:30:00.000Z');
      expect(plan.dateText).toBeNull();
    });
  });

  it('the office forwarding to the intake mailbox alone stays what it was', async () => {
    await asOfficer(async (tx) => {
      const email = someone('kavya');
      const opened = await openCase(tx, email);
      const draft = await sendDocumentsLetter(tx, opened.caseFileId);
      seq++;
      const out = await ingest(
        tx,
        mime([
          'From: Registrar CCPY <registrar@ccpy.test>',
          'To: intake@ccpy.test',
          `Subject: Fwd: Re: ${draft.subject}`,
          `Message-ID: <office-${seq}@ccpy.test>`,
          'Date: Sat, 11 Oct 2026 10:00:00 +0530',
          'Content-Type: text/plain; charset=utf-8',
          '',
          '---------- Forwarded message ---------',
          `From: Kavya Rao <${email}>`,
          'Date: Sat, 11 Oct 2026 at 09:00',
          `Subject: Re: ${draft.subject}`,
          'To: <registrar@ccpy.test>',
          '',
          'The bills are attached.',
        ]),
      );
      expect(out.councilCopy).toBe(false);
      expect(out.autoFiledTo).toBe(opened.caseFileId);
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(false);
    });
  });
});

describe('a forward the Council made only to itself', () => {
  it('is read through to the complainant, whose case is then offered', async () => {
    await withCouncil({ councilId }, async (tx) => {
      // The support desk is on the Council's own domain, and only this test says so.
      await tx.execute(sql`UPDATE council SET website = 'https://www.ccpy.test' WHERE id = ${councilId}::uuid`);
      const irfan = someone('irfan');
      const theirs = await openCase(tx, irfan, 'Mohammed Irfan');
      seq++;
      const out = await ingest(
        tx,
        mime([
          'From: Registrar CCPY <registrar@ccpy.test>',
          'To: intake@ccpy.test',
          'Subject: Fwd: Fwd: Complaint regarding overcharging',
          `Message-ID: <chain-${seq}@ccpy.test>`,
          'Date: Thu, 09 Oct 2026 10:00:00 +0530',
          'Content-Type: text/plain; charset=utf-8',
          '',
          '-------- Original Message --------',
          'Subject: Fwd: Complaint regarding overcharging',
          'Date: 2026-10-08 10:02',
          'From: CCPY Support <support@ccpy.test>',
          'To: registrar@ccpy.test',
          '',
          'Sir, a complaint received at the support desk.',
          '',
          '---------- Forwarded message ---------',
          `From: Mohammed Irfan <${irfan}>`,
          'Date: Tue, 7 Oct 2026 at 18:40',
          'Subject: Complaint regarding overcharging',
          'To: <support@ccpy.test>',
          '',
          'I was charged twice for one root canal.',
        ]),
      );
      expect(out.councilCopy).toBe(false);
      const page = await mail.get(tx, ctx, out.mailMessageId);
      expect(page!.message.original_from).toBe(irfan);
      expect(page!.candidates.map((c) => c.caseFileId)).toContain(theirs.caseFileId);
      const card = (await mail.tray(tx, ctx)).find((c) => c.id === out.mailMessageId)!;
      expect(card.complainant?.email).toBe(irfan);
      await tx.execute(sql`UPDATE council SET website = NULL WHERE id = ${councilId}::uuid`);
    });
  });
});

describe('a letter whose stored addressee is not its real one', () => {
  it('the hearing notice to the dentist is now drafted to the dentist', async () => {
    await asOfficer(async (tx) => {
      const opened = await caseForNotices(tx);
      const dr = await dentist(tx, opened.caseFileId, 'Dr. Summons', someone('dr'));
      const d = await correspondence.draft(tx, ctx, {
        caseFileId: opened.caseFileId,
        kind: 'summons_respondent',
        caseRespondentId: dr.caseRespondentId,
      });
      const row = await tx.execute<{ to_name: string | null; to_email: string | null }>(sql`
        SELECT to_name, to_email FROM correspondence WHERE id = ${d.correspondenceId}::uuid
      `);
      expect(row.rows[0]).toEqual({ to_name: 'Dr. Summons', to_email: null });
    });
  });

  /** A dentist's hearing notice as rows were written before: addressed to the complainant. */
  async function oldDentistHearingNotice(tx: Tx, caseFileId: string, complainantEmail: string) {
    const d = await correspondence.draft(tx, ctx, { caseFileId, kind: 'summons_respondent' });
    await tx.execute(sql`
      UPDATE correspondence SET to_name = 'Kavya Rao', to_email = ${complainantEmail}
      WHERE id = ${d.correspondenceId}::uuid
    `);
    await correspondence.markSent(tx, ctx, { correspondenceId: d.correspondenceId, sentAt: SENT });
    return d;
  }

  it("a copy to the dentist is the copy of the dentist's notice, recorded once", async () => {
    await asOfficer(async (tx) => {
      const complainantEmail = someone('comp');
      const opened = await caseForNotices(tx, complainantEmail);
      const drEmail = someone('dr');
      await dentist(tx, opened.caseFileId, 'Dr. Hearing', drEmail);
      const notice = await oldDentistHearingNotice(tx, opened.caseFileId, complainantEmail);

      const out = await ingest(tx, ccCopy({ subject: notice.subject, to: `Dr. Hearing <${drEmail}>` }));
      expect(out.status).toBe('filed');
      expect((await stored(tx, out.mailMessageId)).correspondence_id).toBe(notice.correspondenceId);
      expect(
        await count(
          tx,
          sql`SELECT count(*)::int n FROM correspondence
              WHERE case_file_id = ${opened.caseFileId}::uuid AND kind = 'summons_respondent'`,
        ),
      ).toBe(1);
    });
  });

  it("a copy of the complainant's notice is never taken for the dentist's", async () => {
    await asOfficer(async (tx) => {
      const complainantEmail = someone('comp');
      const opened = await caseForNotices(tx, complainantEmail);
      await dentist(tx, opened.caseFileId, 'Dr. Hearing', someone('dr'));
      const notice = await oldDentistHearingNotice(tx, opened.caseFileId, complainantEmail);

      const out = await ingest(tx, ccCopy({ subject: notice.subject, to: `Kavya Rao <${complainantEmail}>` }));
      expect(out.status).toBe('unfiled');
      expect((await stored(tx, out.mailMessageId)).correspondence_id).toBeNull();
      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.kind).toBe('summons_complainant');
      expect(plan.recordedLetter).toBeNull();
      expect(plan.actions[0]).toBe('record_sent');
    });
  });
});

describe('a copy dated by its own sending', () => {
  it('is a new letter, not a second copy of one sent months before', async () => {
    await asOfficer(async (tx) => {
      const email = someone('sitting');
      const opened = await openCase(tx, email);
      // The notice for the first sitting, sent in August, its Bcc copy filed with it.
      const august = await correspondence.draft(tx, ctx, { caseFileId: opened.caseFileId, kind: 'summons_complainant' });
      await correspondence.markSent(tx, ctx, {
        correspondenceId: august.correspondenceId,
        sentAt: new Date('2026-08-01T06:00:00Z'),
      });
      const first = await ingest(
        tx,
        ccCopy({ subject: august.subject, to: `Kavya Rao <${email}>`, date: 'Sat, 01 Aug 2026 11:30:00 +0530' }),
      );
      expect(first.status).toBe('filed');

      // The notice for the second sitting, sent in October and not yet recorded.
      const out = await ingest(tx, ccCopy({ subject: august.subject, to: `Kavya Rao <${email}>` }));
      expect(out.status).toBe('unfiled');
      expect(out.note).toMatch(/no record of this letter being sent - open the message to record it/);
      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.recordedLetter).toBeNull();
      expect(plan.actions).toEqual(['record_sent', 'record_only']);
      expect(plan.explanation).toMatch(/as sent on 1 Aug, more than a fortnight before this copy is dated - a different letter/);

      // "Add to a case" puts it on as the new letter, not with August's.
      await mail.fileOnCase(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      const m = await stored(tx, out.mailMessageId);
      expect(m.correspondence_id).not.toBe(august.correspondenceId);
      expect(
        await count(
          tx,
          sql`SELECT count(*)::int n FROM correspondence
              WHERE case_file_id = ${opened.caseFileId}::uuid AND kind = 'summons_complainant'`,
        ),
      ).toBe(2);
    });
  });
});

describe('a letter around the copy\'s date that already has its copy', () => {
  it('still stands in the way of filing by itself against another', async () => {
    await asOfficer(async (tx) => {
      const email = someone('reminded');
      const opened = await openCase(tx, email);
      const remind = async (sentAt: Date) => {
        const d = await correspondence.draft(tx, ctx, { caseFileId: opened.caseFileId, kind: 'request_docs_reminder' });
        await correspondence.markSent(tx, ctx, { correspondenceId: d.correspondenceId, sentAt });
        return d;
      };
      const firstOct = await remind(new Date('2026-10-01T06:00:00Z'));
      const bcc = await ingest(
        tx,
        ccCopy({ subject: firstOct.subject, to: `Kavya Rao <${email}>`, date: 'Thu, 01 Oct 2026 11:30:00 +0530' }),
      );
      expect((await stored(tx, bcc.mailMessageId)).correspondence_id).toBe(firstOct.correspondenceId);
      const eighthOct = await remind(new Date('2026-10-08T06:00:00Z'));

      // The 1 Oct reminder, forwarded from Sent mail on 9 Oct: its date line says 1 Oct.
      const out = await ingest(
        tx,
        forwardedCopy({
          subject: firstOct.subject,
          to: `Kavya Rao <${email}>`,
          date: 'Fri, 09 Oct 2026 10:00:00 +0530',
          dateLine: 'Thu, 1 Oct 2026 at 11:30',
        }),
      );
      expect(out.status).toBe('unfiled');
      expect((await stored(tx, out.mailMessageId)).correspondence_id).toBeNull();
      expect(out.note).not.toMatch(/Filed as the copy/);
      // Nothing was attached to the 8 Oct reminder.
      expect(
        await count(tx, sql`SELECT count(*)::int n FROM mail_message WHERE correspondence_id = ${eighthOct.correspondenceId}::uuid`),
      ).toBe(0);
    });
  });
});

describe('the tray note for a case not yet at the letter\'s step', () => {
  it('never says the step is recorded', async () => {
    await asOfficer(async (tx) => {
      const opened = await openCase(tx, someone('early'));
      const drEmail = someone('dr');
      await dentist(tx, opened.caseFileId, 'Dr. Early', drEmail);
      const out = await ingest(
        tx,
        ccCopy({ subject: `Explanation called for - ${opened.caseNumber}`, to: `Dr. Early <${drEmail}>` }),
      );
      expect(out.status).toBe('unfiled');
      expect(out.note).toMatch(/is not at the step this letter belongs to/);
      expect(out.note).not.toMatch(/already records this step/);
    });
  });
});

describe("a dentist's address the register only has from an earlier copy", () => {
  it("places the copy as that dentist, so another dentist's letter is never its letter", async () => {
    await asOfficer(async (tx) => {
      const opened = await caseForNotices(tx);
      const a = await dentist(tx, opened.caseFileId, 'Dr. Anand', someone('anand'));
      const b = await dentist(tx, opened.caseFileId, 'Dr. Bose');
      const bClinic = someone('bose.clinic');

      // B's first notice, recorded from its copy: B's address is now on that letter only.
      const first = await ingest(tx, ccCopy({ subject: `Explanation called for - ${opened.caseNumber}`, to: bClinic }));
      await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: first.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'record_sent',
        sentAt: SENT,
        caseRespondentId: b.caseRespondentId,
      });

      // A's reminder, recorded with "I have sent this".
      const reminder = await correspondence.draft(tx, ctx, {
        caseFileId: opened.caseFileId,
        kind: 'respondent_reminder',
        caseRespondentId: a.caseRespondentId,
      });
      await correspondence.markSent(tx, ctx, {
        correspondenceId: reminder.correspondenceId,
        sentAt: SENT,
        caseRespondentId: a.caseRespondentId,
      });

      // B's reminder, sent with the intake mailbox in Bcc and not recorded.
      const out = await ingest(tx, ccCopy({ subject: reminder.subject, to: bClinic }));
      expect(out.status).toBe('unfiled');
      expect(
        await count(tx, sql`SELECT count(*)::int n FROM mail_message WHERE correspondence_id = ${reminder.correspondenceId}::uuid`),
      ).toBe(0);
      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.recordedLetter?.id).not.toBe(reminder.correspondenceId);
    });
  });
});

describe('a letter to a named dentist, and a copy to an address that is not theirs', () => {
  it('is offered, never filed by itself', async () => {
    await asOfficer(async (tx) => {
      const opened = await caseForNotices(tx);
      const anand = await dentist(tx, opened.caseFileId, 'Dr. Anand', someone('anand'));
      const notice = await sendNotice(tx, opened.caseFileId, anand.caseRespondentId);
      // An address the case knows only from a letter that names nobody on it.
      const desk = someone('front.desk');
      await tx.execute(sql`
        INSERT INTO correspondence (council_id, case_file_id, kind, direction, to_email, subject, body, sent_at, created_by)
        VALUES (${councilId}::uuid, ${opened.caseFileId}::uuid, 'other', 'out', ${desk},
                'A note to the clinic', 'Please confirm the address.', ${SENT}, ${officer}::uuid)
      `);

      const out = await ingest(tx, ccCopy({ subject: notice.subject, to: desk }));
      expect(out.status).toBe('unfiled');
      expect(out.note).toMatch(/to Dr\. Anand, but this copy went to an address not on file for them/);
      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.check).toBe('confirmed');
      expect(plan.recordedLetter?.id).toBe(notice.correspondenceId);
    });
  });
});

describe("the office forwarding a patient's reply to the intake mailbox and somebody else", () => {
  /** The registrar's Gmail-style forward of the patient's reply, addressed as given. */
  function officeForward(args: { to: string; email: string; subject: string }): Buffer {
    seq++;
    return mime([
      'From: Registrar CCPY <registrar@ccpy.test>',
      `To: ${args.to}`,
      `Subject: Fwd: Re: ${args.subject}`,
      `Message-ID: <office-to-${seq}@ccpy.test>`,
      'Date: Sat, 11 Oct 2026 10:00:00 +0530',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '---------- Forwarded message ---------',
      `From: Kavya Rao <${args.email}>`,
      'Date: Sat, 11 Oct 2026 at 09:00',
      `Subject: Re: ${args.subject}`,
      'To: <registrar@ccpy.test>',
      '',
      'The bills are attached.',
    ]);
  }
  const GMAIL_BOX = 'ccpy.intake@gmail.com/INBOX';

  it('to the intake mailbox and the President: the reply, filed as received, the reminder closed', async () => {
    await asOfficer(async (tx) => {
      const email = someone('kavya');
      const opened = await openCase(tx, email);
      const draft = await sendDocumentsLetter(tx, opened.caseFileId);
      const out = await ingest(
        tx,
        officeForward({ to: 'ccpy.intake@gmail.com, President <president.ccpy@gmail.com>', email, subject: draft.subject }),
        GMAIL_BOX,
      );
      expect(out.councilCopy).toBe(false);
      expect(out.autoFiledTo).toBe(opened.caseFileId);
      expect(await letters(tx, opened.caseFileId, 'in')).toBe(1);
      expect(await waitingForDocuments(tx, opened.caseFileId)).toBe(false);
    });
  });

  it('to the intake mailbox under another spelling of its Gmail address: the same', async () => {
    for (const to of ['ccpy.in.take@gmail.com', 'CCPY Intake <ccpyintake+office@googlemail.com>']) {
      await asOfficer(async (tx) => {
        const email = someone('kavya');
        const opened = await openCase(tx, email);
        const draft = await sendDocumentsLetter(tx, opened.caseFileId);
        const out = await ingest(tx, officeForward({ to, email, subject: draft.subject }), GMAIL_BOX);
        expect(out.councilCopy, to).toBe(false);
        expect(out.autoFiledTo, to).toBe(opened.caseFileId);
        expect(await waitingForDocuments(tx, opened.caseFileId), to).toBe(false);
      });
    }
  });
});

describe('a complaint an outside body forwarded to the Council, forwarded on to the intake mailbox', () => {
  it("names the patient, not the grievance cell, and offers the patient's case", async () => {
    await asOfficer(async (tx) => {
      const kdevi = someone('kdevi');
      const theirs = await openCase(tx, kdevi, 'Kavitha Devi');
      seq++;
      const out = await ingest(
        tx,
        mime([
          'From: Registrar CCPY <registrar@ccpy.test>',
          'To: intake@ccpy.test',
          'Subject: Fwd: Fwd: Complaint against Dr. Rao',
          `Message-ID: <grievance-${seq}@ccpy.test>`,
          'Date: Thu, 09 Oct 2026 10:00:00 +0530',
          'Content-Type: text/plain; charset=utf-8',
          '',
          '-------- Original Message --------',
          'Subject: Fwd: Complaint against Dr. Rao',
          'Date: 2026-10-08 10:02',
          'From: Grievance Cell <grievance@health.example.gov.in>',
          'To: registrar@ccpy.test',
          '',
          'Forwarded for necessary action.',
          '',
          '---------- Forwarded message ---------',
          `From: Kavitha Devi <${kdevi}>`,
          'Date: Tue, 7 Oct 2026 at 18:40',
          'Subject: Complaint against Dr. Rao',
          'To: <grievance@health.example.gov.in>',
          '',
          'The extraction was done without my consent.',
        ]),
      );
      expect(out.councilCopy).toBe(false);
      const page = await mail.get(tx, ctx, out.mailMessageId);
      expect(page!.message.original_from).toBe(kdevi);
      expect(page!.candidates.map((c) => c.caseFileId)).toContain(theirs.caseFileId);
      const card = (await mail.tray(tx, ctx)).find((c) => c.id === out.mailMessageId)!;
      expect(card.complainant?.email).toBe(kdevi);
      // How it came is still said.
      expect(out.note).toMatch(/forwarded by Grievance Cell <grievance@health\.example\.gov\.in>/);
    });
  });
});

describe("a copy of the dentist's hearing notice, when the complainant's is the one recorded", () => {
  it("is never filed as proof of the complainant's notice, and can be recorded once answered", async () => {
    await asOfficer(async (tx) => {
      const complainantEmail = someone('comp');
      const opened = await caseForNotices(tx, complainantEmail);
      await dentist(tx, opened.caseFileId, 'Dr. Hearing');
      const theirs = await correspondence.draft(tx, ctx, { caseFileId: opened.caseFileId, kind: 'summons_complainant' });
      await correspondence.markSent(tx, ctx, { correspondenceId: theirs.correspondenceId, sentAt: SENT });

      // The dentist's notice, to the clinic's address, which is on file nowhere.
      const out = await ingest(tx, ccCopy({ subject: theirs.subject, to: someone('clinic') }));
      expect(out.status).toBe('unfiled');
      let plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.kind).toBeNull();
      expect(plan.recordedLetter).toMatchObject({ id: theirs.correspondenceId, sure: false });
      expect(plan.actions[0]).toBe('link');
      expect(plan.actions).toContain('record_only');
      expect(plan.explanation).toMatch(/It may be the copy of/);
      expect(plan.explanation).not.toMatch(/attaches it to that letter as proof/);

      // Neither "Add to a case" nor the assistant's Accept links it by itself.
      for (const file of [
        (sp: Tx) => mail.fileOnCase(sp, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId }),
        (sp: Tx) =>
          mail.fileCopyByDefault(sp, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId, asCouncilCopy: true }),
      ]) {
        await expect(tx.transaction((sp) => file(sp))).rejects.toThrow(/say which letter it is/);
      }
      expect((await stored(tx, out.mailMessageId)).correspondence_id).toBeNull();

      // Answered: the complainant's notice is no longer a candidate, and the copy is recorded
      // as the dentist's own letter.
      plan = await mail.councilCopyPlan(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        kind: 'summons_respondent',
      });
      expect(plan.recordedLetter).toBeNull();
      expect(plan.actions).toContain('record_only');
      const filed = await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'record_only',
        kind: 'summons_respondent',
      });
      expect(filed.correspondenceId).not.toBe(theirs.correspondenceId);
      const row = await tx.execute<{ kind: string }>(sql`
        SELECT kind::text FROM correspondence WHERE id = ${filed.correspondenceId}::uuid
      `);
      expect(row.rows[0]!.kind).toBe('summons_respondent');
      expect(
        await count(tx, sql`SELECT count(*)::int n FROM mail_message WHERE correspondence_id = ${theirs.correspondenceId}::uuid`),
      ).toBe(0);
    });
  });
});

describe("a copy of one dentist's notice, when the case records another dentist's", () => {
  it("(a) another dentist's notice with no copy yet is offered as uncertain, never taken by itself", async () => {
    await asOfficer(async (tx) => {
      const opened = await caseForNotices(tx);
      const alpha = await dentist(tx, opened.caseFileId, 'Dr. Alpha');
      const beta = await dentist(tx, opened.caseFileId, 'Dr. Beta');
      const toAlpha = await sendNotice(tx, opened.caseFileId, alpha.caseRespondentId, new Date('2026-10-01T06:00:00Z'));

      const out = await ingest(tx, ccCopy({ subject: toAlpha.subject, to: someone('beta') }));
      expect(out.status).toBe('unfiled');
      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.recordedLetter).toMatchObject({ id: toAlpha.correspondenceId, how: 'match', sure: false });
      expect(plan.actions).toEqual(['link', 'record_sent', 'record_only']);
      expect(plan.explanation).toMatch(/It may be the copy of/);

      await expect(
        tx.transaction((sp) => mail.fileOnCase(sp, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId })),
      ).rejects.toThrow(/not certain/);
      expect((await stored(tx, out.mailMessageId)).correspondence_id).toBeNull();

      // Beta's notice can be recorded from its copy.
      await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'record_sent',
        sentAt: SENT,
        caseRespondentId: beta.caseRespondentId,
      });
      expect(await noticesTo(tx, beta.caseRespondentId)).toBe(1);
      expect(await noticesTo(tx, alpha.caseRespondentId)).toBe(1);
    });
  });

  it("(b) another dentist's notice that already has its copy is not taken as this one's either", async () => {
    await asOfficer(async (tx) => {
      const opened = await caseForNotices(tx);
      const alpha = await dentist(tx, opened.caseFileId, 'Dr. Alpha');
      const beta = await dentist(tx, opened.caseFileId, 'Dr. Beta');
      const toAlpha = await sendNotice(tx, opened.caseFileId, alpha.caseRespondentId);
      // Alpha's copy, sent under Alpha's name, filed with Alpha's notice.
      const alphaCopy = await ingest(tx, ccCopy({ subject: toAlpha.subject, to: `Dr. Alpha <${someone('alpha')}>` }));
      await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: alphaCopy.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'link',
      });
      expect((await stored(tx, alphaCopy.mailMessageId)).correspondence_id).toBe(toAlpha.correspondenceId);

      // Beta's copy, two days earlier, to the clinic address an earlier letter on this case
      // went to under nobody's name - so the number and the address agree, and the copy is
      // checked against what the case records at ingest.
      const clinic = someone('beta.clinic');
      await tx.execute(sql`
        INSERT INTO correspondence (council_id, case_file_id, kind, direction, to_email, subject, body, sent_at, created_by)
        VALUES (${councilId}::uuid, ${opened.caseFileId}::uuid, 'other', 'out', ${clinic},
                'A note to the clinic', 'Please confirm the address.', ${SENT}, ${officer}::uuid)
      `);
      const out = await ingest(
        tx,
        ccCopy({ subject: toAlpha.subject, to: clinic, date: 'Thu, 08 Oct 2026 10:00:00 +0530' }),
      );
      expect(out.status).toBe('unfiled');
      expect(out.note).toMatch(/open the message to check whether it is the copy of that letter/);
      expect(out.note).not.toMatch(/already records this letter/);
      const plan = await mail.councilCopyPlan(tx, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId });
      expect(plan.recordedLetter).toMatchObject({ id: toAlpha.correspondenceId, how: 'already_copied', sure: false });
      expect(plan.actions).toEqual(['link', 'record_sent', 'record_only']);

      for (const file of [
        (sp: Tx) => mail.fileOnCase(sp, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId }),
        (sp: Tx) =>
          mail.fileCopyByDefault(sp, ctx, { mailMessageId: out.mailMessageId, caseFileId: opened.caseFileId, asCouncilCopy: true }),
      ]) {
        await expect(tx.transaction((sp) => file(sp))).rejects.toThrow(/not certain/);
      }
      await mail.fileCouncilCopy(tx, ctx, {
        mailMessageId: out.mailMessageId,
        caseFileId: opened.caseFileId,
        mode: 'record_sent',
        sentAt: new Date('2026-10-08T06:00:00Z'),
        caseRespondentId: beta.caseRespondentId,
      });
      expect(await noticesTo(tx, beta.caseRespondentId)).toBe(1);
      expect(await noticesTo(tx, alpha.caseRespondentId)).toBe(1);
    });
  });
});

describe('a hearing notice to the dentist drafted before it was addressed to the dentist', () => {
  it('is rewritten when drafted again, never left beside a second draft', async () => {
    await asOfficer(async (tx) => {
      const complainantEmail = someone('comp');
      const opened = await caseForNotices(tx, complainantEmail);
      const dr = await dentist(tx, opened.caseFileId, 'Dr. Summons');
      const legacy = await correspondence.draft(tx, ctx, { caseFileId: opened.caseFileId, kind: 'summons_respondent' });
      await tx.execute(sql`
        UPDATE correspondence SET to_name = 'Kavya Rao', to_email = ${complainantEmail}
        WHERE id = ${legacy.correspondenceId}::uuid
      `);
      const unsent = () =>
        count(
          tx,
          sql`SELECT count(*)::int n FROM correspondence
              WHERE case_file_id = ${opened.caseFileId}::uuid AND kind = 'summons_respondent' AND sent_at IS NULL`,
        );

      // Drafted again without a dentist (an old screen), and then to the dentist picked.
      const again = await correspondence.draft(tx, ctx, { caseFileId: opened.caseFileId, kind: 'summons_respondent' });
      expect(again.correspondenceId).toBe(legacy.correspondenceId);
      expect(await unsent()).toBe(1);
      const toDentist = await correspondence.draft(tx, ctx, {
        caseFileId: opened.caseFileId,
        kind: 'summons_respondent',
        caseRespondentId: dr.caseRespondentId,
      });
      expect(toDentist.correspondenceId).toBe(legacy.correspondenceId);
      expect(await unsent()).toBe(1);
      const row = await tx.execute<{ to_name: string | null; to_email: string | null }>(sql`
        SELECT to_name, to_email FROM correspondence WHERE id = ${legacy.correspondenceId}::uuid
      `);
      expect(row.rows[0]).toEqual({ to_name: 'Dr. Summons', to_email: null });
    });
  });
});
