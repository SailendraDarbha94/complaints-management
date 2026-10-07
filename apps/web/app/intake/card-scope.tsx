'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useAction, type Action } from '@/app/components/use-action';

/**
 * One card, one thing in flight.
 *
 * A card with a suggestion carries two sets of controls: the suggestion's (Accept, Reject)
 * under the snippet, and the ordinary three in the gutter. They are separate components,
 * because they sit in different parts of the row - and two components each with their own
 * useAction would each have their own `pending`. Then "Accept: set aside" could still be
 * spinning while "Open a case" took a click, and both would land: a message set aside AND
 * opened as a case, with a case number spent on it. The message page avoids this by having
 * one component own every form; the card gets the same guarantee from this scope.
 *
 * It holds:
 *   send    the single useAction both halves run their requests through, and its `busy`;
 *   step    which confirm step is open, so opening one closes any other - a card showing
 *           the "open a case?" confirm and the "set aside, why?" form at once is asking two
 *           questions and will get one answer;
 *   source  which half sent the request in flight, so an error is shown beside the button
 *           that caused it rather than on both halves.
 *
 * It renders no element of its own: the card's grid is untouched by wrapping it.
 */

export type CardStep = 'open' | 'file' | 'dismiss' | 'accept' | 'reject' | null;
export type CardSource = 'tray' | 'suggestion';

type Router = Action['router'];

export interface CardAction {
  /** True from the click until the refreshed tray has rendered - for either half. Disables. */
  busy: boolean;
  /** True only when this half sent it. Spins: the spinner belongs on the button pressed. */
  busyFor: (source: CardSource) => boolean;
  step: CardStep;
  setStep: (step: CardStep) => void;
  /** Run a request on behalf of one half of the card. */
  send: <T>(
    source: CardSource,
    work: () => Promise<T>,
    then?: (result: T, router: Router) => void,
  ) => void;
  /** The error, if the last request was this half's. */
  errorFor: (source: CardSource) => string | null;
}

const CardActionContext = createContext<CardAction | null>(null);

function useCardActionState(): CardAction {
  const action = useAction();
  const [step, setStep] = useState<CardStep>(null);
  const [source, setSource] = useState<CardSource | null>(null);
  return {
    busy: action.pending,
    busyFor: (from) => action.pending && source === from,
    step,
    // A stale refusal from the last attempt must not sit under a freshly opened form.
    setStep: (next) => {
      action.setError(null);
      setStep(next);
    },
    send(from, work, then) {
      setSource(from);
      action.run(work, then);
    },
    errorFor: (from) => (action.error && source === from ? action.error : null),
  };
}

export function CardScope({ children }: { children: ReactNode }) {
  const value = useCardActionState();
  return <CardActionContext.Provider value={value}>{children}</CardActionContext.Provider>;
}

/**
 * The card's shared action, or - outside a CardScope - one of the component's own. The
 * fallback keeps a component working wherever it is dropped; it only loses the guarantee
 * that its neighbours wait for it. Both hooks are always called: hooks may not be skipped.
 */
export function useCardAction(): CardAction {
  const shared = useContext(CardActionContext);
  const own = useCardActionState();
  return shared ?? own;
}
