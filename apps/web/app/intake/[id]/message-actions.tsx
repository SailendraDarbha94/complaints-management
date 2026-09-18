'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PUBLIC_API_URL } from '@/lib/public-api';

/**
 * What to do with this message.
 *
 * Opening a case is the consequential action on this screen, and unlike the quick button
 * in the tray it shows the fields first: this is where the officer corrects a name the
 * parser got from a display header, or writes a summary better than the sender's subject
 * line. What goes in here is what the register will carry for the life of the case.
 */
export function MessageActions({
  messageId,
  status,
  defaults,
  candidates,
  cases,
}: {
  messageId: string;
  status: string;
  defaults: { summary: string; complainantName: string; complainantEmail: string };
  candidates: Array<{
    caseFileId: string;
    caseNumber: string;
    summary: string;
    isClosed: boolean;
    because: string;
  }>;
  cases: Array<{ id: string; caseNumber: string; summary: string }>;
}) {
  const router = useRouter();
  const [summary, setSummary] = useState(defaults.summary);
  const [name, setName] = useState(defaults.complainantName);
  const [email, setEmail] = useState(defaults.complainantEmail);
  const [caseFileId, setCaseFileId] = useState(candidates[0]?.caseFileId ?? cases[0]?.id ?? '');
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
      const payload = (await res.json().catch(() => ({}))) as {
        message?: string;
        caseFileId?: string;
      };
      if (!res.ok) throw new Error(payload.message ?? 'That did not go through.');
      if (payload.caseFileId) router.push(`/cases/${payload.caseFileId}`);
      else router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (status !== 'unfiled') {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>{status === 'filed' ? 'Filed' : 'Set aside'}</h2>
        </div>
        <div className="panel-body">
          {status === 'dismissed' ? (
            <>
              <p className="rti-hint">
                Set aside, not deleted. The message stays on the record either way.
              </p>
              <div className="action-row">
                <button type="button" disabled={busy} onClick={() => void post('/restore')}>
                  Put it back in the tray
                </button>
              </div>
            </>
          ) : (
            <p className="rti-hint">
              This message is on a case. Its attachments went on with it.
            </p>
          )}
          {error && <p className="rti-error">{error}</p>}
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="panel panel-consequential">
        <div className="panel-head">
          <h2>Open a case</h2>
        </div>
        <div className="panel-body">
          <form
            className="action-form"
            onSubmit={(e) => {
              e.preventDefault();
              void post('/open-case', {
                summary,
                complainantName: name,
                complainantEmail: email || null,
              });
            }}
          >
            <p className="rti-hint">
              This takes the next number in the register. Check the three lines below first
              — they are what the case will carry from here on.
            </p>
            <div>
              <label htmlFor="summary">The grievance, in one line</label>
              <input id="summary" value={summary} onChange={(e) => setSummary(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="name">Complainant</label>
              <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="email">Their email</label>
              <input id="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {error && <p className="rti-error">{error}</p>}
            <div className="action-buttons">
              <button type="submit" disabled={busy || !summary.trim() || !name.trim()}>
                {busy ? 'Opening…' : 'Open the case'}
              </button>
            </div>
          </form>
        </div>
      </section>

      {(candidates.length > 0 || cases.length > 0) && (
        <section className="panel">
          <div className="panel-head">
            <h2>Or add it to a case</h2>
          </div>
          <div className="panel-body">
            {candidates.length > 0 && (
              <p className="rti-hint">
                {candidates.length === 1
                  ? `${candidates[0]!.caseNumber} — ${candidates[0]!.because}.`
                  : 'More than one case matches; pick the right one.'}
              </p>
            )}
            <form
              className="action-form"
              onSubmit={(e) => {
                e.preventDefault();
                void post('/file', { caseFileId });
              }}
            >
              <div>
                <label htmlFor="case">Case</label>
                <select id="case" value={caseFileId} onChange={(e) => setCaseFileId(e.target.value)}>
                  {candidates.map((c) => (
                    <option key={c.caseFileId} value={c.caseFileId}>
                      {c.caseNumber} — {c.because}
                      {c.isClosed ? ' (closed)' : ''}
                    </option>
                  ))}
                  {cases
                    .filter((c) => !candidates.some((k) => k.caseFileId === c.id))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.caseNumber} — {c.summary}
                      </option>
                    ))}
                </select>
              </div>
              <div className="action-buttons">
                <button type="submit" disabled={busy || !caseFileId}>
                  Add it to this case
                </button>
              </div>
            </form>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Not a complaint</h2>
        </div>
        <div className="panel-body">
          <form
            className="action-form"
            onSubmit={(e) => {
              e.preventDefault();
              void post('/dismiss', { reason });
            }}
          >
            <p className="rti-hint">
              It stays on the record, marked with your reason. Nothing is deleted.
            </p>
            <div>
              <label htmlFor="reason">Why</label>
              <input
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Advertising; nothing to do with the Council"
              />
            </div>
            <div className="action-buttons">
              <button type="submit" disabled={busy || reason.trim().length < 3}>
                Set it aside
              </button>
            </div>
          </form>
        </div>
      </section>
    </>
  );
}
