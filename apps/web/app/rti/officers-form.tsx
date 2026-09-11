'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PUBLIC_API_URL } from '@/lib/public-api';
import { today } from '@/lib/today';

/** Recording who holds an office. Ends the previous holder's term rather than editing it. */
export function OfficersForm({ collapsed }: { collapsed?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(!collapsed);
  const [office, setOffice] = useState<'pio' | 'firstAppellateAuthority'>('pio');
  const [fullName, setFullName] = useState('');
  const [designation, setDesignation] = useState('');
  const [startsOn, setStartsOn] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="link-like" onClick={() => setOpen(true)}>
        Record a change of office holder
      </button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${PUBLIC_API_URL}/v1/rti/officers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          office,
          fullName,
          designation: designation || null,
          startsOn,
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? 'That did not go through.');
      }
      setFullName('');
      setDesignation('');
      if (collapsed) setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="rti-form" onSubmit={submit}>
      <div className="two">
        <div>
          <label htmlFor="office">Office</label>
          <select
            id="office"
            value={office}
            onChange={(e) => setOffice(e.target.value as typeof office)}
          >
            <option value="pio">Public Information Officer</option>
            <option value="firstAppellateAuthority">First Appellate Authority</option>
          </select>
        </div>
        <div>
          <label htmlFor="startsOn">Holding office from</label>
          <input
            id="startsOn"
            type="date"
            value={startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
          />
        </div>
      </div>
      <div className="two">
        <div>
          <label htmlFor="fullName">Name</label>
          <input
            id="fullName"
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Dr A. N. Other"
            required
          />
        </div>
        <div>
          <label htmlFor="designation">Designation, as it goes on the letter</label>
          <input
            id="designation"
            type="text"
            value={designation}
            onChange={(e) => setDesignation(e.target.value)}
            placeholder="Registrar"
          />
        </div>
      </div>
      {error && <p className="rti-error">{error}</p>}
      <div className="action-row">
        <button type="submit" disabled={busy || !fullName.trim()}>
          {busy ? 'Recording\u2026' : 'Record'}
        </button>
        {collapsed && (
          <button type="button" className="link-like" onClick={() => setOpen(false)}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
