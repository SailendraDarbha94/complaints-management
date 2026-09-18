'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

type Router = ReturnType<typeof useRouter>;

/**
 * Run something that writes, then show its result - with one `pending` covering both.
 *
 * The bug this replaces: every form here set `busy` around its fetch and then called
 * router.refresh() without waiting for it. The request finished, the button re-enabled,
 * and the OLD page stayed on screen for another second or two while the new one was
 * fetched - which is precisely when a second click lands. Wrapping the refresh (or push)
 * in the same transition keeps `pending` true until the refreshed page has rendered.
 *
 *     const action = useAction();
 *     action.run(
 *       () => postJson(`/v1/cases/${id}/respondents`, body),
 *       (_result, router) => { setOpen(false); router.refresh(); },
 *     );
 *     <BusyButton busy={action.pending} busyLabel="Adding…">Name them</BusyButton>
 *     {action.error && <p className="rti-error">{action.error}</p>}
 *
 * `then` runs inside the transition, so state it sets (closing a form, clearing fields)
 * lands together with the refreshed page instead of a beat before it. It runs only when
 * `work` succeeded; a thrown error becomes `error` and nothing else happens.
 */
export interface Action {
  /** True from the click until `then` - including any refresh or navigation - has rendered. */
  pending: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  run: <T>(work: () => Promise<T>, then?: (result: T, router: Router) => void) => void;
  router: Router;
}

export function useAction(): Action {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run<T>(work: () => Promise<T>, then?: (result: T, router: Router) => void): void {
    setError(null);
    startTransition(async () => {
      let result: T;
      try {
        result = await work();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      // Updates after an await are not part of the transition unless wrapped again.
      startTransition(() => then?.(result, router));
    });
  }

  return { pending, error, setError, run, router };
}
