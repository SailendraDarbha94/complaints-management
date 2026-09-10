import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Tx } from '@ksdc/db';
import type { DocumentClass } from '@ksdc/contracts';
import { NEVER_SUMMARISE } from '@ksdc/contracts';
import type { EngineContext } from '../followups/followup.service.js';
import {
  DOCUMENTS_PREFIX,
  MAX_UPLOAD_BYTES,
  QUARANTINE_PREFIX,
  StoragePort,
  UnsupportedFileError,
  sniff,
} from './storage.js';
import { DomainError } from '../../common/domain-error.js';

/**
 * Case documents.
 *
 * Files are stored verbatim, per the officer's instruction: no conversion, no extraction,
 * no re-encoding. What the complainant sent is what the register holds, byte for byte,
 * with a sha256 recorded so that can be demonstrated rather than asserted.
 */

export interface UploadTicket {
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  storageKey: string;
  expiresAt: Date;
  maxBytes: number;
}

export interface CommittedDocument {
  documentId: string;
  versionId: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
}

@Injectable()
export class DocumentsService {
  private readonly log = new Logger('documents');

  constructor(private readonly storage: StoragePort) {}

  /** Step one: a URL the browser PUTs the bytes to, bypassing the API entirely. */
  async requestUpload(contentType: string): Promise<UploadTicket> {
    const signed = await this.storage.signedUpload({
      contentType: contentType || 'application/octet-stream',
      maxBytes: MAX_UPLOAD_BYTES,
    });
    return {
      uploadUrl: signed.url,
      method: signed.method,
      headers: signed.headers,
      storageKey: signed.storageKey,
      expiresAt: signed.expiresAt,
      maxBytes: signed.maxBytes,
    };
  }

  /**
   * Step two: check what actually landed, then file it.
   *
   * The size and the type are re-established from the bytes, never taken from the client.
   * A staged object that fails either check is left in staging and never becomes part of
   * the record.
   */
  async commit(
    tx: Tx,
    ctx: EngineContext,
    args: {
      caseFileId: string;
      storageKey: string;
      title: string;
      originalFilename: string;
      documentClass?: DocumentClass;
      physicalOriginalHeld?: boolean;
      /** Adds a version to an existing document rather than creating a new one. */
      documentId?: string;
    },
  ): Promise<CommittedDocument> {
    if (!args.storageKey.startsWith('staging/')) {
      throw new DomainError('Only a freshly uploaded object can be committed.');
    }

    const size = await this.storage.size(args.storageKey);
    if (size === 0) throw new DomainError('That file is empty.');
    if (size > MAX_UPLOAD_BYTES) {
      throw new DomainError(
        `That file is ${Math.round(size / 1_048_576)} MB. The limit is ` +
          `${MAX_UPLOAD_BYTES / 1_048_576} MB.`,
      );
    }

    const bytes = await this.storage.read(args.storageKey);
    const kind = sniff(bytes);
    if (!kind) throw new UnsupportedFileError(args.originalFilename);

    const sha256 = createHash('sha256').update(bytes).digest('hex');

    // The permanent key is a UUID and nothing else: no patient name, no filename. Keys
    // reach logs, browser history and support tickets.
    const finalKey = `${DOCUMENTS_PREFIX}${ctx.councilId}/${randomUUID()}`;
    await this.storage.move(args.storageKey, finalKey);

    let documentId = args.documentId;
    if (documentId) {
      const owns = await tx.execute<{ id: string }>(sql`
        SELECT id FROM document
        WHERE id = ${documentId}::uuid AND case_file_id = ${args.caseFileId}::uuid
      `);
      if (owns.rows.length === 0) throw new DomainError('That document is not on this case.');
    } else {
      const created = await tx.execute<{ id: string }>(sql`
        INSERT INTO document (council_id, case_file_id, title, document_class,
                              physical_original_held, created_by)
        VALUES (${ctx.councilId}::uuid, ${args.caseFileId}::uuid, ${args.title},
                ${args.documentClass ?? 'complaint_material'}::document_class,
                ${args.physicalOriginalHeld ?? false}, ${ctx.userId ?? null})
        RETURNING id
      `);
      documentId = created.rows[0]!.id;
    }

    const nextVersion = await tx.execute<{ n: number }>(sql`
      SELECT coalesce(max(version_no), 0) + 1 AS n FROM document_version
      WHERE document_id = ${documentId}::uuid
    `);

    const version = await tx.execute<{ id: string }>(sql`
      INSERT INTO document_version (council_id, document_id, version_no, storage_key,
                                    original_filename, mime_type, size_bytes, sha256, uploaded_by)
      VALUES (${ctx.councilId}::uuid, ${documentId}::uuid, ${Number(nextVersion.rows[0]!.n)},
              ${finalKey}, ${args.originalFilename}, ${kind.mimeType}, ${size}, ${sha256},
              ${ctx.userId ?? null})
      RETURNING id
    `);

    await tx.execute(sql`
      UPDATE document SET current_version_id = ${version.rows[0]!.id}::uuid
      WHERE id = ${documentId}::uuid
    `);

    return {
      documentId,
      versionId: version.rows[0]!.id,
      sha256,
      mimeType: kind.mimeType,
      sizeBytes: size,
    };
  }

  /**
   * A five-minute link, logged the moment it is issued.
   *
   * Logged on issue rather than on download, because the link is what leaves our control.
   * Whether the recipient clicks it is not something we can observe.
   */
  async downloadUrl(
    tx: Tx,
    ctx: EngineContext,
    args: { documentId: string; ip?: string | null; userAgent?: string | null },
  ): Promise<{ url: string; expiresAt: Date; filename: string }> {
    const row = await tx.execute<{
      version_id: string;
      storage_key: string;
      original_filename: string;
      mime_type: string;
      status: string;
    }>(sql`
      SELECT dv.id AS version_id, dv.storage_key, dv.original_filename, dv.mime_type, d.status
      FROM document d
      JOIN document_version dv ON dv.id = d.current_version_id
      WHERE d.id = ${args.documentId}::uuid
    `);
    const doc = row.rows[0];
    if (!doc) throw new DomainError('Document not found.');
    if (doc.status !== 'stored') {
      throw new DomainError('That document was withdrawn as misfiled and is not available.');
    }

    const signed = await this.storage.signedDownload({
      storageKey: doc.storage_key,
      filename: doc.original_filename,
      contentType: doc.mime_type,
    });

    await tx.execute(sql`
      INSERT INTO document_access_log (council_id, document_version_id, app_user_id, action,
                                       ip, user_agent)
      VALUES (${ctx.councilId}::uuid, ${doc.version_id}::uuid, ${ctx.userId ?? null},
              'signed_url_issued', ${args.ip ?? null}, ${args.userAgent ?? null})
    `);

    return { url: signed.url, expiresAt: signed.expiresAt, filename: doc.original_filename };
  }

  /**
   * The 11pm mistake: patient A's OPG filed on patient B's case.
   *
   * Nothing is deleted — the application role has no DELETE grant, and on a legal record
   * deletion is the wrong instinct anyway. The object moves to a quarantine prefix that
   * no case sheet, bundle or export reads, the row is marked withdrawn with a reason, and
   * the audit trail keeps the whole story.
   */
  async markMisfiled(
    tx: Tx,
    ctx: EngineContext,
    args: { documentId: string; reason: string },
  ): Promise<void> {
    if (!args.reason?.trim()) {
      throw new DomainError('Withdrawing a document requires a reason. It stays in the record.');
    }

    const versions = await tx.execute<{ id: string; storage_key: string }>(sql`
      SELECT dv.id, dv.storage_key FROM document_version dv
      WHERE dv.document_id = ${args.documentId}::uuid
    `);
    if (versions.rows.length === 0) throw new DomainError('Document not found.');

    for (const v of versions.rows) {
      if (v.storage_key.startsWith(QUARANTINE_PREFIX)) continue;
      const quarantineKey = `${QUARANTINE_PREFIX}${ctx.councilId}/${randomUUID()}`;
      await this.storage.move(v.storage_key, quarantineKey);
      await tx.execute(sql`
        UPDATE document_version SET storage_key = ${quarantineKey} WHERE id = ${v.id}::uuid
      `);
    }

    await tx.execute(sql`
      UPDATE document
      SET status = 'misfiled_withdrawn'::document_status, misfiled_reason = ${args.reason}
      WHERE id = ${args.documentId}::uuid
    `);
    this.log.warn(`document ${args.documentId} withdrawn as misfiled: ${args.reason}`);
  }

  /** Physical originals the council is holding, and when they went back. */
  async recordOriginalReturned(
    tx: Tx,
    _ctx: EngineContext,
    args: { documentId: string; returnedAt: Date },
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE document SET physical_returned_at = ${args.returnedAt}
      WHERE id = ${args.documentId}::uuid AND physical_original_held = true
    `);
  }

  async listForCase(tx: Tx, _ctx: EngineContext, caseFileId: string) {
    const rows = await tx.execute<{
      id: string;
      title: string;
      document_class: DocumentClass;
      status: string;
      original_filename: string;
      mime_type: string;
      size_bytes: string;
      sha256: string;
      version_no: number;
      physical_original_held: boolean;
      physical_returned_at: Date | null;
      created_at: Date;
    }>(sql`
      SELECT d.id, d.title, d.document_class, d.status, d.physical_original_held,
             d.physical_returned_at, d.created_at,
             dv.original_filename, dv.mime_type, dv.size_bytes, dv.sha256, dv.version_no
      FROM document d
      JOIN document_version dv ON dv.id = d.current_version_id
      WHERE d.case_file_id = ${caseFileId}::uuid
      ORDER BY d.created_at
    `);

    return rows.rows.map((r) => ({
      id: r.id,
      title: r.title,
      documentClass: r.document_class,
      status: r.status,
      filename: r.original_filename,
      mimeType: r.mime_type,
      sizeBytes: Number(r.size_bytes),
      sha256: r.sha256,
      versionNo: r.version_no,
      physicalOriginalHeld: r.physical_original_held,
      physicalReturnedAt: r.physical_returned_at,
      // The expert report and the respondent's own explanation are never summarised,
      // paraphrased or extracted into a status field - by anyone, including Phase 6's AI.
      mayBeSummarised: !NEVER_SUMMARISE.includes(r.document_class),
    }));
  }
}
