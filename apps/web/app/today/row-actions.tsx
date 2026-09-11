'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PUBLIC_API_URL } from '@/lib/public-api';

/**
 * What the officer can do to a queue row without leaving the queue.
 *
 * Three things, because the morning is three things: this is handled, come back to it
 * later, or it should never have been asked for. Anything else is work on the case, and
 * that belongs on the case file.
 *
 * A row that needs a decision is the exception. The engine puts those above everything
 * else and keeps them there whatever their dates say — it has stopped and is waiting for a
 * person — so snoozing one changes nothing visible and a Snooze button on it would simply
 * look broken. Those rows get the way out instead: open the case and decide.
 *
 * Dropping a reminder demands a reason. The queue is the record of what was chased and
 * what was not, and a row that simply vanishes is the failure this whole system exists to
 * prevent — so the reason is mandatory in the service, and the UI does not pretend
 * otherwise.
 */

type Pending = 'snooze' | 'drop' | null;

function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function RowActions({
  followUpId,
  title,
  needsDecision,
  caseFileId,
}: {
  followUpId: string;
  title: string;
  needsDecision: boolean;
  caseFileId: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [until, setUntil] = useState(() => inDays(7));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${PUBLIC_API_URL}/v1/followups/${followUpId}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
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

  if (pending === 'snooze') {
    return (
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void post('snooze', { until });
        }}
      >
        <label>
          Come back on
          <input
            type="date"
            value={until}
            min={inDays(1)}
            onChange={(e) => setUntil(e.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Snooze'}
        </button>
        <button type="button" className="link-button" onClick={() => setPending(null)}>
          Cancel
        </button>
        {error && <span className="form-error">{error}</span>}
      </form>
    );
  }

  if (pending === 'drop') {
    return (
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void post('dismiss', { reason });
        }}
      >
        <label>
          Why this reminder should go
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Complainant withdrew by phone"
            required
          />
        </label>
        <button type="submit" disabled={busy || reason.trim().length === 0}>
          {busy ? 'Saving…' : 'Drop it'}
        </button>
        <button type="button" className="link-button" onClick={() => setPending(null)}>
          Cancel
        </button>
        {error && <span className="form-error">{error}</span>}
      </form>
    );
  }

  return (
    <div className="row-actions">
      {needsDecision ? (
        caseFileId && (
          <Link href={`/cases/${caseFileId}`} className="row-decide">
            Decide
          </Link>
        )
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            aria-label={`Mark done: ${title}`}
            onClick={() => void post('done', {})}
          >
            Done
          </button>
          <button
            type="button"
            onClick={() => setPending('snooze')}
            aria-label={`Snooze: ${title}`}
          >
            Snooze
          </button>
        </>
      )}
      <button type="button" onClick={() => setPending('drop')} aria-label={`Drop: ${title}`}>
        Drop
      </button>
      {error && <span className="form-error">{error}</span>}
    </div>
  );
}
