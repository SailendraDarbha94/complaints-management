'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PUBLIC_API_URL } from '@/lib/public-api';

/**
 * The three things you can do with a message in the tray.
 *
 * Opening a case is the consequential one and it is the only path in the running system
 * that allocates a case number, so it confirms rather than firing on a single click.
 * Setting one aside demands a reason, because the tray is the record of what the Council
 * received and a message that could vanish from it silently would make the tray evidence
 * of nothing.
 */

type Pending = 'open' | 'file' | 'dismiss' | null;

export function TrayActions({
  messageId,
  cases,
  suggestedCaseFileId,
  status,
}: {
  messageId: string;
  cases: Array<{ id: string; caseNumber: string; summary: string }>;
  suggestedCaseFileId: string | null;
  status: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [caseFileId, setCaseFileId] = useState(suggestedCaseFileId ?? cases[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${PUBLIC_API_URL}/v1/intake/${messageId}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? 'That did not go through.');
      }
      setPending(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (status === 'dismissed') {
    return (
      <div className="row-actions">
        <button type="button" className="link-button" disabled={busy} onClick={() => void post('/restore')}>
          Put back
        </button>
      </div>
    );
  }
  if (status === 'filed') return <div className="row-actions" />;

  if (pending === 'open') {
    return (
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void post('/open-case');
        }}
      >
        <span>Open a new case from this message? It will take the next case number.</span>
        {error && <span className="rti-error">{error}</span>}
        <div className="action-buttons">
          <button type="submit" disabled={busy}>
            {busy ? 'Opening\u2026' : 'Open the case'}
          </button>
          <button type="button" className="link-button" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  if (pending === 'file') {
    return (
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void post('/file', { caseFileId });
        }}
      >
        {/* An input+datalist rather than a select: `.row-form` styles inputs and not
            selects, and a picker that inherits nothing looks broken. */}
        <input
          list={`cases-${messageId}`}
          value={caseFileId}
          onChange={(e) => setCaseFileId(e.target.value)}
          placeholder="Case"
        />
        <datalist id={`cases-${messageId}`}>
          {cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.caseNumber} — {c.summary}
            </option>
          ))}
        </datalist>
        {error && <span className="rti-error">{error}</span>}
        <div className="action-buttons">
          <button type="submit" disabled={busy || !caseFileId}>
            File it
          </button>
          <button type="button" className="link-button" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  if (pending === 'dismiss') {
    return (
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void post('/dismiss', { reason });
        }}
      >
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this not a complaint?"
          required
        />
        {error && <span className="rti-error">{error}</span>}
        <div className="action-buttons">
          <button type="submit" disabled={busy || reason.trim().length < 3}>
            Set aside
          </button>
          <button type="button" className="link-button" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="row-actions">
      <button type="button" className="link-button" onClick={() => setPending('open')}>
        Open a case
      </button>
      {cases.length > 0 && (
        <button type="button" className="link-button" onClick={() => setPending('file')}>
          Add to a case
        </button>
      )}
      <button type="button" className="link-button" onClick={() => setPending('dismiss')}>
        Not a complaint
      </button>
    </div>
  );
}
