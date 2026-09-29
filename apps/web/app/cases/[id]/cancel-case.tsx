'use client';

import { useState } from 'react';
import { BusyButton } from '@/app/components/busy-button';
import { useAction } from '@/app/components/use-action';

/**
 * Cancelling a case opened in error, and taking that back.
 *
 * The officer asked for a delete button on the cases list. The register cannot have one: a
 * case number is a serial in a legal book, and a book with a number missing is a book with
 * a page torn out of it. So a case opened by mistake - a duplicate, a message that was never
 * a complaint, a test - is cancelled instead. It leaves every working list, keeps its
 * number, and stays in the register marked cancelled with the reason given here, so the
 * numbering has no gap that nobody can explain. Nothing is deleted, and it can be restored.
 *
 * The officer also asked that removal never be one careless click, which is why this is
 * not on the list and not beside the routine buttons: it sits at the very bottom of the
 * case, and it opens a form rather than acting. The form asks why, says in one sentence
 * what will happen, and only then offers the button that does it.
 *
 * What counts as a reason is the API's decision. This form refuses only an empty box; a
 * reason too short to explain anything is refused by the service in plain words, and shown
 * here as it is. A second copy of that rule in the screen would drift from the first.
 */

/** POST some JSON; throw the API's own message, which is written for the officer. */
async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(payload.message ?? 'That did not go through. Try again.');
  }
}

/**
 * The quiet panel at the foot of a live case. Closed until asked; asks for a reason.
 */
export function CancelCasePanel({
  caseId,
  caseNumber,
  apiUrl,
}: {
  caseId: string;
  caseNumber: string;
  apiUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  // Pending until the refreshed page - banner up, buttons gone - is on screen. Ending at the
  // response would leave "Cancel this case" pressable over the old page for a second.
  const action = useAction();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    action.run(
      () => post(`${apiUrl}/v1/cases/${caseId}/cancel`, { reason: reason.trim() }),
      (_result, router) => {
        // Stay on the case rather than going to the list. The refreshed page is the proof
        // it worked - the banner saying what was done, by whom and why, with Restore beside
        // it. The list would show only an absence, and no way back from it.
        setOpen(false);
        setReason('');
        router.refresh();
      },
    );
  }

  return (
    <section className="panel panel-quiet">
      <div className="panel-head">
        <h2>Opened in error?</h2>
      </div>
      <div className="panel-body">
        {!open ? (
          <div className="cancel-invite">
            <p className="form-note">
              A duplicate, a message that was not a complaint, or a test can be cancelled.
              Nothing is deleted.
            </p>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                action.setError(null);
                setOpen(true);
              }}
            >
              Cancel this case&hellip;
            </button>
          </div>
        ) : (
          <form className="action-form cancel-form" onSubmit={submit}>
            <label>
              Why was it opened in error? This becomes part of the record.
              <textarea
                value={reason}
                onChange={(ev) => setReason(ev.target.value)}
                rows={3}
                required
                autoFocus
                // The body is built at the click; an edit made while it is in flight would
                // be dropped while the form closed as though it had been recorded.
                disabled={action.pending}
                placeholder="For example: a duplicate of KSDC/COMP/2026-27/0007, or: this email was not a complaint."
              />
            </label>

            {/* The email clause is here because it is the one consequence the officer would
                otherwise meet without warning: a message they had dealt with, back in the
                tray. It goes back so that it can reach the right case (see
                mail/cancelled-case in @ksdc/core). */}
            <p className="action-why">
              {caseNumber} will disappear from every list but keep its number: the register
              will show it as cancelled, with this reason, any email filed on it will go back
              to Inward mail, and it can be restored at any time.
            </p>

            {action.error && <p className="form-error">{action.error}</p>}

            <div className="action-buttons">
              <BusyButton
                type="submit"
                busy={action.pending}
                busyLabel="Cancelling…"
                disabled={!reason.trim()}
              >
                Cancel this case
              </BusyButton>
              {/* Not "Cancel": on a form whose purpose is cancelling, that word would mean
                  both "go ahead" and "stop", and the officer would have to guess which. */}
              <button
                type="button"
                className="link-button"
                disabled={action.pending}
                onClick={() => setOpen(false)}
              >
                Keep this case
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

/**
 * Undoing a cancellation. One click, deliberately: it removes nothing, and the case can be
 * cancelled again. It is the safety net that makes cancelling safe to offer at all.
 */
export function RestoreCase({ caseId, apiUrl }: { caseId: string; apiUrl: string }) {
  const action = useAction();

  return (
    <div className="restore">
      <BusyButton
        type="button"
        className="button-link"
        busy={action.pending}
        busyLabel="Restoring…"
        onClick={() =>
          action.run(
            () => post(`${apiUrl}/v1/cases/${caseId}/restore`, {}),
            (_result, router) => router.refresh(),
          )
        }
      >
        Restore this case
      </BusyButton>
      {action.error && <p className="form-error">{action.error}</p>}
    </div>
  );
}
