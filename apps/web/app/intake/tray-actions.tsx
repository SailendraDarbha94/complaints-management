'use client';

import { useState } from 'react';
import type { Route } from 'next';
import { PUBLIC_API_URL } from '@/lib/public-api';
import { BusyButton } from '@/app/components/busy-button';
import { PendingLink } from '@/app/components/pending-link';
import { useCardAction } from './card-scope';

/**
 * The three things you can do with a message in the tray.
 *
 * Opening a case is the consequential one and it is the only path in the running system
 * that allocates a case number, so it confirms rather than firing on a single click.
 * Setting one aside demands a reason, because the tray is the record of what the Council
 * received and a message that could vanish from it silently would make the tray evidence
 * of nothing.
 *
 * Busy state and the open confirm step belong to the card (card-scope.tsx), not to this
 * component, because a card with an assistant's suggestion has a second set of buttons that
 * must wait for these and that these must wait for.
 */
export function TrayActions({
  messageId,
  cases,
  suggestedCaseFileId,
  status,
  complainant,
}: {
  messageId: string;
  cases: Array<{ id: string; caseNumber: string; summary: string }>;
  suggestedCaseFileId: string | null;
  status: string;
  complainant: { name: string; email: string } | null;
}) {
  // `step`, not `pending`: which confirm step is open. `busy` is ANY request in flight on
  // this card, which shuts these buttons; `mine` is one of these buttons', which spins them.
  const { busy, busyFor, step, setStep, send, errorFor } = useCardAction();
  const mine = busyFor('tray');
  const [caseFileId, setCaseFileId] = useState(suggestedCaseFileId ?? cases[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const error = errorFor('tray');

  function post(path: string, body?: unknown) {
    send(
      'tray',
      async () => {
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
      },
      // The confirm step closes as the refreshed tray arrives, not a beat before it with
      // the message still sitting there looking unhandled.
      (_result, router) => {
        setStep(null);
        router.refresh();
      },
    );
  }

  if (status === 'dismissed') {
    return (
      <>
        <div className="row-actions">
          <BusyButton
            type="button"
            className="link-button"
            busy={mine}
            disabled={busy}
            busyLabel="Putting back…"
            onClick={() => post('/restore')}
          >
            Put back
          </BusyButton>
        </div>
        {/* Full width below the row, as the confirm steps are: the gutter beside the
            button is too narrow to hold a sentence. */}
        {error && (
          <div className="row-form">
            <span className="rti-error">{error}</span>
          </div>
        )}
      </>
    );
  }
  if (status === 'filed') return <div className="row-actions" />;

  if (step === 'open' && !complainant) {
    // The server would refuse anyway; saying so here, with the way forward, is kinder
    // than a button that fails.
    return (
      <div className="row-form">
        <span>
          The original sender could not be read from this message, and a case is never opened
          in the Council&rsquo;s own name. <PendingLink href={`/intake/${messageId}` as Route}>Open the message</PendingLink>{' '}
          to enter who complained.
        </span>
        <div className="action-buttons">
          <button type="button" className="link-button" onClick={() => setStep(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (step === 'open' && complainant) {
    return (
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          post('/open-case');
        }}
      >
        <span>
          Open a new case for <strong>{complainant.name}</strong>{' '}
          <span className="mono">&lt;{complainant.email}&gt;</span>? It will take the next case
          number. <PendingLink href={`/intake/${messageId}` as Route}>Not them?</PendingLink>
        </span>
        {error && <span className="rti-error">{error}</span>}
        <div className="action-buttons">
          <BusyButton type="submit" busy={mine} disabled={busy} busyLabel="Opening…">
            Open the case
          </BusyButton>
          <button type="button" className="link-button" disabled={busy} onClick={() => setStep(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  if (step === 'file') {
    return (
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          post('/file', { caseFileId });
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
          <BusyButton type="submit" busy={mine} busyLabel="Filing…" disabled={busy || !caseFileId}>
            File it
          </BusyButton>
          <button type="button" className="link-button" disabled={busy} onClick={() => setStep(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  if (step === 'dismiss') {
    return (
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          post('/dismiss', { reason });
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
          <BusyButton
            type="submit"
            busy={mine}
            busyLabel="Setting aside…"
            disabled={busy || reason.trim().length < 3}
          >
            Set aside
          </BusyButton>
          <button type="button" className="link-button" disabled={busy} onClick={() => setStep(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  // Also the resting state while the suggestion's own confirm step is open under the
  // snippet. Shut while anything on the card is in flight - including an Accept, which has
  // no confirm step of its own to hold the card still.
  return (
    <div className="row-actions">
      <button type="button" className="link-button" disabled={busy} onClick={() => setStep('open')}>
        Open a case
      </button>
      {cases.length > 0 && (
        <button type="button" className="link-button" disabled={busy} onClick={() => setStep('file')}>
          Add to a case
        </button>
      )}
      <button type="button" className="link-button" disabled={busy} onClick={() => setStep('dismiss')}>
        Not a complaint
      </button>
    </div>
  );
}
