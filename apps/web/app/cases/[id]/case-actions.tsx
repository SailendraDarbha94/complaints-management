'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * What the officer can do to this case, right now.
 *
 * The buttons come from the API's `availableEvents`, which the lifecycle service derives
 * from the transition table. Nothing here decides what is allowed — if this screen
 * re-implemented the guards they would drift, and a button that looks available but is
 * refused is worse than no button.
 */

interface EventOption {
  event: string;
  label: string;
  scope: 'case' | 'respondent' | 'hold';
  requiresReason: boolean;
  description: string;
}

const CLOSURE_REASONS = [
  ['withdrawn', 'Withdrawn by the complainant'],
  ['complainant_unresponsive', 'Complainant unresponsive'],
  ['amicable_settlement', 'Settled between the parties'],
  ['no_jurisdiction', 'Outside our jurisdiction'],
  ['duplicate', 'Duplicate of another case'],
  ['court_seized', 'Before a court'],
  ['notice_complied_with', 'Notice complied with'],
] as const;

/** These close the case, so the register needs a reason recorded against them. */
const NEEDS_CLOSURE_REASON = new Set(['CLOSE']);

export function CaseActions({
  caseId,
  apiUrl,
  events,
  respondents,
}: {
  caseId: string;
  apiUrl: string;
  events: EventOption[];
  respondents: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<EventOption | null>(null);
  const [reason, setReason] = useState('');
  const [closureReason, setClosureReason] = useState<string>('withdrawn');
  const [respondentId, setRespondentId] = useState<string>(respondents[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (events.length === 0) return null;

  function start(option: EventOption) {
    setOpen(option);
    setReason('');
    setError(null);
    setRespondentId(respondents[0]?.id ?? '');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!open) return;
    setBusy(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {};
      if (open.requiresReason) body.reason = reason;
      if (open.scope === 'respondent') body.caseRespondentId = respondentId;
      if (NEEDS_CLOSURE_REASON.has(open.event)) body.closureReason = closureReason;

      const res = await fetch(`${apiUrl}/v1/cases/${caseId}/events/${open.event}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? 'That did not work. Try again.');
      }
      setOpen(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const needsRespondent = open?.scope === 'respondent' || open?.event === 'ISSUE_RESPONDENT_NOTICE';

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Record what happened</h2>
      </div>
      <div className="panel-body">
        <div className="action-row">
          {events.map((e) => (
            <button
              key={e.event}
              type="button"
              className={`action ${e.event.startsWith('CLOSE') || e.event === 'REOPEN' ? 'action-grave' : ''}`}
              title={e.description}
              onClick={() => start(e)}
            >
              {e.label}
            </button>
          ))}
        </div>

        {open && (
          <form className="action-form" onSubmit={submit}>
            <p className="action-why">{open.description}</p>

            {needsRespondent &&
              (respondents.length === 0 ? (
                <p className="form-error">
                  No respondent has been named on this case yet, so there is nobody to
                  send a notice to.
                </p>
              ) : (
                <label>
                  Which dentist
                  <select value={respondentId} onChange={(ev) => setRespondentId(ev.target.value)}>
                    {respondents.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}

            {NEEDS_CLOSURE_REASON.has(open.event) && (
              <label>
                Closure reason
                <select value={closureReason} onChange={(ev) => setClosureReason(ev.target.value)}>
                  {CLOSURE_REASONS.map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {open.requiresReason && (
              <label>
                Reason — this becomes part of the record
                <textarea
                  value={reason}
                  onChange={(ev) => setReason(ev.target.value)}
                  rows={3}
                  required
                  autoFocus
                  placeholder="What happened, in the words you would use in the register."
                />
              </label>
            )}

            {open.event === 'ISSUE_RESPONDENT_NOTICE' && (
              <p className="form-note">
                This records a notice as despatched and moves that dentist&rsquo;s notice
                count. If you have not actually sent it yet, draft the letter first and
                confirm it from there.
              </p>
            )}

            {error && <p className="form-error">{error}</p>}

            <div className="action-buttons">
              <button type="submit" disabled={busy || (needsRespondent && respondents.length === 0)}>
                {busy ? 'Recording…' : `Record: ${open.label}`}
              </button>
              <button type="button" className="link-button" onClick={() => setOpen(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
