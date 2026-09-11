'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

/**
 * Filing a document.
 *
 * Three steps, and the middle one does not touch the API: ask for a signed URL, PUT the
 * bytes straight to storage, then tell the API what landed. Cloud Run caps a request at
 * 32 MB and an OPG scan can be 50, so routing the bytes through the API would fail on
 * exactly the documents that matter most.
 */

const CLASSES = [
  ['complaint_material', "Complainant's material"],
  ['respondent_explanation', "Dentist's explanation"],
  ['expert_report', 'GDCRI expert report'],
  ['service_proof', 'Proof of service'],
  ['legacy_register_extract', 'Page from the register'],
  ['other', 'Other'],
] as const;

export function DocumentUpload({ caseId, apiUrl }: { caseId: string; apiUrl: string }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [documentClass, setDocumentClass] = useState<string>('complaint_material');
  const [originalHeld, setOriginalHeld] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function choose(f: File | null) {
    setFile(f);
    setError(null);
    // The filename is usually a fair description; the officer can overrule it.
    if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ''));
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy('Requesting a link…');
    setError(null);

    try {
      const ticketRes = await fetch(
        `${apiUrl}/v1/cases/${caseId}/documents/upload-url?contentType=${encodeURIComponent(file.type || 'application/octet-stream')}`,
        { method: 'POST', credentials: 'include' },
      );
      if (!ticketRes.ok) throw new Error('Could not start the upload.');
      const ticket = (await ticketRes.json()) as {
        uploadUrl: string;
        storageKey: string;
        headers: Record<string, string>;
        maxBytes: number;
      };

      if (file.size > ticket.maxBytes) {
        throw new Error(
          `That file is ${Math.round(file.size / 1_048_576)} MB. The limit is ` +
            `${Math.round(ticket.maxBytes / 1_048_576)} MB.`,
        );
      }

      setBusy('Uploading…');
      const put = await fetch(ticket.uploadUrl, {
        method: 'PUT',
        headers: ticket.headers,
        body: file,
      });
      if (!put.ok) throw new Error('The upload did not complete.');

      setBusy('Filing…');
      const commit = await fetch(`${apiUrl}/v1/cases/${caseId}/documents/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          storageKey: ticket.storageKey,
          title: title || file.name,
          originalFilename: file.name,
          documentClass,
          physicalOriginalHeld: originalHeld,
        }),
      });
      if (!commit.ok) {
        const payload = (await commit.json().catch(() => ({}))) as { message?: string };
        // The API identifies the file by its bytes, so this is where "you called it a
        // PDF but it is not one" surfaces.
        throw new Error(payload.message ?? 'That file could not be filed.');
      }

      setFile(null);
      setTitle('');
      setOriginalHeld(false);
      if (fileInput.current) fileInput.current.value = '';
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <form className="upload" onSubmit={upload}>
      <input
        ref={fileInput}
        type="file"
        // Advisory only. What the file actually is gets decided from its bytes.
        accept=".pdf,.jpg,.jpeg,.png,.heic,.tif,.tiff,.bmp,image/*,application/pdf"
        onChange={(e) => choose(e.target.files?.[0] ?? null)}
      />

      {file && (
        <div className="upload-details">
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label>
            Kind
            <select value={documentClass} onChange={(e) => setDocumentClass(e.target.value)}>
              {CLASSES.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={originalHeld}
              onChange={(e) => setOriginalHeld(e.target.checked)}
            />
            The council is holding the physical original
          </label>
          <button type="submit" disabled={!!busy}>
            {busy ?? 'File this document'}
          </button>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
    </form>
  );
}
