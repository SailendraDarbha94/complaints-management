import * as FileSystem from 'expo-file-system';
import { apiUrl, supabase } from './supabase';
import type { CapturedFile } from './capture';

/**
 * Talking to the register, for the things a phone may not do directly.
 *
 * Reads come straight from Supabase. WRITES COME HERE, and that is not an arbitrary split:
 * audit.append() takes its actor from session settings that a direct PostgREST client
 * never sets, so a document filed straight into the database would land with no officer
 * against it. On a register whose legal weight rests on an unbroken, attributed chain,
 * that is the difference between evidence and a row.
 *
 * So the phone sends the same Supabase access token as a bearer header, and the register's
 * route handlers verify it against the project JWKS exactly as they do for the browser.
 * The same identity, the same council scope, the same audit entry - a different doorway.
 */

async function authorization(): Promise<string> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in.');
  return `Bearer ${token}`;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    method: 'POST',
    headers: {
      authorization: await authorization(),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    // The register answers a refusal the officer caused with a message written for them to
    // read. Pass it through rather than replacing it with something generic.
    let message = `The register refused that (${res.status}).`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      /* not JSON; keep the generic message */
    }
    throw new Error(message);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

interface SignedUpload {
  uploadUrl: string;
  headers: Record<string, string>;
  storageKey: string;
  maxBytes: number;
}

export interface FiledDocument {
  documentId: string;
  versionId: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * File a document against a case: three steps, and the bytes never pass through the
 * register's own server.
 *
 *   1. ask the register to sign an upload
 *   2. PUT the file straight to storage
 *   3. tell the register it is there
 *
 * The third step is where the work happens: the register reads the first bytes back and
 * identifies the file by them rather than by what this app claimed, takes the sha256,
 * checks the length, and moves the object out of staging into the case's folder. A file
 * whose contents disagree with its stated type is refused there, not here - this app is
 * not a place where that judgement belongs.
 */
export async function fileDocument(
  caseId: string,
  file: CapturedFile,
  args: { title: string; documentClass: string },
  onProgress?: (fraction: number) => void,
): Promise<FiledDocument> {
  const signed = await post<SignedUpload>(
    `/v1/cases/${caseId}/documents/upload-url?contentType=${encodeURIComponent(file.contentType)}`,
  );

  if (file.sizeBytes > signed.maxBytes) {
    throw new Error(
      `That file is ${Math.round(file.sizeBytes / 1_048_576)} MB and the register accepts ` +
        `up to ${Math.round(signed.maxBytes / 1_048_576)} MB.`,
    );
  }

  onProgress?.(0.1);

  // An UploadTask streams from disk and reports progress. Reading a radiograph into a
  // JavaScript string to hand to fetch is how a phone runs out of memory on the one
  // document that mattered.
  const task = new FileSystem.UploadTask(
    new FileSystem.File(file.uri),
    signed.uploadUrl,
    {
      httpMethod: 'PUT',
      uploadType: FileSystem.UploadType.BINARY_CONTENT,
      headers: { ...signed.headers, 'content-type': file.contentType },
      onProgress: ({ bytesSent, totalBytes }) => {
        // 0.1 to 0.8 of the whole operation; the commit that follows is the rest.
        if (totalBytes > 0) onProgress?.(0.1 + 0.7 * (bytesSent / totalBytes));
      },
    },
  );

  const put = await task.uploadAsync();
  if (put.status >= 300) {
    throw new Error(`The upload did not complete (${put.status}). Try again on better signal.`);
  }

  onProgress?.(0.8);

  const filed = await post<FiledDocument>(`/v1/cases/${caseId}/documents/commit`, {
    storageKey: signed.storageKey,
    title: args.title,
    documentClass: args.documentClass,
    originalFilename: file.filename,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
  });

  onProgress?.(1);
  return filed;
}
