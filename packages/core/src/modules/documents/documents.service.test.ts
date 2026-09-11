import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { closeDb, initDb, withCouncil, type Db, type Tx } from '@ksdc/db';
import { KSDC_CONFIG } from '@ksdc/config';
import { FollowupService, type EngineContext } from '../followups/followup.service.js';
import { CaseIntakeService } from '../cases/case-intake.service.js';
import { DocumentsService } from './documents.service.js';
import { LocalStorage, UnsupportedFileError, sniff, verifyStorageToken } from './storage.js';
import { seedCouncilAndOfficer } from '../../test-support/fixtures.js';

/**
 * Documents. Stored verbatim, identified by their bytes rather than by what the uploader
 * claimed, and keyed by UUIDs that carry no patient's name.
 */

let db: Db;
const councilId = '70707070-7070-4707-8707-707070707070';
const officerId = '80808080-8080-4808-8808-808080808080';

const followups = new FollowupService();
const intake = new CaseIntakeService(followups);
const ctx: EngineContext = { councilId, userId: officerId, config: KSDC_CONFIG };

let storage: LocalStorage;
let documents: DocumentsService;

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x22),
]);
const HEIC = Buffer.concat([
  Buffer.alloc(4, 0),
  Buffer.from('ftypheic'),
  Buffer.alloc(64, 0x33),
]);

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  process.env.STORAGE_ROOT = `${process.cwd()}/var/test-documents`;
  storage = new LocalStorage();
  documents = new DocumentsService(storage);
  await withCouncil({ councilId }, (tx) =>
    seedCouncilAndOfficer(tx, { councilId, officerId, code: 'DOCS' }),
  );
});

afterAll(async () => {
  await closeDb();
});

let serial = 0;
async function newCase(tx: Tx) {
  serial++;
  return intake.create(tx, ctx, {
    summary: `Document probe ${serial}`,
    receivedAt: new Date('2026-09-01T05:30:00Z'),
    complainant: { fullName: 'Smt. Test Complainant' },
  });
}

/** The whole round trip: ask for a URL, PUT the bytes, commit. */
async function upload(
  tx: Tx,
  caseFileId: string,
  bytes: Buffer,
  filename: string,
  claimedType = 'application/octet-stream',
) {
  const ticket = await documents.requestUpload(claimedType);
  await storage.write(ticket.storageKey, bytes);
  return documents.commit(tx, ctx, {
    caseFileId,
    storageKey: ticket.storageKey,
    title: filename,
    originalFilename: filename,
  });
}

describe('identifying a file', () => {
  it('recognises what the council actually receives', () => {
    expect(sniff(PDF)?.mimeType).toBe('application/pdf');
    expect(sniff(JPEG)?.mimeType).toBe('image/jpeg');
    expect(sniff(PNG)?.mimeType).toBe('image/png');
    // A patient photographing a bill on an iPhone is the common case, not an exotic one.
    expect(sniff(HEIC)?.mimeType).toBe('image/heic');
  });

  it('does not believe the content type the browser sent', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      // Claims to be a PDF; the bytes are a JPEG. The register records what it is.
      const result = await upload(tx, c.caseFileId, JPEG, 'scan.pdf', 'application/pdf');
      expect(result.mimeType).toBe('image/jpeg');
    });
  });

  it('refuses something that is neither a PDF nor an image', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const notADocument = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00');
      await expect(upload(tx, c.caseFileId, notADocument, 'bill.pdf')).rejects.toThrow(
        UnsupportedFileError,
      );
    });
  });

  it('refuses an empty file', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      await expect(upload(tx, c.caseFileId, Buffer.alloc(0), 'empty.pdf')).rejects.toThrow(
        /empty/i,
      );
    });
  });
});

describe('committing', () => {
  it('stores the file verbatim and records its hash', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const result = await upload(tx, c.caseFileId, PDF, 'treatment-bill.pdf');

      // Verbatim: what the complainant sent is what the register holds, byte for byte,
      // and the hash lets that be demonstrated rather than asserted.
      expect(result.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));
      expect(result.sizeBytes).toBe(PDF.length);

      const stored = await tx.execute<{ storage_key: string; original_filename: string }>(sql`
        SELECT storage_key, original_filename FROM document_version WHERE id = ${result.versionId}::uuid
      `);
      const bytes = await storage.read(stored.rows[0]!.storage_key);
      expect(bytes.equals(PDF)).toBe(true);
      expect(stored.rows[0]!.original_filename).toBe('treatment-bill.pdf');
    });
  });

  it('keys the object by a UUID that carries no patient name or filename', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const result = await upload(tx, c.caseFileId, PDF, 'Kavitha Devi - bill.pdf');
      const stored = await tx.execute<{ storage_key: string }>(
        sql`SELECT storage_key FROM document_version WHERE id = ${result.versionId}::uuid`,
      );
      const key = stored.rows[0]!.storage_key;

      // Keys reach logs, browser history and support tickets.
      expect(key).not.toMatch(/Kavitha/i);
      expect(key).not.toMatch(/bill/i);
      expect(key).toMatch(/^documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    });
  });

  it('moves the object out of staging', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const ticket = await documents.requestUpload('application/pdf');
      await storage.write(ticket.storageKey, PDF);
      await documents.commit(tx, ctx, {
        caseFileId: c.caseFileId,
        storageKey: ticket.storageKey,
        title: 'Bill',
        originalFilename: 'bill.pdf',
      });
      await expect(storage.read(ticket.storageKey)).rejects.toThrow();
    });
  });

  it('refuses to commit anything that did not come through staging', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      await expect(
        documents.commit(tx, ctx, {
          caseFileId: c.caseFileId,
          storageKey: 'documents/somewhere-else',
          title: 'x',
          originalFilename: 'x.pdf',
        }),
      ).rejects.toThrow(/freshly uploaded/i);
    });
  });

  it('adds a version rather than replacing the file', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const first = await upload(tx, c.caseFileId, PDF, 'bill.pdf');

      const ticket = await documents.requestUpload('image/jpeg');
      await storage.write(ticket.storageKey, JPEG);
      const second = await documents.commit(tx, ctx, {
        caseFileId: c.caseFileId,
        storageKey: ticket.storageKey,
        title: 'Bill',
        originalFilename: 'bill-rescanned.jpg',
        documentId: first.documentId,
      });

      expect(second.documentId).toBe(first.documentId);
      const versions = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM document_version WHERE document_id = ${first.documentId}::uuid`,
      );
      // Versions are immutable; the earlier scan is still there.
      expect(versions.rows[0]!.n).toBe(2);
      const original = await storage.read(
        (
          await tx.execute<{ storage_key: string }>(
            sql`SELECT storage_key FROM document_version WHERE id = ${first.versionId}::uuid`,
          )
        ).rows[0]!.storage_key,
      );
      expect(original.equals(PDF)).toBe(true);
    });
  });

  it('refuses to attach a version to a document on another case', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const a = await newCase(tx);
      const b = await newCase(tx);
      const onA = await upload(tx, a.caseFileId, PDF, 'a.pdf');

      const ticket = await documents.requestUpload('application/pdf');
      await storage.write(ticket.storageKey, PDF);
      await expect(
        documents.commit(tx, ctx, {
          caseFileId: b.caseFileId,
          storageKey: ticket.storageKey,
          title: 'x',
          originalFilename: 'x.pdf',
          documentId: onA.documentId,
        }),
      ).rejects.toThrow(/not on this case/i);
    });
  });
});

describe('downloading', () => {
  it('issues a five-minute link and logs it the moment it is issued', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const doc = await upload(tx, c.caseFileId, PDF, 'bill.pdf');

      const link = await documents.downloadUrl(tx, ctx, {
        documentId: doc.documentId,
        ip: '10.0.0.1',
      });

      const minutes = (link.expiresAt.getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(4);
      expect(minutes).toBeLessThanOrEqual(5);
      // The filename is attached to the link, since the key itself carries none.
      expect(link.filename).toBe('bill.pdf');

      const log = await tx.execute<{ action: string; app_user_id: string; ip: string }>(sql`
        SELECT action, app_user_id, ip FROM document_access_log
        WHERE document_version_id = ${doc.versionId}::uuid
      `);
      // Logged on issue, not on download: the link is what leaves our control.
      expect(log.rows[0]!.action).toBe('signed_url_issued');
      expect(log.rows[0]!.app_user_id).toBe(officerId);
      expect(log.rows[0]!.ip).toBe('10.0.0.1');
    });
  });

  it('signs the link so it cannot be edited into another key', async () => {
    const signed = await storage.signedDownload({
      storageKey: 'documents/x/y',
      filename: 'b.pdf',
      contentType: 'application/pdf',
    });
    const url = new URL(signed.url);
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig')!;

    expect(verifyStorageToken('documents/x/y', 'get', exp, sig)).toBe(true);
    // Point it at another case's document and the signature no longer matches.
    expect(verifyStorageToken('documents/x/other', 'get', exp, sig)).toBe(false);
    expect(verifyStorageToken('documents/x/y', 'get', Date.now() - 1000, sig)).toBe(false);
  });
});

describe('a misfiled document', () => {
  it('is withdrawn and quarantined, never deleted', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const doc = await upload(tx, c.caseFileId, PDF, 'wrong-patient.pdf');
      const before = await tx.execute<{ storage_key: string }>(
        sql`SELECT storage_key FROM document_version WHERE id = ${doc.versionId}::uuid`,
      );

      await documents.markMisfiled(tx, ctx, {
        documentId: doc.documentId,
        reason: "Patient A's OPG was attached to patient B's case",
      });

      const after = await tx.execute<{ status: string; misfiled_reason: string }>(
        sql`SELECT status, misfiled_reason FROM document WHERE id = ${doc.documentId}::uuid`,
      );
      expect(after.rows[0]!.status).toBe('misfiled_withdrawn');
      expect(after.rows[0]!.misfiled_reason).toMatch(/patient A/i);

      const moved = await tx.execute<{ storage_key: string }>(
        sql`SELECT storage_key FROM document_version WHERE id = ${doc.versionId}::uuid`,
      );
      expect(moved.rows[0]!.storage_key).toMatch(/^quarantine-misfiled\//);
      // Nothing is destroyed - the bytes are still there, just where nothing reads.
      expect((await storage.read(moved.rows[0]!.storage_key)).equals(PDF)).toBe(true);
      await expect(storage.read(before.rows[0]!.storage_key)).rejects.toThrow();
    });
  });

  it('requires a reason', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const doc = await upload(tx, c.caseFileId, PDF, 'x.pdf');
      await expect(
        documents.markMisfiled(tx, ctx, { documentId: doc.documentId, reason: '  ' }),
      ).rejects.toThrow(/requires a reason/i);
    });
  });

  it('cannot be downloaded afterwards', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const doc = await upload(tx, c.caseFileId, PDF, 'x.pdf');
      await documents.markMisfiled(tx, ctx, { documentId: doc.documentId, reason: 'wrong case' });
      await expect(
        documents.downloadUrl(tx, ctx, { documentId: doc.documentId }),
      ).rejects.toThrow(/withdrawn as misfiled/i);
    });
  });

  it('disappears from the case list', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const keep = await upload(tx, c.caseFileId, PDF, 'keep.pdf');
      const drop = await upload(tx, c.caseFileId, JPEG, 'drop.jpg');
      await documents.markMisfiled(tx, ctx, { documentId: drop.documentId, reason: 'wrong case' });

      const listed = await documents.listForCase(tx, ctx, c.caseFileId);
      const stored = listed.filter((d) => d.status === 'stored');
      expect(stored.map((d) => d.id)).toEqual([keep.documentId]);
    });
  });
});

describe('the case document list', () => {
  it('flags what may never be summarised', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const ticket = await documents.requestUpload('application/pdf');
      await storage.write(ticket.storageKey, PDF);
      await documents.commit(tx, ctx, {
        caseFileId: c.caseFileId,
        storageKey: ticket.storageKey,
        title: 'GDCRI expert report',
        originalFilename: 'report.pdf',
        documentClass: 'expert_report',
      });

      const listed = await documents.listForCase(tx, ctx, c.caseFileId);
      const report = listed.find((d) => d.documentClass === 'expert_report')!;
      // It carries the negligence finding. No AI path ever reaches it, and no status
      // field ever paraphrases it.
      expect(report.mayBeSummarised).toBe(false);
    });
  });

  it('tracks a physical original the council is holding', async () => {
    await withCouncil({ councilId, userId: officerId }, async (tx) => {
      const c = await newCase(tx);
      const ticket = await documents.requestUpload('application/pdf');
      await storage.write(ticket.storageKey, PDF);
      const doc = await documents.commit(tx, ctx, {
        caseFileId: c.caseFileId,
        storageKey: ticket.storageKey,
        title: 'Original OPG film',
        originalFilename: 'opg.pdf',
        physicalOriginalHeld: true,
      });

      let listed = await documents.listForCase(tx, ctx, c.caseFileId);
      expect(listed.find((d) => d.id === doc.documentId)!.physicalOriginalHeld).toBe(true);

      await documents.recordOriginalReturned(tx, ctx, {
        documentId: doc.documentId,
        returnedAt: new Date('2026-09-20T00:00:00Z'),
      });
      listed = await documents.listForCase(tx, ctx, c.caseFileId);
      expect(listed.find((d) => d.id === doc.documentId)!.physicalReturnedAt).toBeTruthy();
    });
  });
});

describe('the local storage adapter', () => {
  it('refuses a key that climbs out of the storage root', async () => {
    // Keys are server-generated UUIDs, so this should be impossible - but commit takes a
    // key from the client, and "should be impossible" is not a check.
    await expect(storage.read('../../../etc/passwd')).rejects.toThrow(/escapes the root/i);
  });
});
