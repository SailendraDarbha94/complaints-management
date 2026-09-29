import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import { closeDb, initDb, withCouncil, type Db, type Tx } from '@ksdc/db';
import { KSDC_CONFIG, type CouncilConfig } from '@ksdc/config';
import { CaseIntakeService } from '../cases/case-intake.service.js';
import { CaseLifecycleService } from '../cases/case-lifecycle.service.js';
import { CorrespondenceService } from '../correspondence/correspondence.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { FollowupService, type EngineContext } from '../followups/followup.service.js';
import { LocalStorage } from '../documents/storage.js';
import { seedCouncilAndOfficer } from '../../test-support/fixtures.js';
import { MailIntakeService } from './mail-intake.service.js';
import { councilForMailbox, givesUp } from './sweep.js';
import { parseMessage } from './parse.js';

/**
 * The inward tray, against a real database.
 *
 * The rule every test here is written around: a message is not a case. Nothing takes a
 * serial out of the register until either a person presses a button or the message quotes
 * a number the register already knows.
 */

let db: Db;
const councilId = 'c0a11111-1111-4111-8111-111111111111';
const officer = 'c0a22222-2222-4222-8222-222222222222';

const followups = new FollowupService();
const lifecycle = new CaseLifecycleService(followups);
const intake = new CaseIntakeService(followups);
const correspondence = new CorrespondenceService(lifecycle, followups);
const storage = new LocalStorage();
const documents = new DocumentsService(storage);
const mail = new MailIntakeService(storage, intake, correspondence, documents, followups);

const config: CouncilConfig = KSDC_CONFIG;
const ctx: EngineContext = { councilId, userId: officer, config };

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId }, async (tx) => {
    await seedCouncilAndOfficer(tx, { councilId, officerId: officer, code: 'MLKS' });
    await tx.execute(sql`
      INSERT INTO council_config (council_id, config)
      VALUES (${councilId}::uuid, ${JSON.stringify(KSDC_CONFIG)}::jsonb)
      ON CONFLICT (council_id) DO UPDATE SET config = EXCLUDED.config
    `);
  });
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
    await tx.execute(sql`UPDATE case_file SET state = 'closed', closed_at = now(),
                           closure_reason = 'withdrawn'
                         WHERE council_id = ${councilId}::uuid AND state <> 'closed'`);
  });
});

/** A message as a mail server would hand it over. */
function raw(headers: Record<string, string>, body: string): Buffer {
  return Buffer.from(
    [...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n'),
    'utf8',
  );
}

let seq = 0;
async function forward(body: string, subject = 'Fwd: Complaint about treatment') {
  seq++;
  const bytes = raw(
    {
      From: 'Dental Officer <officer@mlks.test>',
      To: 'intake@mlks.test',
      Subject: subject,
      'Message-ID': `<fwd-${seq}@mail.test>`,
      Date: 'Wed, 17 Sep 2026 10:14:00 +0530',
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body,
  );
  return { parsed: await simpleParser(bytes), raw: bytes };
}

const GMAIL_FORWARD = [
  'Sir, please log this.',
  '',
  '---------- Forwarded message ---------',
  'From: Kavitha Devi <kdevi@example.in>',
  'Date: Tue, 16 Sep 2026 at 19:12',
  'Subject: Crown came off within a week',
  'To: <registrar@mlks.test>',
  '',
  'My crown was fitted in June and came off within a week.',
].join('\r\n');

const ingest = async (tx: Tx, m: { parsed: Awaited<ReturnType<typeof simpleParser>>; raw: Buffer }) =>
  mail.ingest(tx, ctx, m.parsed, { mailbox: 'INBOX', uid: ++seq, uidValidity: '1', raw: m.raw });

describe('a forwarded complaint arriving', () => {
  it('lands in the tray as a card, and does NOT become a case', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const before = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int n FROM case_file WHERE council_id = ${councilId}::uuid`,
      );
      const out = await ingest(tx, await forward(GMAIL_FORWARD));

      expect(out.status).toBe('unfiled');
      expect(out.autoFiledTo).toBeNull();

      const after = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int n FROM case_file WHERE council_id = ${councilId}::uuid`,
      );
      // A case number is a serial in a legal register. Nothing spends one automatically.
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });
  });

  it('shows the complainant on the card, not the officer who forwarded it', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      await ingest(tx, await forward(GMAIL_FORWARD));
      const [card] = await mail.tray(tx, ctx);
      expect(card!.original_from).toBe('kdevi@example.in');
      expect(card!.original_from_name).toBe('Kavitha Devi');
      expect(card!.original_subject).toBe('Crown came off within a week');
      // The envelope is still the truth about how it reached us.
      expect(card!.envelope_from).toBe('officer@mlks.test');
      expect(card!.snippet).toMatch(/crown was fitted in June/);
    });
  });

  it('is ingested once, however many times the reader sees it', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const m = await forward(GMAIL_FORWARD);
      const first = await ingest(tx, m);
      const second = await mail.ingest(tx, ctx, m.parsed, {
        mailbox: 'INBOX',
        uid: 999,
        uidValidity: '1',
        raw: m.raw,
      });
      expect(second.duplicate).toBe(true);
      expect(second.mailMessageId).toBe(first.mailMessageId);
    });
  });
});

describe('opening a case from a card', () => {
  it('opens it in the complainant’s name, dated when it reached the Council', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await ingest(tx, await forward(GMAIL_FORWARD));
      const opened = await mail.openCase(tx, ctx, { mailMessageId: out.mailMessageId });

      expect(opened.caseNumber).toMatch(/^MLKS\/COMP\/\d{4}-\d{2}\/\d{4}$/);

      const parties = await tx.execute<{ role: string; full_name: string; email: string | null }>(sql`
        SELECT cp.role::text AS role, p.full_name, p.email
        FROM case_party cp JOIN party p ON p.id = cp.party_id
        WHERE cp.case_file_id = ${opened.caseFileId}::uuid AND cp.role = 'complainant'
      `);
      expect(parties.rows[0]!.full_name).toBe('Kavitha Devi');
      expect(parties.rows[0]!.email).toBe('kdevi@example.in');
    });
  });

  it('records the message on the case as inbound correspondence', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await ingest(tx, await forward(GMAIL_FORWARD));
      const opened = await mail.openCase(tx, ctx, { mailMessageId: out.mailMessageId });

      const letters = await tx.execute<{ kind: string; direction: string; from_email: string }>(sql`
        SELECT kind::text, direction::text, from_email FROM correspondence
        WHERE case_file_id = ${opened.caseFileId}::uuid
      `);
      expect(letters.rows).toHaveLength(1);
      expect(letters.rows[0]!.direction).toBe('in');
      expect(letters.rows[0]!.from_email).toBe('kdevi@example.in');
    });
  });

  it('refuses to open a second case from the same message', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await ingest(tx, await forward(GMAIL_FORWARD));
      await mail.openCase(tx, ctx, { mailMessageId: out.mailMessageId });
      await expect(
        mail.openCase(tx, ctx, { mailMessageId: out.mailMessageId }),
      ).rejects.toThrow(/already on a case/i);
    });
  });
});

describe("a forward from the Council's own address that could not be unwrapped", () => {
  // What happened on the first real forward from the office webmail: the unwrapper did not
  // recognise the layout, and every fallback then took the only sender left - the Council's
  // own registrar address - as the complainant. Whatever the unwrapper misses in future,
  // the Council must never be the complainant on its own case.
  async function unreadableForward() {
    seq++;
    const bytes = raw(
      {
        From: 'Registrar MLKS <registrar@mlks.test>',
        To: 'intake@mlks.test',
        Subject: 'Fwd: Treatment complaint',
        'Message-ID': `<unreadable-${seq}@mlks.test>`,
        Date: 'Thu, 17 Sep 2026 12:02:00 +0530',
        'Content-Type': 'text/plain; charset=utf-8',
      },
      'Please see below.\r\n\r\nThe bridge fitted in August has come loose twice.',
    );
    return { parsed: await simpleParser(bytes), raw: bytes };
  }

  it('shows no complainant on the card rather than the Council', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await ingest(tx, await unreadableForward());
      const card = (await mail.tray(tx, ctx)).find((c) => c.id === out.mailMessageId);
      expect(card!.complainant).toBeNull();

      const page = await mail.get(tx, ctx, out.mailMessageId);
      expect((page!.message as { complainant: unknown }).complainant).toBeNull();
    });
  });

  it('will not open a case in the Council name, and spends no case number trying', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await ingest(tx, await unreadableForward());
      const count = async () =>
        (
          await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int n FROM case_file WHERE council_id = ${councilId}::uuid`,
          )
        ).rows[0]!.n;
      const before = await count();

      await expect(mail.openCase(tx, ctx, { mailMessageId: out.mailMessageId })).rejects.toThrow(
        /Council's own address/,
      );
      expect(await count()).toBe(before);
    });
  });

  it('opens once the officer says who complained, without pairing them with our address', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await ingest(tx, await unreadableForward());
      const opened = await mail.openCase(tx, ctx, {
        mailMessageId: out.mailMessageId,
        complainantName: 'L. N. Rao',
      });

      const parties = await tx.execute<{ full_name: string; email: string | null }>(sql`
        SELECT p.full_name, p.email
        FROM case_party cp JOIN party p ON p.id = cp.party_id
        WHERE cp.case_file_id = ${opened.caseFileId}::uuid AND cp.role = 'complainant'
      `);
      expect(parties.rows).toEqual([{ full_name: 'L. N. Rao', email: null }]);
    });
  });

  it('treats the intake mailbox itself as the Council too', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      seq++;
      const bytes = raw(
        {
          From: 'Intake <intake@mlks.test>',
          To: 'intake@mlks.test',
          Subject: 'A note to self',
          'Message-ID': `<self-${seq}@mlks.test>`,
          Date: 'Thu, 17 Sep 2026 12:02:00 +0530',
          'Content-Type': 'text/plain; charset=utf-8',
        },
        'Testing the tray.',
      );
      const out = await mail.ingest(tx, ctx, await simpleParser(bytes), {
        mailbox: 'intake@mlks.test/INBOX',
        uid: ++seq,
        uidValidity: '1',
        raw: bytes,
      });
      const card = (await mail.tray(tx, ctx)).find((c) => c.id === out.mailMessageId);
      expect(card!.complainant).toBeNull();
    });
  });

  it('still names the complainant of a forward it could read', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await ingest(tx, await forward(GMAIL_FORWARD));
      const card = (await mail.tray(tx, ctx)).find((c) => c.id === out.mailMessageId);
      expect(card!.complainant).toEqual({ name: 'Kavitha Devi', email: 'kdevi@example.in' });
    });
  });
});

describe('a reply that quotes a case number', () => {
  it('files itself, without waiting for the officer', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const opened = await intake.create(tx, ctx, {
        summary: 'Crown came off',
        receivedAt: new Date('2026-09-01T04:00:00Z'),
        complainant: { fullName: 'Kavitha Devi', email: 'kdevi@example.in' },
      });

      const reply = await forward(
        'I am attaching the bills you asked for.',
        `Re: Documents required [${opened.caseNumber}]`,
      );
      const out = await ingest(tx, reply);

      expect(out.autoFiledTo).toBe(opened.caseFileId);
      expect(out.status).toBe('filed');
      expect(out.note).toMatch(/the subject quotes/i);
    });
  });

  it('satisfies the reminder the case was waiting on', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const opened = await intake.create(tx, ctx, {
        summary: 'Crown came off',
        receivedAt: new Date('2026-09-01T04:00:00Z'),
        complainant: { fullName: 'K D', email: 'kd@example.in' },
      });
      await lifecycle.apply(tx, ctx, { caseFileId: opened.caseFileId, event: 'REQUEST_DOCUMENTS' });

      const before = await followups.liveForCase(tx, ctx, opened.caseFileId);
      expect(before.some((f) => f.stage === 'await_patient_docs')).toBe(true);

      // No officer involved: the subject quotes the case number, so it files itself - and
      // filing itself has to clear the chase too, or Today keeps asking for a document
      // that is already on the file.
      const out = await ingest(
        tx,
        await forward('Here are the bills.', `Re: Documents [${opened.caseNumber}]`),
      );
      expect(out.autoFiledTo).toBe(opened.caseFileId);

      const after = await followups.liveForCase(tx, ctx, opened.caseFileId);
      expect(after.some((f) => f.stage === 'await_patient_docs')).toBe(false);
    });
  });

  it('will not file itself onto a CLOSED case; it asks instead', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const opened = await intake.create(tx, ctx, {
        summary: 'Old matter',
        receivedAt: new Date('2026-05-01T04:00:00Z'),
        complainant: { fullName: 'A B' },
      });
      await tx.execute(sql`
        UPDATE case_file SET state = 'closed', closed_at = now(), closure_reason = 'withdrawn'
        WHERE id = ${opened.caseFileId}::uuid
      `);

      const out = await ingest(
        tx,
        await forward('One more thing.', `Re: [${opened.caseNumber}]`),
      );
      expect(out.autoFiledTo).toBeNull();
      expect(out.note).toMatch(/is closed/i);
    });
  });

  it('refuses to guess when a message names two different cases', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const a = await intake.create(tx, ctx, {
        summary: 'First',
        receivedAt: new Date('2026-09-01T04:00:00Z'),
        complainant: { fullName: 'A' },
      });
      const b = await intake.create(tx, ctx, {
        summary: 'Second',
        receivedAt: new Date('2026-09-02T04:00:00Z'),
        complainant: { fullName: 'B' },
      });

      const out = await ingest(
        tx,
        await forward(
          `Regarding ${a.caseNumber} and also ${b.caseNumber}, please note.`,
          'Two matters',
        ),
      );
      expect(out.autoFiledTo).toBeNull();
      expect(out.note).toMatch(/names 2 different cases/i);
    });
  });

  it('ignores a reference belonging to another authority', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      // Structurally a valid case number, but the council code is not ours.
      const out = await ingest(
        tx,
        await forward('Forwarded from the DCI.', 'Re: NDC/COMP/2026-27/0042'),
      );
      expect(out.autoFiledTo).toBeNull();
      expect(out.note).toMatch(/another authority/i);
    });
  });
});

describe('attachments', () => {
  // A one-pixel PNG. sniff() reads the bytes rather than trusting the declared type.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  async function withAttachment(filename: string, bytes: Buffer, type: string) {
    seq++;
    const b = Buffer.from(
      [
        'From: Dental Officer <officer@mlks.test>',
        'To: intake@mlks.test',
        `Subject: Fwd: bills ${seq}`,
        `Message-ID: <att-${seq}@mail.test>`,
        'Date: Wed, 17 Sep 2026 10:14:00 +0530',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Bills attached.',
        '',
        '--b1',
        `Content-Type: ${type}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${filename}"`,
        '',
        bytes.toString('base64'),
        '',
        '--b1--',
        '',
      ].join('\r\n'),
      'utf8',
    );
    return { parsed: await simpleParser(b), raw: b };
  }

  it('keeps the bytes while the message waits in the tray', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await ingest(tx, await withAttachment('bill.png', PNG, 'image/png'));
      expect(out.attachmentsStored).toBe(1);

      const rows = await tx.execute<{ staging_key: string | null }>(sql`
        SELECT staging_key FROM mail_attachment WHERE mail_message_id = ${out.mailMessageId}::uuid
      `);
      expect(rows.rows[0]!.staging_key).toMatch(/^staging\//);
    });
  });

  it('becomes a case document when the message is filed', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await ingest(tx, await withAttachment('bill.png', PNG, 'image/png'));
      const opened = await mail.openCase(tx, ctx, { mailMessageId: out.mailMessageId });
      expect(opened.documentsFiled).toBe(1);

      const docs = await documents.listForCase(tx, ctx, opened.caseFileId);
      expect(docs).toHaveLength(1);
      expect(docs[0]!.filename).toBe('bill.png');
    });
  });

  it('records what it refused rather than dropping it silently', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      // A .docx is real mail and is not a kind the register stores. The officer has to be
      // able to see that something came and was not kept.
      const out = await ingest(
        tx,
        await withAttachment('notes.docx', Buffer.from('PK not really'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      );
      expect(out.attachmentsStored).toBe(0);
      expect(out.attachmentsSkipped).toBe(1);

      const rows = await tx.execute<{ filename: string; skipped_reason: string | null }>(sql`
        SELECT filename, skipped_reason FROM mail_attachment
        WHERE mail_message_id = ${out.mailMessageId}::uuid
      `);
      expect(rows.rows[0]!.filename).toBe('notes.docx');
      expect(rows.rows[0]!.skipped_reason).toMatch(/not a kind the register stores/i);
    });
  });

  // ── The three ways attachments went missing or went astray ──────────────────
  //
  // Found by reading the code when the officer asked what happens to attachments. Each was
  // silent: nothing on screen said a file had not reached the case, or that one had which
  // did not belong there.

  /** Lines of a MIME message, joined as a mail server hands them over. */
  const mime = (lines: string[]) => Buffer.from(lines.join('\r\n'), 'utf8');

  const pngPart = (filename: string, bytes: Buffer, extra: string[] = []) => [
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    ...extra,
    `Content-Disposition: attachment; filename="${filename}"`,
    '',
    bytes.toString('base64'),
  ];

  /** The complainant's own email: a letter with a bill attached. */
  const complaintEmail = (subject: string, from = 'A. Patient <a.patient@example.in>') =>
    [
      `From: ${from}`,
      'To: registrar@mlks.test',
      `Subject: ${subject}`,
      'Date: Tue, 16 Sep 2026 19:12:00 +0530',
      'Content-Type: multipart/mixed; boundary="in"',
      '',
      '--in',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'The bridge came loose twice. The bill is attached.',
      '--in',
      ...pngPart('bill.png', PNG),
      '--in--',
      '',
    ].join('\r\n');

  it('files the attachments with a reply that files itself by quoting the case number', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const opened = await mail.openCase(tx, ctx, {
        mailMessageId: (await ingest(tx, await forward(GMAIL_FORWARD))).mailMessageId,
      });
      seq++;
      const bytes = mime([
        'From: Kavitha Devi <kdevi@example.in>',
        'To: intake@mlks.test',
        `Subject: Re: Documents required [${opened.caseNumber}]`,
        `Message-ID: <reply-${seq}@mail.test>`,
        'Date: Thu, 18 Sep 2026 09:00:00 +0530',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Here are the bills you asked for.',
        '--b1',
        ...pngPart('bill.png', PNG),
        '--b1--',
        '',
      ]);
      const out = await ingest(tx, { parsed: await simpleParser(bytes), raw: bytes });

      expect(out.autoFiledTo).toBe(opened.caseFileId);
      // On the case, not merely held on the message - the reminder for documents is closed
      // by the same filing, so anything less leaves the case waiting on a file it has.
      const docs = await documents.listForCase(tx, ctx, opened.caseFileId);
      expect(docs.map((d) => d.filename)).toContain('bill.png');
      const rows = await tx.execute<{ document_id: string | null }>(sql`
        SELECT document_id FROM mail_attachment WHERE mail_message_id = ${out.mailMessageId}::uuid
      `);
      expect(rows.rows[0]!.document_id).not.toBeNull();
    });
  });

  it('keeps the bills inside an email that was forwarded AS an attachment', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      seq++;
      const bytes = mime([
        'From: Dental Officer <officer@mlks.test>',
        'To: intake@mlks.test',
        'Subject: Fwd: Treatment complaint',
        `Message-ID: <fwd-att-${seq}@mail.test>`,
        'Date: Wed, 17 Sep 2026 10:14:00 +0530',
        'Content-Type: multipart/mixed; boundary="out"',
        '',
        '--out',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Please log the attached.',
        '--out',
        'Content-Type: message/rfc822',
        'Content-Disposition: attachment; filename="complaint.eml"',
        '',
        complaintEmail('Treatment complaint'),
        '--out--',
        '',
      ]);
      const out = await ingest(tx, { parsed: await simpleParser(bytes), raw: bytes });

      // The attached email is the complaint - unwrapped, not listed as a file of its own.
      const rows = await tx.execute<{ filename: string; staging_key: string | null }>(sql`
        SELECT filename, staging_key FROM mail_attachment
        WHERE mail_message_id = ${out.mailMessageId}::uuid
      `);
      expect(rows.rows.map((r) => r.filename)).toEqual(['bill.png']);
      expect(rows.rows[0]!.staging_key).toMatch(/^staging\//);

      const opened = await mail.openCase(tx, ctx, { mailMessageId: out.mailMessageId });
      expect(opened.documentsFiled).toBe(1);
      const parties = await tx.execute<{ email: string | null }>(sql`
        SELECT p.email FROM case_party cp JOIN party p ON p.id = cp.party_id
        WHERE cp.case_file_id = ${opened.caseFileId}::uuid AND cp.role = 'complainant'
      `);
      expect(parties.rows[0]!.email).toBe('a.patient@example.in');
    });
  });

  it('writes down a SECOND attached email, and never files its files with this complaint', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      seq++;
      const bytes = mime([
        'From: Dental Officer <officer@mlks.test>',
        'To: intake@mlks.test',
        'Subject: Fwd: Two emails from the same patient',
        `Message-ID: <fwd-two-${seq}@mail.test>`,
        'Date: Wed, 17 Sep 2026 10:14:00 +0530',
        'Content-Type: multipart/mixed; boundary="out"',
        '',
        '--out',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Both attached.',
        '--out',
        'Content-Type: message/rfc822',
        '',
        complaintEmail('First complaint'),
        '--out',
        'Content-Type: message/rfc822',
        '',
        complaintEmail('Follow-up with another bill'),
        '--out--',
        '',
      ]);
      const out = await ingest(tx, { parsed: await simpleParser(bytes), raw: bytes });

      const rows = await tx.execute<{ filename: string; skipped_reason: string | null }>(sql`
        SELECT filename, skipped_reason FROM mail_attachment
        WHERE mail_message_id = ${out.mailMessageId}::uuid ORDER BY created_at, filename
      `);
      const second = rows.rows.find((r) => r.skipped_reason?.startsWith('Another email'));
      expect(second?.skipped_reason).toMatch(/Follow-up with another bill/);

      // Two complaints forwarded together may be two different patients. Only the first -
      // the one read as the complaint - has its bill staged; the other email's bill is
      // written down against that email and can never be filed on this complainant's case.
      expect(out.attachmentsStored).toBe(1);
      expect(out.attachmentsSkipped).toBe(2);
      const theirs = rows.rows.find((r) => r.skipped_reason?.startsWith('Attached to the other email'));
      expect(theirs?.filename).toBe('bill.png');
      expect(theirs?.skipped_reason).toMatch(/Follow-up with another bill/);

      const opened = await mail.openCase(tx, ctx, { mailMessageId: out.mailMessageId });
      expect(opened.documentsFiled).toBe(1);
    });
  });

  it('keeps two complaints apart when the attached emails are marked inline', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      // mailparser's default dissolves an INLINE attached email into its parent, lifting its
      // files up beside the parent's own - so both patients' bills looked like this
      // complaint's. The mailbox parses with parseMessage(), which keeps them apart.
      seq++;
      const bytes = mime([
        'From: Dental Officer <officer@mlks.test>',
        'To: intake@mlks.test',
        'Subject: Fwd: Two complaints',
        `Message-ID: <fwd-inline-${seq}@mail.test>`,
        'Date: Wed, 17 Sep 2026 10:14:00 +0530',
        'Content-Type: multipart/mixed; boundary="out"',
        '',
        '--out',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Both attached.',
        '--out',
        'Content-Type: message/rfc822',
        'Content-Disposition: inline',
        '',
        complaintEmail('First complaint'),
        '--out',
        'Content-Type: message/rfc822',
        'Content-Disposition: inline',
        '',
        complaintEmail('A different patient', 'B. Other <b.other@example.in>'),
        '--out--',
        '',
      ]);
      const out = await ingest(tx, { parsed: await parseMessage(bytes), raw: bytes });

      expect(out.attachmentsStored).toBe(1);
      const rows = await tx.execute<{ skipped_reason: string | null }>(sql`
        SELECT skipped_reason FROM mail_attachment
        WHERE mail_message_id = ${out.mailMessageId}::uuid AND staging_key IS NULL
      `);
      expect(rows.rows.some((r) => /Attached to the other email.*A different patient/.test(r.skipped_reason ?? ''))).toBe(true);
    });
  });

  /** A forward whose HTML shows an image by cid: - how signatures carry their logos. */
  async function withEmbeddedImage(bytes: Buffer, type = 'image/png') {
    seq++;
    const raw = mime([
      'From: Dental Officer <officer@mlks.test>',
      'To: intake@mlks.test',
      `Subject: Fwd: embedded ${seq}`,
      `Message-ID: <embedded-${seq}@mail.test>`,
      'Date: Wed, 17 Sep 2026 10:14:00 +0530',
      'Content-Type: multipart/related; boundary="r"',
      '',
      '--r',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Please log this.</p><p>Registrar<br><img src="cid:img1"></p>',
      '--r',
      `Content-Type: ${type}`,
      'Content-Transfer-Encoding: base64',
      'Content-ID: <img1>',
      'Content-Disposition: inline; filename="image001.png"',
      '',
      bytes.toString('base64'),
      '--r--',
      '',
    ]);
    return { parsed: await simpleParser(raw, { keepCidLinks: true }), raw };
  }

  it('does not file a signature logo as complaint material, but says it came', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await ingest(tx, await withEmbeddedImage(PNG));
      expect(out.attachmentsStored).toBe(0);
      expect(out.attachmentsSkipped).toBe(1);
      const rows = await tx.execute<{ skipped_reason: string | null }>(sql`
        SELECT skipped_reason FROM mail_attachment WHERE mail_message_id = ${out.mailMessageId}::uuid
      `);
      expect(rows.rows[0]!.skipped_reason).toMatch(/signature logo/);

      // Listed on the message, but no "not stored" warning on the card for it.
      const card = (await mail.tray(tx, ctx)).find((c) => c.id === out.mailMessageId);
      expect(card!.skipped_count).toBe(0);
    });
  });

  it('still keeps a photograph pasted into the body, which is embedded the same way', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      // A photo of a bill or of a patient's mouth runs to hundreds of kilobytes. The logo
      // rule is about size as well as placement so that this is never caught by it.
      const photo = Buffer.concat([PNG, Buffer.alloc(200 * 1024, 7)]);
      const out = await ingest(tx, await withEmbeddedImage(photo));
      expect(out.attachmentsStored).toBe(1);
      expect(out.attachmentsSkipped).toBe(0);
    });
  });

  /** The one-pixel PNG with its header rewritten to claim a size, padded to a weight. */
  function pngSized(width: number, height: number, pad = 0): Buffer {
    const b = Buffer.concat([PNG, Buffer.alloc(pad, 7)]);
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return b;
  }

  it('keeps a small SCREENSHOT pasted into the body, which weighs what a logo weighs', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      // A crop of a UPI payment confirmation: 12 KB, but 640 x 180 pixels. Filed by weight
      // alone it was a "logo", and the complainant's proof of payment was hidden.
      const out = await ingest(tx, await withEmbeddedImage(pngSized(640, 180, 12 * 1024)));
      expect(out.attachmentsStored).toBe(1);
    });
  });

  it('knows a GIF logo too, though GIF is not a kind the register stores', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const gif = Buffer.alloc(2048, 0);
      gif.write('GIF89a', 0, 'latin1');
      gif.writeUInt16LE(120, 6);
      gif.writeUInt16LE(40, 8);
      const out = await ingest(tx, await withEmbeddedImage(gif, 'image/gif'));

      const rows = await tx.execute<{ skipped_reason: string | null }>(sql`
        SELECT skipped_reason FROM mail_attachment WHERE mail_message_id = ${out.mailMessageId}::uuid
      `);
      // A logo, not "a kind the register does not store" - which would put a warning on
      // the card of every forward from a sender with a GIF in their signature.
      expect(rows.rows[0]!.skipped_reason).toMatch(/signature logo/);
      const card = (await mail.tray(tx, ctx)).find((c) => c.id === out.mailMessageId);
      expect(card!.skipped_count).toBe(0);
    });
  });
});

describe('when something fails part way', () => {
  // From an adversarial review of the attachment fixes. Each of these used to turn a
  // passing hiccup - or one malformed header - into a message that never reached the tray.

  /** A file store that refuses the first `failures` moves, then behaves. */
  class FlakyStorage extends LocalStorage {
    constructor(private failures: number) {
      super();
    }
    override async move(fromKey: string, toKey: string): Promise<void> {
      if (this.failures > 0) {
        this.failures--;
        throw new Error('the file store did not answer');
      }
      return super.move(fromKey, toKey);
    }
  }

  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  async function replyWithBill(caseNumber: string, messageId?: string) {
    seq++;
    const bytes = Buffer.from(
      [
        'From: Kavitha Devi <kdevi@example.in>',
        'To: intake@mlks.test',
        `Subject: Re: Documents required [${caseNumber}] ${seq}`,
        `Message-ID: ${messageId ?? `<reply-${seq}@mail.test>`}`,
        'Date: Thu, 18 Sep 2026 09:00:00 +0530',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Here are the bills.',
        '--b1',
        'Content-Type: image/png',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="bill.png"',
        '',
        PNG.toString('base64'),
        '--b1--',
        '',
      ].join('\r\n'),
      'utf8',
    );
    return { parsed: await simpleParser(bytes), raw: bytes };
  }

  it('files a reply even when its bill cannot be moved onto the case, and moves it next sweep', async () => {
    const flaky = new FlakyStorage(1);
    const flakyMail = new MailIntakeService(
      flaky, intake, correspondence, new DocumentsService(flaky), followups,
    );
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const opened = await mail.openCase(tx, ctx, {
        mailMessageId: (await ingest(tx, await forward(GMAIL_FORWARD))).mailMessageId,
      });
      const m = await replyWithBill(opened.caseNumber);
      const out = await flakyMail.ingest(tx, ctx, m.parsed, {
        mailbox: 'INBOX', uid: ++seq, uidValidity: '1', raw: m.raw,
      });

      // The reply is on the case; only the bill is waiting.
      expect(out.autoFiledTo).toBe(opened.caseFileId);
      const before = await documents.listForCase(tx, ctx, opened.caseFileId);
      expect(before.map((d) => d.filename)).not.toContain('bill.png');

      // The failed move left the file staged - the rows were rolled back, not the file lost
      // - so the retry finds it and puts it on the case.
      expect(await flakyMail.fileHeldAttachments(tx, ctx)).toBe(1);
      const after = await documents.listForCase(tx, ctx, opened.caseFileId);
      expect(after.map((d) => d.filename)).toContain('bill.png');
    });
  });

  it('fails the whole message, to be retried, when the file store will not take a file', async () => {
    // Recording the file as "not stored" and carrying on looked kinder. It was not: the
    // reply then filed itself without the bill and closed the reminder waiting for it.
    class RefusingStorage extends LocalStorage {
      override async write(): Promise<void> {
        throw new Error('the file store did not answer');
      }
    }
    const refusing = new RefusingStorage();
    const refusingMail = new MailIntakeService(
      refusing, intake, correspondence, new DocumentsService(refusing), followups,
    );
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const opened = await mail.openCase(tx, ctx, {
        mailMessageId: (await ingest(tx, await forward(GMAIL_FORWARD))).mailMessageId,
      });
      const m = await replyWithBill(opened.caseNumber);
      await expect(
        tx.transaction((sp) =>
          refusingMail.ingest(sp, ctx, m.parsed, { mailbox: 'INBOX', uid: ++seq, uidValidity: '1', raw: m.raw }),
        ),
      ).rejects.toThrow(/did not answer/);
    });
  });

  it('keeps retrying a failing message for ten minutes and ten attempts before giving up', () => {
    const start = 1_000_000;
    // Many quick failures during an outage: not yet.
    expect(givesUp({ count: 25, since: start }, start + 5 * 60_000)).toBe(false);
    // A long time, but few attempts (the reader was stopped): not yet.
    expect(givesUp({ count: 3, since: start }, start + 60 * 60_000)).toBe(false);
    // Both: this is about the message, not the moment.
    expect(givesUp({ count: 10, since: start }, start + 10 * 60_000)).toBe(true);
  });

  it('writes down a message it could not read, so it cannot vanish behind the cursor', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const m = await forward('Some body.', 'Fwd: something that broke');
      const meta = { mailbox: 'INBOX', uid: ++seq, uidValidity: '1', raw: m.raw };
      const id = await mail.recordUnreadable(tx, ctx, m.parsed, meta, 'a malformed part');
      expect(id).not.toBeNull();

      const card = (await mail.tray(tx, ctx)).find((c) => c.id === id);
      expect(card!.subject).toBe('Fwd: something that broke');
      expect(card!.suggestion_note).toMatch(/could not be read automatically \(a malformed part\)/i);
      // And it is the same message as far as the reader is concerned: seeing it again is a
      // duplicate, not a second card.
      expect((await mail.ingest(tx, ctx, m.parsed, meta)).duplicate).toBe(true);
    });
  });

  it('files two replies that share a Message-ID, rather than failing the second', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const opened = await mail.openCase(tx, ctx, {
        mailMessageId: (await ingest(tx, await forward(GMAIL_FORWARD))).mailMessageId,
      });
      const first = await ingest(tx, await replyWithBill(opened.caseNumber, '<same@mail.test>'));
      const second = await ingest(tx, await replyWithBill(opened.caseNumber, '<same@mail.test>'));
      expect(first.autoFiledTo).toBe(opened.caseFileId);
      expect(second.autoFiledTo).toBe(opened.caseFileId);
    });
  });

  it('stores a subject whose encoded-word decodes to a NUL, instead of failing on it', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      // "=?UTF-8?B?YQBi?=" is a, NUL, b. Postgres text cannot hold the NUL.
      const out = await ingest(tx, await forward('Body.', 'Fwd: =?UTF-8?B?YQBi?='));
      const row = await tx.execute<{ subject: string }>(sql`
        SELECT subject FROM mail_message WHERE id = ${out.mailMessageId}::uuid
      `);
      expect(row.rows[0]!.subject).toBe('Fwd: ab');
    });
  });
});

describe('finding the council the mailbox feeds', () => {
  // The regression. Run as the application role, SELECT id FROM council WHERE code = ...
  // returns NOTHING: row-level security compares against app.council_id, which is unset
  // until a council is chosen - and choosing one is the point of the query. It failed that
  // way the first time the real mailbox was connected, and no test had exercised it,
  // because every other test here hands ingest() a council id it already knows.
  it('finds it as the application role, through the scheduler scan exception', async () => {
    const found = await councilForMailbox('MLKS');
    expect(found.id).toBe(councilId);
    // And with the council's STORED configuration, not the compiled-in seed.
    expect(found.config.calendar.timezone).toBe('Asia/Kolkata');
  });

  it('says so plainly when the code matches no council', async () => {
    await expect(councilForMailbox('NOPE')).rejects.toThrow(/No council with the code NOPE/);
  });
});

describe('the read cursor', () => {
  // The regression. With the cursor keyed on the folder name alone, rows stored under
  // 'INBOX' from anywhere else - seeded, imported, or another account entirely - set the
  // high-water mark, and the reader skipped every real message below it. It fetched
  // nothing on the first real sweep for exactly that reason.
  it('is not moved by messages from a different account', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const m = await forward('from the old account');
      await mail.ingest(tx, ctx, m.parsed, {
        mailbox: 'old-account@gmail.com/INBOX',
        uid: 5000,
        uidValidity: '1',
        raw: m.raw,
      });

      expect(await mail.cursorFor(tx, ctx, 'new-account@gmail.com/INBOX')).toBeNull();
      expect(await mail.cursorFor(tx, ctx, 'old-account@gmail.com/INBOX')).toEqual({
        uid: 5000,
        uidValidity: '1',
      });
    });
  });
});

describe('the mail provider writing about its own account', () => {
  it('is set aside automatically, and RECORDED rather than dropped', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      seq++;
      const bytes = raw(
        {
          From: 'Google <no-reply@accounts.google.com>',
          To: 'intake@mlks.test',
          Subject: 'Security alert',
          'Message-ID': `<google-${seq}@accounts.google.com>`,
          Date: 'Thu, 18 Sep 2026 12:01:00 +0530',
          'Content-Type': 'text/plain; charset=utf-8',
        },
        'A new sign-in on Windows. If this was you, you do not need to do anything.',
      );
      const out = await ingest(tx, { parsed: await simpleParser(bytes), raw: bytes });

      expect(out.status).toBe('dismissed');
      // Not in the tray...
      const tray = await mail.tray(tx, ctx);
      expect(tray.some((m) => m.id === out.mailMessageId)).toBe(false);
      // ...but on the record, with a reason, because a message must not vanish.
      const kept = await mail.tray(tx, ctx, 'dismissed');
      const row = kept.find((m) => m.id === out.mailMessageId);
      expect(row).toBeDefined();
    });
  });

  it('also sets aside Google telling the account holder it shared data with an app', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      seq++;
      const bytes = raw(
        {
          From: 'Google <noreply-accounts@google.com>',
          To: 'intake@mlks.test',
          Subject: 'You shared some Google Account data with Example App',
          'Message-ID': `<google-share-${seq}@google.com>`,
          Date: 'Mon, 29 Sep 2026 10:00:00 +0530',
          'Content-Type': 'text/plain; charset=utf-8',
        },
        'You gave Example App access to some of your Google Account data.',
      );
      const out = await ingest(tx, { parsed: await simpleParser(bytes), raw: bytes });
      expect(out.status).toBe('dismissed');
    });
  });

  it('does not touch mail that merely mentions Google', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await ingest(
        tx,
        await forward('I found the clinic on Google Maps and the reviews were fine.'),
      );
      expect(out.status).toBe('unfiled');
    });
  });
});

describe('dismissing', () => {
  it('needs a reason, and keeps the message', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await ingest(tx, await forward('Buy cheap dental supplies!!', 'Special offer'));
      await expect(
        mail.dismiss(tx, ctx, { mailMessageId: out.mailMessageId, reason: '  ' }),
      ).rejects.toThrow(/say why/i);

      await mail.dismiss(tx, ctx, { mailMessageId: out.mailMessageId, reason: 'Advertising.' });
      const rows = await tx.execute<{ status: string; dismissed_reason: string }>(sql`
        SELECT status::text, dismissed_reason FROM mail_message
        WHERE id = ${out.mailMessageId}::uuid
      `);
      expect(rows.rows[0]!.status).toBe('dismissed');
      expect(rows.rows[0]!.dismissed_reason).toBe('Advertising.');
    });
  });

  it('will not dismiss a message that is already on a case', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const out = await ingest(tx, await forward(GMAIL_FORWARD));
      await mail.openCase(tx, ctx, { mailMessageId: out.mailMessageId });
      await expect(
        mail.dismiss(tx, ctx, { mailMessageId: out.mailMessageId, reason: 'changed my mind' }),
      ).rejects.toThrow(/on a case/i);
    });
  });
});
