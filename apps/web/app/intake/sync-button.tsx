'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PUBLIC_API_URL } from '@/lib/public-api';

/**
 * "Check now."
 *
 * The reader polls every half minute on its own. This is for the moment just after you
 * have forwarded something and would rather not wait for the timer.
 */
export function SyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const res = await fetch(`${PUBLIC_API_URL}/v1/intake/sync`, {
        method: 'POST',
        credentials: 'include',
      });
      const payload = (await res.json().catch(() => ({}))) as {
        message?: string;
        ingested?: number;
        filed?: number;
      };
      if (!res.ok) throw new Error(payload.message ?? 'Could not reach the mailbox.');

      setSaid(
        payload.ingested
          ? `${payload.ingested} new${payload.filed ? `, ${payload.filed} filed automatically` : ''}`
          : 'Nothing new.',
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="action" onClick={() => void sync()} disabled={busy}>
        {busy ? 'Checking\u2026' : 'Check for new mail'}
      </button>
      {said && <p className="action-why">{said}</p>}
      {error && <p className="rti-error">{error}</p>}
    </div>
  );
}
