import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './spinner';

/**
 * A button that cannot be pressed twice.
 *
 * While `busy`, it is disabled, carries aria-busy, shows the spinner, and - when given one -
 * says what it is doing instead of what it will do ("Adding…" for "Name them on this
 * case"). Pair `busy` with useAction()'s `pending`, which stays true until the refreshed
 * page has actually rendered, not merely until the request returned: a button that
 * re-enables while the old page is still on screen invites exactly the second click this
 * exists to prevent.
 */
export function BusyButton({
  busy,
  busyLabel,
  disabled,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy: boolean;
  /** What the button says while busy. Omit to keep the label and only add the spinner. */
  busyLabel?: ReactNode;
}) {
  return (
    <button {...rest} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy && <Spinner />}
      {busy && busyLabel !== undefined ? busyLabel : children}
    </button>
  );
}
