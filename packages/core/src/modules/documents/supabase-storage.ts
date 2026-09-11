import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '../../common/logger.js';
import { DomainError } from '../../common/domain-error.js';
import {
  StoragePort,
  type SignedDownload,
  type SignedUpload,
  STAGING_PREFIX,
} from './storage.js';

/**
 * Supabase Storage.
 *
 * The same port as the local and GCS adapters, so nothing above it changes. Four things
 * about this adapter are worth knowing before it is switched on:
 *
 *   The bucket must be PRIVATE. A public bucket serves every object to anyone holding the
 *   key, and object keys travel in logs and browser history. Private plus signed URLs is
 *   the only configuration this code supports.
 *
 *   Image transformation must stay OFF, and this adapter never requests one. Documents are
 *   stored verbatim because they are evidence: a re-encoded radiograph is a different file
 *   with a different hash, and the sha256 recorded against the document version would no
 *   longer match what comes back.
 *
 *   Supabase's own database backups do NOT include Storage objects. Whatever bucket this
 *   points at needs its own copy. Verify this before moving real case files - see
 *   docs/adr/0002.
 *
 *   Credentials: SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY, which must live only in
 *   server processes. That key bypasses row-level security, so it must never reach the
 *   browser or the React Native app - those talk to Supabase with the user's own session
 *   and are constrained by storage policies instead.
 */

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'case-documents';

/** Supabase's signed upload URLs are valid for two hours and the window is not tunable. */
const UPLOAD_TTL_SECONDS = 2 * 60 * 60;
const DOWNLOAD_TTL_SECONDS = 5 * 60;

export class SupabaseStorage extends StoragePort {
  readonly kind = 'supabase' as const;
  private readonly log = new Logger('storage:supabase');
  private client: SupabaseClient | undefined;

  private sb(): SupabaseClient {
    if (this.client) return this.client;

    const url = process.env.SUPABASE_URL;
    // New-style secret key (sb_secret_...) or the legacy service_role JWT.
    const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        'STORAGE_DRIVER=supabase needs SUPABASE_URL and SUPABASE_SECRET_KEY. The ' +
          'secret key is a server-only credential: it bypasses row-level security, so it ' +
          'must never be given to the browser or the mobile app.',
      );
    }

    this.client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return this.client;
  }

  private bucket() {
    return this.sb().storage.from(BUCKET);
  }

  async signedUpload(args: { contentType: string; maxBytes: number }): Promise<SignedUpload> {
    const storageKey = `${STAGING_PREFIX}${crypto.randomUUID()}`;
    const { data, error } = await this.bucket().createSignedUploadUrl(storageKey);
    if (error || !data) {
      throw new DomainError(`Could not prepare the upload: ${error?.message ?? 'no URL returned'}`);
    }

    return {
      url: data.signedUrl,
      method: 'PUT',
      // Supabase carries the authorisation in the URL's token parameter, so no header is
      // needed for it. The content type is sent so the object is stored with one, but it
      // is never trusted: the bytes are sniffed on commit and a file whose contents
      // disagree with its claim is refused.
      headers: { 'content-type': args.contentType },
      storageKey,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000),
      maxBytes: args.maxBytes,
    };
  }

  async signedDownload(args: {
    storageKey: string;
    filename: string;
    contentType: string;
  }): Promise<SignedDownload> {
    // `download: <name>` puts the filename in the content-disposition Supabase serves, so
    // the object key stays a bare UUID and the human-readable name is applied at the edge.
    const { data, error } = await this.bucket().createSignedUrl(
      args.storageKey,
      DOWNLOAD_TTL_SECONDS,
      { download: args.filename },
    );
    if (error || !data) {
      throw new DomainError(`Could not prepare the download: ${error?.message ?? 'no URL returned'}`);
    }

    return {
      url: data.signedUrl,
      expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000),
    };
  }

  async read(storageKey: string): Promise<Buffer> {
    const { data, error } = await this.bucket().download(storageKey);
    if (error || !data) {
      throw new DomainError(`Could not read ${storageKey}: ${error?.message ?? 'not found'}`);
    }
    return Buffer.from(await data.arrayBuffer());
  }

  async size(storageKey: string): Promise<number> {
    const { data, error } = await this.bucket().info(storageKey);
    if (error || !data) {
      throw new DomainError(`Could not stat ${storageKey}: ${error?.message ?? 'not found'}`);
    }
    // FileObjectV2.size is OPTIONAL in the client's types. An upload whose size Supabase
    // cannot report must not silently become a zero-byte document version, because that
    // number is what the commit path checks the declared length against.
    if (typeof data.size !== 'number') {
      throw new DomainError(
        `Supabase did not report a size for ${storageKey}. Refusing to record a document ` +
          'version whose length is unknown.',
      );
    }
    return data.size;
  }

  /**
   * Supabase's move is a server-side rename, not a copy-then-delete, so committing a
   * document does not need delete permission on the bucket. That is a genuine improvement
   * on the GCS adapter, whose file.move() does delete the source.
   */
  async move(fromKey: string, toKey: string): Promise<void> {
    const { error } = await this.bucket().move(fromKey, toKey);
    if (error) throw new DomainError(`Could not move ${fromKey}: ${error.message}`);
    this.log.log(`moved ${fromKey} -> ${toKey}`);
  }
}
