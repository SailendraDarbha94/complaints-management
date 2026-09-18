'use client';

import { useState } from 'react';
import { BusyButton } from '@/app/components/busy-button';
import { useAction } from '@/app/components/use-action';

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
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [documentClass, setDocumentClass] = useState<string>('complaint_material');
  const [originalHeld, setOriginalHeld] = useState(false);
  // One `pending` for all three steps and the refresh after them; `step` only says which
  // one the button is waiting on. A 50 MB scan takes long enough to be clicked twice.
  const action = useAction();
  const [step, setStep] = useState('Requesting a link…');
  // Bumped to empty the file picker. A remount, not `input.value = ''`, because the reset
  // then lands with the refreshed list instead of a beat before the document appears in it.
  const [pickerKey, setPickerKey] = useState(0);

  function choose(f: File | null) {
    setFile(f);
    action.setError(null);
    // The filename is usually a fair description; the officer can overrule it.
    if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ''));
  }

  function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setStep('Requesting a link…');

    action.run(
      async () => {
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

        setStep('Uploading…');
        const put = await fetch(ticket.uploadUrl, {
          method: 'PUT',
          headers: ticket.headers,
          body: file,
        });
        if (!put.ok) throw new Error('The upload did not complete.');

        setStep('Filing…');
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
      },
      (_result, router) => {
        setFile(null);
        setTitle('');
        setOriginalHeld(false);
        setPickerKey((k) => k + 1);
        router.refresh();
      },
    );
  }

  return (
    <form className="upload" onSubmit={upload}>
      <input
        key={pickerKey}
        type="file"
        // Advisory only. What the file actually is gets decided from its bytes.
        accept=".pdf,.jpg,.jpeg,.png,.heic,.tif,.tiff,.bmp,image/*,application/pdf"
        // Picking another file mid-upload would change the form, not the upload.
        disabled={action.pending}
        onChange={(e) => choose(e.target.files?.[0] ?? null)}
      />

      {file && (
        <div className="upload-details">
          <label>
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              // Same as the picker: the commit is sent with what these said at the click,
              // so an edit made during a long upload would be silently ignored.
              disabled={action.pending}
            />
          </label>
          <label>
            Kind
            <select
              value={documentClass}
              onChange={(e) => setDocumentClass(e.target.value)}
              disabled={action.pending}
            >
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
              disabled={action.pending}
            />
            The council is holding the physical original
          </label>
          <BusyButton type="submit" busy={action.pending} busyLabel={step}>
            File this document
          </BusyButton>
        </div>
      )}

      {action.error && <p className="form-error">{action.error}</p>}
    </form>
  );
}
