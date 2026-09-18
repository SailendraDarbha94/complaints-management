'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { BusyButton } from '@/app/components/busy-button';
import { PendingLink } from '@/app/components/pending-link';
import { useAction } from '@/app/components/use-action';
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

type Confirming = 'snooze' | 'drop' | null;

/**
 * Today lists most reminders twice — once by urgency, once by who is being chased — and
 * each copy has its own buttons. A Done pressed on one copy must hold the other copy too,
 * or the same reminder can be posted twice from two places on one screen. This counts the
 * actions in flight per follow-up, whichever copy started them.
 */
interface InFlight {
  held: ReadonlyMap<string, number>;
  hold: (followUpId: string, delta: 1 | -1) => void;
}

const InFlightContext = createContext<InFlight | null>(null);

export function RowActionsScope({ children }: { children: ReactNode }) {
  const [held, setHeld] = useState<ReadonlyMap<string, number>>(() => new Map());
  const hold = useCallback((followUpId: string, delta: 1 | -1) => {
    setHeld((prev) => {
      const next = new Map(prev);
      const n = (next.get(followUpId) ?? 0) + delta;
      if (n > 0) next.set(followUpId, n);
      else next.delete(followUpId);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ held, hold }), [held, hold]);
  return <InFlightContext.Provider value={value}>{children}</InFlightContext.Provider>;
}

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
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [until, setUntil] = useState(() => inDays(7));
  const [reason, setReason] = useState('');
  // One action per row. It stays pending until the refreshed queue has replaced this row,
  // because a Done that re-enables while the row is still on screen gets pressed again.
  const action = useAction();
  // Held for exactly as long as this copy's action is pending: released when it ends, on
  // error as much as on success, and when the refreshed queue unmounts the row.
  const inFlight = useContext(InFlightContext);
  const hold = inFlight?.hold;
  useEffect(() => {
    if (!action.pending || !hold) return;
    hold(followUpId, 1);
    return () => hold(followUpId, -1);
  }, [action.pending, followUpId, hold]);
  const locked = action.pending || (inFlight?.held.has(followUpId) ?? false);

  function post(path: string, body: unknown) {
    action.run(
      async () => {
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
      },
      (_result, router) => {
        setConfirming(null);
        router.refresh();
      },
    );
  }

  if (confirming === 'snooze') {
    return (
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          post('snooze', { until });
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
        <BusyButton type="submit" busy={action.pending} busyLabel="Saving…" disabled={locked}>
          Snooze
        </BusyButton>
        <button
          type="button"
          className="link-button"
          disabled={locked}
          onClick={() => setConfirming(null)}
        >
          Cancel
        </button>
        {action.error && <span className="form-error">{action.error}</span>}
      </form>
    );
  }

  if (confirming === 'drop') {
    return (
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          post('dismiss', { reason });
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
        <BusyButton
          type="submit"
          busy={action.pending}
          busyLabel="Saving…"
          disabled={locked || reason.trim().length === 0}
        >
          Drop it
        </BusyButton>
        <button
          type="button"
          className="link-button"
          disabled={locked}
          onClick={() => setConfirming(null)}
        >
          Cancel
        </button>
        {action.error && <span className="form-error">{action.error}</span>}
      </form>
    );
  }

  return (
    <div className="row-actions">
      {needsDecision ? (
        caseFileId && (
          <PendingLink href={`/cases/${caseFileId}`} className="row-decide">
            Decide
          </PendingLink>
        )
      ) : (
        <>
          <BusyButton
            type="button"
            busy={action.pending}
            disabled={locked}
            aria-label={`Mark done: ${title}`}
            onClick={() => post('done', {})}
          >
            Done
          </BusyButton>
          <button
            type="button"
            disabled={locked}
            onClick={() => setConfirming('snooze')}
            aria-label={`Snooze: ${title}`}
          >
            Snooze
          </button>
        </>
      )}
      <button
        type="button"
        disabled={locked}
        onClick={() => setConfirming('drop')}
        aria-label={`Drop: ${title}`}
      >
        Drop
      </button>
      {action.error && <span className="form-error">{action.error}</span>}
    </div>
  );
}
