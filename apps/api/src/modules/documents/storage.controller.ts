import { BadRequestException, Controller, Get, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../auth/auth.guard.js';
import { LocalStorage, MAX_UPLOAD_BYTES, StoragePort, verifyStorageToken } from './storage.js';

/**
 * The local storage endpoint: the thing a signed upload URL points at when there is no
 * GCS bucket, so the whole upload flow works on a laptop with no cloud account.
 *
 * It is `@Public()` because a signed URL carries its own authority — that is the point of
 * one. The signature covers the key, the operation and the expiry, so a link cannot be
 * edited to reach another case's document, and it is dead in five minutes.
 *
 * Registered only when STORAGE_DRIVER is not `gcs`; against a real bucket the browser
 * talks to Google directly and never comes here.
 */
@Controller('storage/local')
export class StorageController {
  constructor(private readonly storage: StoragePort) {}

  private local(): LocalStorage {
    if (!(this.storage instanceof LocalStorage)) {
      throw new BadRequestException('This endpoint exists only for local storage.');
    }
    return this.storage;
  }

  private check(req: FastifyRequest, op: 'put' | 'get'): string {
    const q = req.query as Record<string, string | undefined>;
    const key = q.key;
    const exp = Number(q.exp);
    const sig = q.sig;
    if (!key || !sig || !verifyStorageToken(key, op, exp, sig)) {
      // Expired and forged are the same answer. A caller learns nothing either way.
      throw new BadRequestException('That link is not valid, or has expired.');
    }
    return key;
  }

  @Public()
  @Put()
  async upload(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const key = this.check(req, 'put');
    const body = req.body;
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body as ArrayBuffer);

    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(
        `That file is larger than ${MAX_UPLOAD_BYTES / 1_048_576} MB.`,
      );
    }
    await this.local().write(key, bytes);
    reply.status(200);
    return { stored: bytes.length };
  }

  @Public()
  @Get()
  async download(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const key = this.check(req, 'get');
    const q = req.query as Record<string, string | undefined>;
    const bytes = await this.local().read(key);

    // The object key is a UUID, so the human-readable name is attached here rather than
    // baked into storage where it would end up in logs and browser history.
    const filename = (q.filename ?? 'document').replace(/["\r\n]/g, '');
    reply
      .header('content-type', q.type ?? 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'private, no-store')
      .send(bytes);
  }
}
