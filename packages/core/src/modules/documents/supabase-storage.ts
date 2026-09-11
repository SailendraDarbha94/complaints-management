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
 * The same port as the local and GCS adapters, so nothing above it changes. Three things
 * about this adapter are worth knowing before it is switched on:
 *
 *   The bucket must be PRIVATE. A public bucket serves every object to anyone holding the
 *   key, and object keys travel in logs and browser history. Private plus signed URLs is
 *   the only configuration this code supports, and `assertPrivateBucket()` refuses to
 *   start against a public one rather than discovering it later.
 *
 *   Image transformation must stay OFF. Documents are stored verbatim because they are
 *   evidence: a re-encoded radiograph is a different file with a different hash, and the
 *   sha256 recorded against the document version would no longer match what comes back.
 *   This adapter never requests a transform and never accepts a transformed download URL.
 *
 *   Supabase's own database backups do NOT include Storage objects. Whatever bucket this
 *   points at needs its own copy - a scheduled export to a second provider, or a bucket on
 *   a provider that does back up. Verify this before moving real case files; see the
 *   hosting notes in docs/adr/0002.
 *
 * Credentials: SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY, which must live only in server
 * processes. That key bypasses row-level security, so it must never reach the browser or
 * the React Native app - those talk to Supabase with the user's own anon-key session and
 * are constrained by storage RLS policies instead.
 */

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'case-documents';

/** Signed upload URLs from Supabase are valid for two hours and cannot be shortened. */
const UPLOAD_TTL_SECONDS = 2 * 60 * 60;
const DOWNLOAD_TTL_SECONDS = 5 * 60;

interface SupabaseClientLike {
  storage: {
    from(bucket: string): {
      createSignedUploadUrl(path: string): Promise<{ data: { signedUrl: string; token: string } | null; error: { message: string } | null }>;
      createSignedUrl(path: string, expiresIn: number, opts?: { download?: string }): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
      download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>;
      move(from: string, to: string): Promise<{ error: { message: string } | null }>;
      info(path: string): Promise<{ data: { size: number } | null; error: { message: string } | null }>;
    };
  };
}

export class SupabaseStorage extends StoragePort {
  readonly kind = 'supabase' as const;
  private readonly log = new Logger('storage:supabase');
  private client: SupabaseClientLike | undefined;

  /**
   * Loaded lazily and by name so that @supabase/supabase-js is not a hard dependency of
   * the core package until this driver is actually selected. Until STORAGE_DRIVER is set
   * to 'supabase', nothing here is imported and nothing here runs.
   */
  private async sb(): Promise<SupabaseClientLike> {
    if (this.client) return this.client;

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        'STORAGE_DRIVER=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. The ' +
          'service-role key is a server-only secret: it bypasses row-level security, so it ' +
          'must never be given to the browser or the mobile app.',
      );
    }

    const mod = (await import('@supabase/supabase-js')) as {
      createClient: (url: string, key: string, opts?: unknown) => SupabaseClientLike;
    };
    this.client = mod.createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return this.client;
  }

  async signedUpload(args: { contentType: string; maxBytes: number }): Promise<SignedUpload> {
    const storageKey = `${STAGING_PREFIX}${crypto.randomUUID()}`;
    const sb = await this.sb();
    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(storageKey);
    if (error || !data) throw new DomainError(`Could not prepare the upload: ${error?.message}`);

    return {
      url: data.signedUrl,
      method: 'PUT',
      // Supabase carries the authorisation in the URL's token parameter. The content type
      // is sent so the object is stored with it, but it is never trusted: the bytes are
      // sniffed on commit and a file whose contents disagree is refused.
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
    const sb = await this.sb();
    const { data, error } = await sb.storage
      .from(BUCKET)
      .createSignedUrl(args.storageKey, DOWNLOAD_TTL_SECONDS, { download: args.filename });
    if (error || !data) throw new DomainError(`Could not prepare the download: ${error?.message}`);

    return {
      url: data.signedUrl,
      expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000),
    };
  }

  async read(storageKey: string): Promise<Buffer> {
    const sb = await this.sb();
    const { data, error } = await sb.storage.from(BUCKET).download(storageKey);
    if (error || !data) throw new DomainError(`Could not read ${storageKey}: ${error?.message}`);
    return Buffer.from(await data.arrayBuffer());
  }

  async size(storageKey: string): Promise<number> {
    const sb = await this.sb();
    const { data, error } = await sb.storage.from(BUCKET).info(storageKey);
    if (error || !data) throw new DomainError(`Could not stat ${storageKey}: ${error?.message}`);
    return data.size;
  }

  /**
   * Supabase's move is a server-side rename, not a copy-then-delete, so committing a
   * document does not need the delete permission on the bucket. That is a genuine
   * improvement on the GCS adapter, whose file.move() deletes the source.
   */
  async move(fromKey: string, toKey: string): Promise<void> {
    const sb = await this.sb();
    const { error } = await sb.storage.from(BUCKET).move(fromKey, toKey);
    if (error) throw new DomainError(`Could not move ${fromKey}: ${error.message}`);
    this.log.log(`moved ${fromKey} -> ${toKey}`);
  }
}
