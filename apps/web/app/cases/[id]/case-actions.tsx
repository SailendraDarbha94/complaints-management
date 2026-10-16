'use client';

import { useState } from 'react';
import { SERVICE_MODES } from '@ksdc/contracts';
import { BusyButton } from '@/app/components/busy-button';
import { useAction } from '@/app/components/use-action';
import { SERVICE_MODE_LABEL, dayInputValue } from '@/lib/labels';

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
  const [open, setOpen] = useState<EventOption | null>(null);
  const [reason, setReason] = useState('');
  const [closureReason, setClosureReason] = useState<string>('withdrawn');
  const [respondentId, setRespondentId] = useState<string>(respondents[0]?.id ?? '');
  // For a notice sent outside the software: when it went and how. Today, in the Council's
  // own calendar, is the usual answer; it is asked rather than assumed because the date is
  // what the dentist's reply deadline runs from.
  const [sentOn, setSentOn] = useState<string>(() => dayInputValue(null));
  // No default. Proof of service, not the count, is what an ex parte finding rests on if
  // it is challenged, so the mode is the officer's answer rather than a guess left in place.
  const [serviceMode, setServiceMode] = useState<string>('');
  // Pending until the refreshed case - new state, new buttons - is on screen. Ending at
  // the response left "Record: Close the case" pressable over the old page.
  const action = useAction();

  if (events.length === 0) return null;

  function start(option: EventOption) {
    setOpen(option);
    setReason('');
    action.setError(null);
    setRespondentId(respondents[0]?.id ?? '');
    setSentOn(dayInputValue(null));
    setServiceMode('');
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!open) return;

    const event = open.event;
    const body: Record<string, unknown> = {};
    if (open.requiresReason) body.reason = reason;
    // needsRespondent, not scope: ISSUE_RESPONDENT_NOTICE is case-scoped but is still
    // served on one dentist, and this form has always shown a picker for it. Keying on
    // scope meant the picked dentist was collected and then thrown away.
    if (needsRespondent) body.caseRespondentId = respondentId;
    if (NEEDS_CLOSURE_REASON.has(event)) body.closureReason = closureReason;
    // The engine moves the notice count only on the officer's word that the notice went
    // out, and when. Without this the button was refused every time.
    if (event === 'ISSUE_RESPONDENT_NOTICE') body.notice = { serviceMode, sentAt: sentOn };

    action.run(
      async () => {
        const res = await fetch(`${apiUrl}/v1/cases/${caseId}/events/${event}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(payload.message ?? 'That did not work. Try again.');
        }
      },
      (_result, router) => {
        setOpen(null);
        router.refresh();
      },
    );
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
              // Opening another event mid-record would swap the form out from under the
              // request, and the refresh would then close the one the officer just opened.
              disabled={action.pending}
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
                  <select
                    value={respondentId}
                    onChange={(ev) => setRespondentId(ev.target.value)}
                    // The body was built at the click. Another dentist picked, or a reason
                    // corrected, while it is in flight would be dropped, and the form would
                    // then close as though the edit had been recorded. So the fields freeze
                    // with the buttons.
                    disabled={action.pending}
                  >
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
                <select
                  value={closureReason}
                  onChange={(ev) => setClosureReason(ev.target.value)}
                  disabled={action.pending}
                >
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
                  disabled={action.pending}
                  placeholder="What happened, in the words you would use in the register."
                />
              </label>
            )}

            {open.event === 'ISSUE_RESPONDENT_NOTICE' && (
              <>
                <label>
                  Date it went out
                  <input
                    type="date"
                    value={sentOn}
                    // Today in the Council's calendar, read when the form renders: a notice
                    // cannot have gone out on a day that has not come yet.
                    max={dayInputValue(null)}
                    required
                    disabled={action.pending}
                    onChange={(ev) => setSentOn(ev.target.value)}
                  />
                </label>

                <label>
                  How it was sent
                  <select
                    value={serviceMode}
                    required
                    disabled={action.pending}
                    onChange={(ev) => setServiceMode(ev.target.value)}
                  >
                    <option value="" disabled>
                      Choose how it went
                    </option>
                    {SERVICE_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {SERVICE_MODE_LABEL[mode]}
                      </option>
                    ))}
                  </select>
                </label>

                <p className="form-note">
                  This button is for a notice you sent outside this software - typed and
                  posted by hand, or emailed from somewhere else. It records the notice as
                  dispatched on that date and moves that dentist&rsquo;s notice count. If you
                  have not sent one yet, use &ldquo;Draft a letter&rdquo; under Letters
                  instead: draft it there, send it, and confirm it from there.
                </p>
              </>
            )}

            {action.error && <p className="form-error">{action.error}</p>}

            <div className="action-buttons">
              <BusyButton
                type="submit"
                busy={action.pending}
                busyLabel="Recording…"
                disabled={needsRespondent && respondents.length === 0}
              >
                {`Record: ${open.label}`}
              </BusyButton>
              <button
                type="button"
                className="link-button"
                disabled={action.pending}
                onClick={() => setOpen(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
