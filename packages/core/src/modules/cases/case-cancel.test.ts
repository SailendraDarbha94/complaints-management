import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import { closeDb, initDb, withCouncil, type Db, type Tx } from '@ksdc/db';
import { KSDC_CONFIG } from '@ksdc/config';
import { parseCaseNumber } from '@ksdc/contracts';
import { FollowupService, type EngineContext } from '../followups/followup.service.js';
import { QueueService } from '../followups/queue.service.js';
import { CorrespondenceService } from '../correspondence/correspondence.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { LocalStorage } from '../documents/storage.js';
import { MailIntakeService } from '../mail/mail-intake.service.js';
import { matchMessage } from '../mail/matching.js';
import { RegisterService, REGISTER_CANCELLED_STATUS } from '../register/register.service.js';
import { RtiService } from '../rti/rti.service.js';
import { CaseIntakeService } from './case-intake.service.js';
import { CANCEL_EVENT, CaseLifecycleService, RESTORE_EVENT } from './case-lifecycle.service.js';
import { workingCaseList } from './case-list.js';
import { RespondentService } from './respondent.service.js';
import { seedCouncilAndOfficer } from '../../test-support/fixtures.js';

/**
 * Cancelling a case opened in error - what the officer's "delete" became.
 *
 * The promises being tested, in the order the officer would notice them broken:
 *   - a cancellation always says why, and the database insists on it too;
 *   - the case disappears from every working list, and its chase stops with it;
 *   - it does NOT disappear from the register, and its number is never reused;
 *   - nothing more can be written onto it;
 *   - restoring it puts it back exactly where it stood, chase and all.
 *
 * Nothing is deleted here any more than anywhere else, so every test works on cases it
 * creates itself and asserts on those, never on a count across the council.
 */

let db: Db;
const councilId = 'ca9ce111-1111-4111-8111-111111111111';
const officer = 'ca9ce222-2222-4222-8222-222222222222';

const followups = new FollowupService();
const lifecycle = new CaseLifecycleService(followups);
const intake = new CaseIntakeService(followups);
const queue = new QueueService();
const register = new RegisterService();
const respondents = new RespondentService();
const correspondence = new CorrespondenceService(lifecycle, followups);
const storage = new LocalStorage();
const documents = new DocumentsService(storage);
const mail = new MailIntakeService(storage, intake, correspondence, documents, followups);
const rti = new RtiService();
const ctx: EngineContext = { councilId, userId: officer, config: KSDC_CONFIG };

const RECEIVED = new Date('2026-09-01T05:30:00Z');
const TODAY = '2026-09-29';
const REASON = 'Duplicate of an earlier complaint by the same patient';

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId, userId: officer }, async (tx) => {
    await seedCouncilAndOfficer(tx, { councilId, officerId: officer, code: 'CNCL' });
    await correspondence.seedTemplates(tx, ctx);
  });
});

afterAll(async () => {
  await closeDb();
});

async function newCase(tx: Tx, summary = 'Crown came off within a week', email = 'kdevi@example.in') {
  return intake.create(tx, ctx, {
    summary,
    receivedAt: RECEIVED,
    complainant: { fullName: 'Smt. Kavitha Devi', mobile: '9845012345', email },
  });
}

async function caseRow(tx: Tx, caseFileId: string) {
  const r = await tx.execute<{
    state: string;
    deleted_at: Date | null;
    deletion_reason: string | null;
    deleted_by: string | null;
  }>(sql`SELECT state, deleted_at, deletion_reason, deleted_by FROM case_file
         WHERE id = ${caseFileId}::uuid`);
  return r.rows[0]!;
}

async function queueCaseIds(tx: Tx): Promise<Array<string | null>> {
  const q = await queue.today(tx, ctx, TODAY);
  return q.byUrgency.flatMap((g) => g.items).map((i) => i.caseFileId);
}

/** A message as a mail server would hand it over. */
function raw(headers: Record<string, string>, body: string): Buffer {
  return Buffer.from(
    [...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n'),
    'utf8',
  );
}

let seq = 0;
async function ingestMessage(tx: Tx, args: { from: string; subject: string; body: string }) {
  seq++;
  const bytes = raw(
    {
      From: args.from,
      To: 'intake@cncl.test',
      Subject: args.subject,
      'Message-ID': `<cancel-${seq}-${Date.now()}@mail.test>`,
      Date: 'Mon, 29 Sep 2026 10:00:00 +0530',
      'Content-Type': 'text/plain; charset=utf-8',
    },
    args.body,
  );
  return mail.ingest(tx, ctx, await simpleParser(bytes), {
    mailbox: 'INBOX',
    uid: seq,
    uidValidity: '1',
    raw: bytes,
  });
}

// A one-pixel PNG, standing in for the complainant's bill. sniff() reads the bytes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** The complainant's own email, with the bill attached - what a duplicate is usually opened from. */
async function ingestWithBill(tx: Tx, args: { from: string; subject: string }) {
  seq++;
  const bytes = Buffer.from(
    [
      `From: ${args.from}`,
      'To: intake@cncl.test',
      `Subject: ${args.subject}`,
      `Message-ID: <cancel-bill-${seq}-${Date.now()}@mail.test>`,
      'Date: Mon, 29 Sep 2026 10:00:00 +0530',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'The crown came off within a week. The bill is attached.',
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
  return mail.ingest(tx, ctx, await simpleParser(bytes), {
    mailbox: 'INBOX',
    uid: seq,
    uidValidity: '1',
    raw: bytes,
  });
}

async function messageRow(tx: Tx, mailMessageId: string) {
  const r = await tx.execute<{ status: string; case_file_id: string | null }>(
    sql`SELECT status, case_file_id FROM mail_message WHERE id = ${mailMessageId}::uuid`,
  );
  return r.rows[0]!;
}

async function inboundLetters(tx: Tx, caseFileId: string): Promise<number> {
  const r = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM correspondence
    WHERE case_file_id = ${caseFileId}::uuid AND direction = 'in'
  `);
  return r.rows[0]!.n;
}

describe('the reason', () => {
  it('is required, and a token one is refused in words the officer can act on', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      for (const reason of ['', '    ', 'x', ' dup ']) {
        await expect(lifecycle.cancel(tx, ctx, { caseFileId: c.caseFileId, reason })).rejects.toThrow(
          /few words why this case was opened in error/,
        );
      }
      // Refused means nothing changed.
      expect((await caseRow(tx, c.caseFileId)).deleted_at).toBeNull();
    });
  });

  it('is insisted on by the database too, so no other path can leave a number unexplained', async () => {
    const { caseFileId } = await withCouncil({ councilId, userId: officer }, (tx) => newCase(tx));
    await expect(
      withCouncil({ councilId, userId: officer }, async (tx) => {
        await tx.execute(sql`UPDATE case_file SET deleted_at = now() WHERE id = ${caseFileId}::uuid`);
      }),
    ).rejects.toThrow(/case_file_deleted_needs_reason/);
  });
});

describe('cancelling', () => {
  it('marks the case, leaves its state alone, stops its chase and says so in the history', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      await lifecycle.apply(tx, ctx, { caseFileId: c.caseFileId, event: 'REQUEST_DOCUMENTS', occurredAt: RECEIVED });
      expect((await followups.liveForCase(tx, ctx, c.caseFileId)).length).toBeGreaterThan(0);

      const out = await lifecycle.cancel(tx, ctx, { caseFileId: c.caseFileId, reason: `  ${REASON}  ` });
      expect(out.caseNumber).toBe(c.caseNumber);
      expect(out.followupsCancelled).toBeGreaterThan(0);

      const row = await caseRow(tx, c.caseFileId);
      expect(row.deleted_at).not.toBeNull();
      expect(row.deletion_reason).toBe(REASON); // trimmed
      expect(row.deleted_by).toBe(officer);
      // Untouched, so a restore puts the case back exactly where it stood.
      expect(row.state).toBe('awaiting_complainant_documents');

      // Nothing live, and what was live says why it stopped.
      expect(await followups.liveForCase(tx, ctx, c.caseFileId)).toEqual([]);
      const stopped = await tx.execute<{ status: string; resolution_note: string | null }>(sql`
        SELECT status, resolution_note FROM follow_up
        WHERE case_file_id = ${c.caseFileId}::uuid AND stage = 'await_patient_docs'
      `);
      expect(stopped.rows[0]).toMatchObject({ status: 'cancelled' });
      expect(stopped.rows[0]!.resolution_note).toContain(REASON);

      const history = await tx.execute<{ event: string; reason: string | null; from_state: string; to_state: string }>(sql`
        SELECT event, reason, from_state, to_state FROM case_state_history
        WHERE case_file_id = ${c.caseFileId}::uuid AND event = ${CANCEL_EVENT}
      `);
      expect(history.rows).toEqual([
        {
          event: CANCEL_EVENT,
          reason: REASON,
          from_state: 'awaiting_complainant_documents',
          to_state: 'awaiting_complainant_documents',
        },
      ]);

      // Through the audit trigger like every other write, attributed to the officer.
      const audit = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM audit.events
        WHERE entity_table = 'case_file' AND entity_id = ${c.caseFileId}::uuid
          AND action = 'case_file.update'
          AND after ->> 'deletion_reason' = ${REASON}
          AND actor_user_id = ${officer}::uuid
      `);
      expect(audit.rows[0]!.n).toBe(1);
    });
  });

  it('refuses to cancel a case that is already cancelled, and changes nothing', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      await lifecycle.cancel(tx, ctx, { caseFileId: c.caseFileId, reason: REASON });
      const before = await caseRow(tx, c.caseFileId);

      await expect(
        lifecycle.cancel(tx, ctx, { caseFileId: c.caseFileId, reason: 'A second, different reason' }),
      ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already cancelled/) });

      expect(await caseRow(tx, c.caseFileId)).toEqual(before);
    });
  });

  it('refuses a case that is not in this register', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      await expect(
        lifecycle.cancel(tx, ctx, { caseFileId: crypto.randomUUID(), reason: REASON }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});

describe('a cancelled case, on the working lists', () => {
  it('is gone from the cases list, which is also the "Add to a case" picker', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const keep = await newCase(tx, 'A real complaint');
      const drop = await newCase(tx, 'Opened twice by mistake');
      await lifecycle.cancel(tx, ctx, { caseFileId: drop.caseFileId, reason: REASON });

      const ids = (await workingCaseList(tx, ctx)).map((r) => r.id);
      expect(ids).toContain(keep.caseFileId);
      expect(ids).not.toContain(drop.caseFileId);
    });
  });

  it('is gone from Today, and the nightly sweep does not flag it as having no next step', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      expect(await queueCaseIds(tx)).toContain(c.caseFileId);

      await lifecycle.cancel(tx, ctx, { caseFileId: c.caseFileId, reason: REASON });
      expect(await queueCaseIds(tx)).not.toContain(c.caseFileId);

      // The sweep's whole job is to notice a case with nothing scheduled. A cancelled case
      // is SUPPOSED to have nothing scheduled.
      await followups.sweepNoNextStep(tx, ctx);
      expect(await followups.liveForCase(tx, ctx, c.caseFileId)).toEqual([]);
      expect(await queueCaseIds(tx)).not.toContain(c.caseFileId);
    });
  });

  it('is never matched by mail: not by its number, not by its complainant, not as a suggestion', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx, 'Opened from the tray by mistake', 'cancelled-sender@example.in');
      await lifecycle.cancel(tx, ctx, { caseFileId: c.caseFileId, reason: REASON });

      // The number in the subject: would have filed itself on a live case.
      const byNumber = await matchMessage(tx, ctx, 'CNCL', {
        subject: `Re: ${c.caseNumber} documents`,
        body: '',
        senderAddresses: [],
      });
      expect(byNumber.autoFile).toBeNull();
      expect(byNumber.candidates.map((x) => x.caseFileId)).not.toContain(c.caseFileId);
      // And the officer is told why a reply quoting a good number did not file itself.
      expect(byNumber.note).toMatch(/cancelled as opened in error/);

      // The complainant's address: would have been offered as a suggestion.
      const bySender = await matchMessage(tx, ctx, 'CNCL', {
        subject: 'My bills',
        body: '',
        senderAddresses: ['cancelled-sender@example.in'],
      });
      expect(bySender.candidates.map((x) => x.caseFileId)).not.toContain(c.caseFileId);

      // End to end through the tray: it lands unfiled, not on the cancelled case.
      const ingested = await ingestMessage(tx, {
        from: 'Kavitha Devi <cancelled-sender@example.in>',
        subject: `Re: ${c.caseNumber}`,
        body: 'Please find my bills attached.',
      });
      expect(ingested.status).toBe('unfiled');
      expect(ingested.autoFiledTo).toBeNull();
    });
  });

  it('stops being the tray card\'s stored suggestion once it is cancelled', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx, 'Suggested, then cancelled', 'suggested-then-cancelled@example.in');
      const ingested = await ingestMessage(tx, {
        from: 'Kavitha Devi <suggested-then-cancelled@example.in>',
        subject: 'More about my complaint',
        body: 'I forgot to mention the date of the second visit.',
      });
      const before = (await mail.tray(tx, ctx)).find((m) => m.id === ingested.mailMessageId)!;
      expect(before.suggested_case_file_id).toBe(c.caseFileId);

      await lifecycle.cancel(tx, ctx, { caseFileId: c.caseFileId, reason: REASON });

      const after = (await mail.tray(tx, ctx)).find((m) => m.id === ingested.mailMessageId)!;
      expect(after.suggested_case_file_id).toBeNull();
      expect(after.suggested_case_number).toBeNull();
      // The note described that suggestion, so it goes with it.
      expect(after.suggestion_note).toBeNull();
    });
  });

  it('does not count towards a dentist\'s history, but the dentist can still be named', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const live = await newCase(tx, 'Root canal left unfinished');
      const dup = await newCase(tx, 'Root canal left unfinished (entered twice)');
      const hebbar = await respondents.add(tx, ctx, {
        caseFileId: live.caseFileId,
        fullName: 'Dr Cancelcheck Hebbar',
      });
      await respondents.add(tx, ctx, { caseFileId: dup.caseFileId, partyId: hebbar.partyId });
      await lifecycle.cancel(tx, ctx, { caseFileId: dup.caseFileId, reason: REASON });

      const found = await respondents.search(tx, ctx, 'Cancelcheck Hebbar');
      const h = found.find((x) => x.partyId === hebbar.partyId)!;
      // "Named on two other cases" in front of a committee must not include a duplicate.
      expect(h.priorCases).toBe(1);
      expect(h.priorCaseNumbers).toEqual([live.caseNumber]);

      // Named ONLY on a cancelled case: still offered, because the party row exists and a
      // second record for the same dentist is exactly what the suggestions exist to stop.
      const test = await newCase(tx, 'Test entry');
      const shetty = await respondents.add(tx, ctx, {
        caseFileId: test.caseFileId,
        fullName: 'Dr Onlycancelled Shetty',
      });
      await lifecycle.cancel(tx, ctx, { caseFileId: test.caseFileId, reason: 'Test entry, not a complaint' });

      const again = await respondents.search(tx, ctx, 'Onlycancelled');
      expect(again.find((x) => x.partyId === shetty.partyId)).toMatchObject({
        priorCases: 0,
        priorCaseNumbers: [],
        because: expect.stringMatching(/only on a case cancelled as opened in error/),
      });
    });
  });
});

describe('a cancelled case, in the register', () => {
  it('is still listed, marked cancelled with when and why, and its number is not reused', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const a = await newCase(tx, 'The one opened in error');
      await lifecycle.cancel(tx, ctx, { caseFileId: a.caseFileId, reason: REASON });
      const b = await newCase(tx, 'The next real complaint');

      // Serials in a legal register: the next case takes the next number, not the freed one.
      expect(b.caseNumber).not.toBe(a.caseNumber);
      expect(parseCaseNumber(b.caseNumber)!.serial).toBe(parseCaseNumber(a.caseNumber)!.serial + 1);
      expect(b.registerSlNo).toBe(a.registerSlNo + 1);

      const rows = await register.rows(tx, ctx);
      const row = rows.find((r) => r['Case No.'] === a.caseNumber)!;
      expect(row).toBeDefined();
      expect(row['Sl. No.']).toBe(a.registerSlNo);
      expect(row['Status']).toBe(REGISTER_CANCELLED_STATUS);
      expect(row['Cancellation reason']).toBe(REASON);
      expect(row['Cancelled on']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Not waiting on anyone, and not a number that grows every day.
      expect(row['Waiting on']).toBe('nobody');
      expect(row['Days waiting']).toBeNull();
      // The shape of the book did not change under it: the columns 0015 renamed are still
      // there by their new names, and the two new ones were appended at the end.
      expect(Object.keys(row)).toContain('Order dispatched on');
      expect(Object.keys(row).slice(-2)).toEqual(['Cancellation reason', 'Cancelled on']);

      // A live case says nothing in the new columns.
      const live = rows.find((r) => r['Case No.'] === b.caseNumber)!;
      expect(live['Status']).toBe('intake_received');
      expect(live['Cancelled on']).toBeNull();
      expect(live['Cancellation reason']).toBeNull();

      // The "still open" view is a working list, and leaves it out.
      const open = await register.rows(tx, ctx, { includeClosed: false });
      expect(open.map((r) => r['Case No.'])).not.toContain(a.caseNumber);
      expect(open.map((r) => r['Case No.'])).toContain(b.caseNumber);

      // And the export says, on its face, what a cancelled row is.
      const out = await register.csv(tx, ctx);
      expect(out.content).toContain(a.caseNumber);
      expect(out.content).toMatch(/cancelled as opened in error/);
      expect(out.content).toMatch(/Nothing was deleted/);
    });
  });
});

describe('writing onto a cancelled case', () => {
  it('is refused everywhere it matters, with a 409 that says what happened', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      // Drafted while the case was live; the click that would record it as sent comes after.
      const ack = await correspondence.draft(tx, ctx, { caseFileId: c.caseFileId, kind: 'ack_complaint' });
      const message = await ingestMessage(tx, {
        from: 'Someone Else <someone-else@example.in>',
        subject: 'A different matter altogether',
        body: 'Nothing to do with any case yet.',
      });
      await lifecycle.cancel(tx, ctx, { caseFileId: c.caseFileId, reason: REASON });

      const refused = { status: 409, message: expect.stringMatching(/cancelled as opened in error/) };

      await expect(
        lifecycle.apply(tx, ctx, { caseFileId: c.caseFileId, event: 'REQUEST_DOCUMENTS' }),
      ).rejects.toMatchObject({ ...refused, name: 'CaseCancelledError' });
      await expect(
        respondents.add(tx, ctx, { caseFileId: c.caseFileId, fullName: 'Dr Too Late' }),
      ).rejects.toMatchObject(refused);
      await expect(
        correspondence.draft(tx, ctx, { caseFileId: c.caseFileId, kind: 'request_docs' }),
      ).rejects.toMatchObject(refused);
      await expect(
        correspondence.markSent(tx, ctx, { correspondenceId: ack.correspondenceId, sentAt: new Date() }),
      ).rejects.toMatchObject(refused);
      await expect(
        documents.commit(tx, ctx, {
          caseFileId: c.caseFileId,
          storageKey: 'staging/never-uploaded',
          title: 'bill.pdf',
          originalFilename: 'bill.pdf',
        }),
      ).rejects.toMatchObject(refused);
      await expect(
        mail.fileOnCase(tx, ctx, { mailMessageId: message.mailMessageId, caseFileId: c.caseFileId }),
      ).rejects.toMatchObject(refused);
      await expect(
        rti.linkCase(tx, ctx, { rtiRequestId: crypto.randomUUID(), caseFileId: c.caseFileId }),
      ).rejects.toMatchObject(refused);

      // And none of them wrote anything on the way to being refused.
      const sent = await tx.execute<{ sent_at: Date | null }>(
        sql`SELECT sent_at FROM correspondence WHERE id = ${ack.correspondenceId}::uuid`,
      );
      expect(sent.rows[0]!.sent_at).toBeNull();
      const m = await tx.execute<{ status: string; case_file_id: string | null }>(
        sql`SELECT status, case_file_id FROM mail_message WHERE id = ${message.mailMessageId}::uuid`,
      );
      expect(m.rows[0]).toEqual({ status: 'unfiled', case_file_id: null });
      const named = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM case_respondent WHERE case_file_id = ${c.caseFileId}::uuid`,
      );
      expect(named.rows[0]!.n).toBe(0);
      expect((await caseRow(tx, c.caseFileId)).state).toBe('intake_received');
    });
  });
});

describe('the mail filed on a cancelled case', () => {
  // The two commonest reasons to cancel are both about a message opened as a case from the
  // tray. Left filed on the cancelled case, that message could be neither moved nor set
  // aside - the tray refuses both for a message that is on a case - so it goes back to the
  // tray. See mail/cancelled-case.

  it("goes back to the tray, so a duplicate's email and its bill can reach the real case", async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      // The complaint, typed in from the paper letter...
      const real = await newCase(tx, 'Crown came off within a week (from the letter)');
      // ...and the complainant's own email of it, opened from the tray as a second case.
      const message = await ingestWithBill(tx, {
        from: 'Kavitha Devi <duplicate-sender@example.in>',
        subject: 'Complaint about my crown',
      });
      const dup = await mail.openCase(tx, ctx, { mailMessageId: message.mailMessageId });
      expect(dup.documentsFiled).toBe(1);
      const [dupDoc] = await documents.listForCase(tx, ctx, dup.caseFileId);

      const reason = `Duplicate of ${real.caseNumber}`;
      const out = await lifecycle.cancel(tx, ctx, { caseFileId: dup.caseFileId, reason });
      expect(out.mailReturnedToTray).toBe(1);

      // Back in the tray, still saying where it had been - on the card and on its page.
      expect(await messageRow(tx, message.mailMessageId)).toEqual({
        status: 'unfiled',
        case_file_id: dup.caseFileId,
      });
      const card = (await mail.tray(tx, ctx)).find((m) => m.id === message.mailMessageId)!;
      expect(card.suggestion_note).toContain(dup.caseNumber);
      expect(card.suggestion_note).toContain(reason);
      const page = await mail.get(tx, ctx, message.mailMessageId);
      expect(page!.message.case_deleted_at).not.toBeNull();
      expect(page!.message.case_deletion_reason).toBe(reason);

      // Added to the real case: the complainant's words and the bill both arrive there.
      const filed = await mail.fileOnCase(tx, ctx, {
        mailMessageId: message.mailMessageId,
        caseFileId: real.caseFileId,
      });
      expect(filed.documentsFiled).toBe(1);
      const realDocs = await documents.listForCase(tx, ctx, real.caseFileId);
      expect(realDocs.map((d) => d.filename)).toEqual(['bill.png']);
      expect(realDocs[0]!.sha256).toBe(dupDoc!.sha256); // the same bytes, hashed again
      expect(await inboundLetters(tx, real.caseFileId)).toBe(1);
      expect(await messageRow(tx, message.mailMessageId)).toEqual({
        status: 'filed',
        case_file_id: real.caseFileId,
      });
      const attachment = await tx.execute<{ document_id: string | null }>(sql`
        SELECT document_id FROM mail_attachment WHERE mail_message_id = ${message.mailMessageId}::uuid
      `);
      expect(attachment.rows[0]!.document_id).toBe(realDocs[0]!.id);

      // Copied, not moved: the cancelled case still shows what it held.
      expect((await documents.listForCase(tx, ctx, dup.caseFileId)).map((d) => d.id)).toEqual([dupDoc!.id]);
      expect(await inboundLetters(tx, dup.caseFileId)).toBe(1);

      // Restoring the duplicate later does not pull the message back off the real case.
      const restored = await lifecycle.restore(tx, ctx, { caseFileId: dup.caseFileId });
      expect(restored.mailRefiled).toBe(0);
      expect((await messageRow(tx, message.mailMessageId)).case_file_id).toBe(real.caseFileId);
    });
  });

  it('can be marked not a complaint once the case opened from it is cancelled', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const message = await ingestMessage(tx, {
        from: 'Chair Sales <offers@dental-chairs.example>',
        subject: 'Special offer on dental chairs',
        body: 'Buy two, get the third at half price.',
      });
      const opened = await mail.openCase(tx, ctx, { mailMessageId: message.mailMessageId });
      await lifecycle.cancel(tx, ctx, {
        caseFileId: opened.caseFileId,
        reason: 'Not a complaint - an advertisement',
      });

      await mail.dismiss(tx, ctx, { mailMessageId: message.mailMessageId, reason: 'An advertisement' });
      expect((await messageRow(tx, message.mailMessageId)).status).toBe('dismissed');

      // A restore after that leaves the officer's later decision alone.
      const restored = await lifecycle.restore(tx, ctx, { caseFileId: opened.caseFileId });
      expect(restored.mailRefiled).toBe(0);
      expect((await messageRow(tx, message.mailMessageId)).status).toBe('dismissed');
    });
  });

  it('is filed back on the case when the case is restored, if nobody has moved it since', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const message = await ingestWithBill(tx, {
        from: 'Kavitha Devi <restored-sender@example.in>',
        subject: 'My complaint about the crown',
      });
      const opened = await mail.openCase(tx, ctx, { mailMessageId: message.mailMessageId });
      const docsBefore = (await documents.listForCase(tx, ctx, opened.caseFileId)).map((d) => d.id);

      await lifecycle.cancel(tx, ctx, { caseFileId: opened.caseFileId, reason: REASON });
      const restored = await lifecycle.restore(tx, ctx, { caseFileId: opened.caseFileId });
      expect(restored.mailRefiled).toBe(1);

      expect(await messageRow(tx, message.mailMessageId)).toEqual({
        status: 'filed',
        case_file_id: opened.caseFileId,
      });
      expect((await mail.tray(tx, ctx)).map((m) => m.id)).not.toContain(message.mailMessageId);
      // Its letter and its file never left the case, so nothing is doubled.
      expect(await inboundLetters(tx, opened.caseFileId)).toBe(1);
      expect((await documents.listForCase(tx, ctx, opened.caseFileId)).map((d) => d.id)).toEqual(docsBefore);
    });
  });
});

describe('a cancelled case, on an RTI file it is linked to', () => {
  it('is still listed, with the reason, because the Council still holds its record', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx, 'The complaint an applicant later asked about');
      const { rtiRequestId } = await rti.receive(tx, ctx, {
        receivedOn: '2026-09-01',
        receivedVia: 'post',
        applicantName: 'Mr S. Kumar',
        applicantAddressLines: ['12, 4th Cross', 'Jayanagar', 'Bengaluru 560011'],
        requestText: `Please furnish copies of the file of complaint ${c.caseNumber}.`,
        applicationFeeReceived: true,
        caseFileIds: [c.caseFileId],
      });
      await lifecycle.cancel(tx, ctx, { caseFileId: c.caseFileId, reason: REASON });

      // Not "this application is not linked to a case", with the thirty days running.
      const file = await rti.get(tx, ctx, rtiRequestId);
      expect(file!.cases).toEqual([
        expect.objectContaining({
          case_file_id: c.caseFileId,
          case_number: c.caseNumber,
          deleted_at: expect.anything(),
          deletion_reason: REASON,
        }),
      ]);
    });
  });
});

describe('restoring', () => {
  it('puts the case back on every list, where it stood, with the chase it had', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      await lifecycle.apply(tx, ctx, { caseFileId: c.caseFileId, event: 'REQUEST_DOCUMENTS', occurredAt: RECEIVED });
      const chaseBefore = (await followups.liveForCase(tx, ctx, c.caseFileId)).map((f) => ({
        stage: f.stage,
        dueOn: f.dueOn,
        id: f.id,
      }));
      expect(chaseBefore.length).toBeGreaterThan(0);

      await lifecycle.cancel(tx, ctx, { caseFileId: c.caseFileId, reason: REASON });
      const out = await lifecycle.restore(tx, ctx, { caseFileId: c.caseFileId });
      expect(out.caseNumber).toBe(c.caseNumber);
      expect(out.followupsReopened).toBe(chaseBefore.length);

      const row = await caseRow(tx, c.caseFileId);
      expect(row).toMatchObject({
        deleted_at: null,
        deletion_reason: null,
        deleted_by: null,
        state: 'awaiting_complainant_documents',
      });

      // The same obligations, due on the SAME dates - time spent cancelled by mistake was
      // time nobody chased, and the reminder says so - as new rows, so the record still
      // shows the chase was stopped.
      const chaseAfter = await followups.liveForCase(tx, ctx, c.caseFileId);
      expect(chaseAfter.map((f) => ({ stage: f.stage, dueOn: f.dueOn }))).toEqual(
        chaseBefore.map((f) => ({ stage: f.stage, dueOn: f.dueOn })),
      );
      for (const f of chaseAfter) expect(chaseBefore.map((b) => b.id)).not.toContain(f.id);

      expect((await workingCaseList(tx, ctx)).map((r) => r.id)).toContain(c.caseFileId);
      expect(await queueCaseIds(tx)).toContain(c.caseFileId);
      const reg = (await register.rows(tx, ctx)).find((r) => r['Case No.'] === c.caseNumber)!;
      expect(reg['Status']).toBe('awaiting_complainant_documents');
      expect(reg['Cancelled on']).toBeNull();

      // The history says both halves, so the case page does not look as if nothing happened.
      const history = await tx.execute<{ event: string; reason: string | null }>(sql`
        SELECT event, reason FROM case_state_history
        WHERE case_file_id = ${c.caseFileId}::uuid AND event IN (${CANCEL_EVENT}, ${RESTORE_EVENT})
        ORDER BY occurred_at, event -- the two can share a millisecond in a test this fast
      `);
      expect(history.rows.map((h) => h.event)).toEqual([CANCEL_EVENT, RESTORE_EVENT]);
      expect(history.rows[1]!.reason).toContain(REASON);

      // And it can be worked again.
      await expect(
        lifecycle.apply(tx, ctx, { caseFileId: c.caseFileId, event: 'DOCUMENTS_RECEIVED' }),
      ).resolves.toMatchObject({ to: 'under_scrutiny' });
    });
  });

  it('flags the case at once when nothing was scheduled on it', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      // Dismiss the only reminder, so the case is cancelled with nothing live at all. There
      // is then nothing to bring back, and a restore that stopped there would return the
      // case to the lists with no next step and nobody told.
      for (const f of await followups.liveForCase(tx, ctx, c.caseFileId)) {
        await followups.dismiss(tx, ctx, { followUpId: f.id, reason: 'Acknowledged by phone' });
      }
      await lifecycle.cancel(tx, ctx, { caseFileId: c.caseFileId, reason: REASON });
      await lifecycle.restore(tx, ctx, { caseFileId: c.caseFileId });

      const live = await followups.liveForCase(tx, ctx, c.caseFileId);
      expect(live.map((f) => f.stage)).toEqual(['no_next_step']);
    });
  });

  it('refuses a case that is not cancelled', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      await expect(lifecycle.restore(tx, ctx, { caseFileId: c.caseFileId })).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/not cancelled/),
      });
    });
  });

  it('can be followed by a second cancellation, which is recorded afresh', async () => {
    await withCouncil({ councilId, userId: officer }, async (tx) => {
      const c = await newCase(tx);
      await lifecycle.cancel(tx, ctx, { caseFileId: c.caseFileId, reason: REASON });
      await lifecycle.restore(tx, ctx, { caseFileId: c.caseFileId });
      await lifecycle.cancel(tx, ctx, { caseFileId: c.caseFileId, reason: 'Test entry after all' });

      expect((await caseRow(tx, c.caseFileId)).deletion_reason).toBe('Test entry after all');
      expect(await followups.liveForCase(tx, ctx, c.caseFileId)).toEqual([]);
    });
  });
});
