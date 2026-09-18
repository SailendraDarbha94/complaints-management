'use client';

import { BusyButton } from './busy-button';
import { useAction } from './use-action';

export function SignOutButton({ apiUrl, name }: { apiUrl: string; name: string }) {
  // Pending until the sign-in page has replaced this one, not merely until the session is
  // gone: the page being left stays on screen meanwhile, and looks as if nothing happened.
  const action = useAction();

  function signOut() {
    action.run(
      () => fetch(`${apiUrl}/v1/auth/signout`, { method: 'POST', credentials: 'include' }),
      (_response, router) => {
        router.replace('/signin');
        router.refresh();
      },
    );
  }

  return (
    <span className="whoami">
      {name}
      {' · '}
      <BusyButton
        type="button"
        className="link-button inline"
        busy={action.pending}
        busyLabel="Signing out…"
        onClick={signOut}
      >
        Sign out
      </BusyButton>
      {/* Only a request that never reached the API lands here. Say so: a sign-out that
          quietly did nothing leaves the register open to whoever sits down next. */}
      {action.error && <span role="alert"> · Sign-out did not go through.</span>}
    </span>
  );
}
