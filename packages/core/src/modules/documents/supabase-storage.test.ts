import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseStorage } from './supabase-storage.js';
import { DOCUMENTS_PREFIX, STAGING_PREFIX } from './storage.js';

/**
 * The Supabase storage adapter, against a real bucket.
 *
 * This is an integration test and there is no way to make it a unit test worth having.
 * Every defect this adapter has had came from a difference between what the client library
 * claims and what the service does: info() returning `size` as OPTIONAL, move() being a
 * server-side rename rather than copy-then-delete, a signed upload URL carrying its
 * authority in a query parameter rather than a header. A mock would have agreed with
 * whatever I believed at the time and taught me nothing.
 *
 * It runs against a THROWAWAY bucket created and destroyed here, never against
 * case-documents - the register's real files are evidence and no test goes near them.
 *
 * SKIPS ITSELF when SUPABASE_URL and SUPABASE_SECRET_KEY are absent, so a fresh clone runs
 * the other 340-odd tests without a Supabase account. The no-Docker rule survives: nothing
 * here needs a container, only an internet connection and keys.
 */

const URL_ = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(URL_ && SECRET);

// A bucket per run, so two runs cannot collide and a crashed run leaves one obvious orphan.
const TEST_BUCKET = `ksdc-adapter-test-${randomUUID().slice(0, 8)}`;

const admin = configured ? createClient(URL_!, SECRET!) : null;
let storage: SupabaseStorage;

/** A payload with real binary in it: a PDF header, high bytes, and a NUL. */
const PAYLOAD = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0x0a, 0x1b]),
  Buffer.from('radiograph bytes, not text\n', 'latin1'),
  Buffer.from([0xde, 0xad, 0xbe, 0xef]),
]);
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

/** Upload through the signed URL exactly as a browser would. */
async function putToSignedUrl(url: string, bytes: Buffer, contentType: string): Promise<number> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(bytes),
  });
  return res.status;
}

beforeAll(async () => {
  if (!configured) return;
  process.env.SUPABASE_STORAGE_BUCKET = TEST_BUCKET;
  const { error } = await admin!.storage.createBucket(TEST_BUCKET, {
    public: false,
    fileSizeLimit: 52428800,
  });
  if (error) throw new Error(`could not create the test bucket: ${error.message}`);
  storage = new SupabaseStorage();
}, 60_000);

afterAll(async () => {
  if (!configured) return;

  // Emptying a bucket is TWO problems, and this cleanup got both of them wrong.
  //
  // First: it used to list each prefix and remove what came back, which silently did
  // nothing. list('documents') returns the IMMEDIATE children of that prefix, and for keys
  // shaped `documents/<documentId>/<versionId>` those children are the <documentId>
  // FOLDERS, not the objects inside them. remove() on a folder path is a no-op.
  //
  // Second: emptyBucket() returns before the server has finished, so deleting straight
  // afterwards races it and fails with "The bucket you tried to delete is not empty".
  //
  // Neither failure was ever reported, because nothing checked the error. Thirteen orphan
  // buckets accumulated in the live project before anyone looked.
  await admin!.storage.emptyBucket(TEST_BUCKET);

  let dropped = await admin!.storage.deleteBucket(TEST_BUCKET);
  for (let attempt = 0; dropped.error && attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    await admin!.storage.emptyBucket(TEST_BUCKET);
    dropped = await admin!.storage.deleteBucket(TEST_BUCKET);
  }
  delete process.env.SUPABASE_STORAGE_BUCKET;

  // Fail loudly rather than littering quietly. A test that leaves rubbish in a live
  // project is a test that will one day be the reason a quota is hit on a Friday evening.
  if (dropped.error) {
    throw new Error(`the test bucket ${TEST_BUCKET} was left behind: ${dropped.error.message}`);
  }
}, 60_000);

describe.runIf(configured)('the Supabase storage adapter', () => {
  it('signs an upload that a plain PUT can use', async () => {
    const signed = await storage.signedUpload({ contentType: 'application/pdf', maxBytes: 50 });

    expect(signed.method).toBe('PUT');
    expect(signed.url).toContain(TEST_BUCKET);
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The key is a bare UUID under staging/. No filename and no patient name, because keys
    // travel in logs, in browser history and in support tickets.
    expect(signed.storageKey.startsWith(STAGING_PREFIX)).toBe(true);
    const id = signed.storageKey.slice(STAGING_PREFIX.length);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    expect(await putToSignedUrl(signed.url, PAYLOAD, 'application/pdf')).toBe(200);
  }, 60_000);

  it('reads the bytes back EXACTLY, which is the whole promise', async () => {
    const signed = await storage.signedUpload({ contentType: 'application/pdf', maxBytes: 50 });
    await putToSignedUrl(signed.url, PAYLOAD, 'application/pdf');

    const back = await storage.read(signed.storageKey);

    // Verbatim is not a nicety here. A re-encoded radiograph is a different file with a
    // different hash, and the sha256 on the document version would stop matching the
    // evidence it is supposed to identify.
    expect(createHash('sha256').update(back).digest('hex')).toBe(PAYLOAD_SHA);
    expect(back.equals(PAYLOAD)).toBe(true);
  }, 60_000);

  it('reports the size, and the size is the real byte count', async () => {
    const signed = await storage.signedUpload({ contentType: 'application/pdf', maxBytes: 50 });
    await putToSignedUrl(signed.url, PAYLOAD, 'application/pdf');

    // The commit path checks the declared length against this. It is also the call whose
    // type says `size?: number` - optional - which is why the adapter refuses rather than
    // recording a zero-byte version when it is missing.
    expect(await storage.size(signed.storageKey)).toBe(PAYLOAD.length);
  }, 60_000);

  it('moves an object without needing permission to delete one', async () => {
    const signed = await storage.signedUpload({ contentType: 'application/pdf', maxBytes: 50 });
    await putToSignedUrl(signed.url, PAYLOAD, 'application/pdf');

    const destination = `${DOCUMENTS_PREFIX}${randomUUID()}/${randomUUID()}`;
    await storage.move(signed.storageKey, destination);

    // Arrived intact...
    expect((await storage.read(destination)).equals(PAYLOAD)).toBe(true);
    // ...and the staging key is gone, so a commit cannot be replayed against it.
    await expect(storage.read(signed.storageKey)).rejects.toThrow();
  }, 60_000);

  it('signs a download that serves the bytes under the human filename', async () => {
    const signed = await storage.signedUpload({ contentType: 'application/pdf', maxBytes: 50 });
    await putToSignedUrl(signed.url, PAYLOAD, 'application/pdf');

    const dl = await storage.signedDownload({
      storageKey: signed.storageKey,
      filename: 'treatment bill.pdf',
      contentType: 'application/pdf',
    });
    expect(dl.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const res = await fetch(dl.url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PAYLOAD)).toBe(true);
    // The key is a UUID; the readable name is applied at the edge, not stored. Supabase
    // percent-encodes it, which browsers undo - so decode before asserting rather than
    // pinning the test to an encoding detail.
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^attachment/);
    expect(decodeURIComponent(disposition)).toContain('treatment bill.pdf');
  }, 60_000);

  it('refuses the same object without a signature', async () => {
    const signed = await storage.signedUpload({ contentType: 'application/pdf', maxBytes: 50 });
    await putToSignedUrl(signed.url, PAYLOAD, 'application/pdf');

    const naked = `${URL_}/storage/v1/object/${TEST_BUCKET}/${signed.storageKey}`;
    const res = await fetch(naked);
    expect(res.status).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('is invisible to an anonymous caller even while it holds an object', async () => {
    const signed = await storage.signedUpload({ contentType: 'application/pdf', maxBytes: 50 });
    await putToSignedUrl(signed.url, PAYLOAD, 'application/pdf');

    const anon = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!anon) return; // nothing to assert without a client key

    const res = await fetch(`${URL_}/storage/v1/object/list/${TEST_BUCKET}`, {
      method: 'POST',
      headers: { apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 50 }),
    });
    const rows = (await res.json()) as unknown[];
    // No policies on storage.objects means deny by default. An object exists; anon sees none.
    expect(Array.isArray(rows) ? rows : []).toEqual([]);
  }, 60_000);

  it('turns a missing object into a DomainError, not a raw client failure', async () => {
    const missing = `${STAGING_PREFIX}${randomUUID()}`;

    // A 400 the officer caused reads as a refusal; anything else becomes "something went
    // wrong at our end", which tells them nothing and hides a real fault in the same noise.
    await expect(storage.read(missing)).rejects.toMatchObject({ isDomainError: true });
    await expect(storage.size(missing)).rejects.toMatchObject({ isDomainError: true });
    await expect(storage.move(missing, `${DOCUMENTS_PREFIX}${randomUUID()}`)).rejects.toMatchObject(
      { isDomainError: true },
    );
  }, 60_000);

  it('says which credential is missing rather than failing obscurely', async () => {
    const url = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    try {
      // Async, so it rejects rather than throwing - and a plain Error rather than a
      // DomainError, because a missing credential is the operator's problem, not the
      // officer's, and must not be dressed up as a 400 they could act on.
      await expect(
        new SupabaseStorage().signedUpload({ contentType: 'application/pdf', maxBytes: 1 }),
      ).rejects.toThrow(/SUPABASE_URL/);
    } finally {
      process.env.SUPABASE_URL = url;
    }
  });
});

describe.runIf(!configured)('the Supabase storage adapter', () => {
  it('is skipped because no Supabase credentials are configured', () => {
    // Deliberately visible rather than silent: a suite that quietly stops covering the
    // storage adapter is worse than one that says it has.
    expect(configured).toBe(false);
  });
});
