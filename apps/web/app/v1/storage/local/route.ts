import type { NextRequest } from 'next/server';
import { DomainError, LocalStorage, MAX_UPLOAD_BYTES, type StoragePort } from '@ksdc/core';
// The package barrel does not re-export the token check. It is imported from the module
// that defines it rather than reimplemented here: this endpoint's entire security is that
// one HMAC matching the one the signer produced, and a second copy of it would drift.
import { verifyStorageToken } from '@ksdc/core/modules/documents/storage';
import { withPublic } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The local storage endpoint: the thing a signed upload URL points at when there is no
 * GCS bucket, so the whole upload flow works on a laptop with no cloud account.
 *
 * Both handlers are public because a signed URL carries its own authority — that is the
 * point of one. The signature covers the key, the operation and the expiry, so a link
 * cannot be edited to reach another case's document, and it is dead in five minutes.
 *
 * Nest registered this controller only when STORAGE_DRIVER was not `gcs`. A route file has
 * no such switch — it is reachable the moment it exists — so the driver check below is now
 * the only gate: against a real bucket the browser talks to Google directly, and anything
 * arriving here is refused rather than written to a disk nobody reads.
 */
const SIGNED_URL_REASON =
  'A signed URL carries its own authority: the HMAC covers the key, the operation and ' +
  'the expiry, so the link itself is the credential and the browser sending the bytes ' +
  'has no session to present.';

function local(storage: StoragePort): LocalStorage {
  if (!(storage instanceof LocalStorage)) {
    throw new DomainError('This endpoint exists only for local storage.');
  }
  return storage;
}

function check(req: NextRequest, op: 'put' | 'get'): string {
  const q = req.nextUrl.searchParams;
  const key = q.get('key');
  const exp = Number(q.get('exp') ?? undefined);
  const sig = q.get('sig');
  if (!key || !sig || !verifyStorageToken(key, op, exp, sig)) {
    // Expired and forged are the same answer. A caller learns nothing either way.
    throw new DomainError('That link is not valid, or has expired.');
  }
  return key;
}

export const PUT = withPublic(SIGNED_URL_REASON, async ({ req, services }) => {
  const key = check(req, 'put');
  // Raw bytes of whatever content type the browser is sending. Fastify needed a custom
  // parser registered for this; here the body is simply never parsed.
  const bytes = Buffer.from(await req.arrayBuffer());

  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new DomainError(`That file is larger than ${MAX_UPLOAD_BYTES / 1_048_576} MB.`);
  }
  await local(services.storage).write(key, bytes);
  return { stored: bytes.length };
});

export const GET = withPublic(SIGNED_URL_REASON, async ({ req, services }) => {
  const key = check(req, 'get');
  const q = req.nextUrl.searchParams;
  const bytes = await local(services.storage).read(key);

  // The object key is a UUID, so the human-readable name is attached here rather than
  // baked into storage where it would end up in logs and browser history.
  const filename = (q.get('filename') ?? 'document').replace(/["\r\n]/g, '');

  // A Node Buffer is not a BodyInit: it is a view into a pooled buffer typed
  // ArrayBufferLike, which the fetch types reject because that union includes
  // SharedArrayBuffer. Copying into a fresh ArrayBuffer settles both problems at once -
  // the type is exact, and there is no chance of handing back the pool, which holds other
  // files' bytes. This driver is the local-disk one, so the copy costs nothing that
  // matters.
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);

  return new Response(body, {
    headers: {
      'content-type': q.get('type') ?? 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  });
});
