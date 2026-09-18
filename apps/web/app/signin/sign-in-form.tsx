'use client';

import { useState } from 'react';
import { BusyButton } from '@/app/components/busy-button';
import { useAction } from '@/app/components/use-action';

/**
 * Signing in, in whichever of two ways the council is configured for.
 *
 * `password` is one step: address and password together. `code` is two: address, then the
 * numeric code that was emailed. The mode is decided on the server and passed in, because
 * a client that guessed wrong would post to an endpoint that is not there.
 *
 * THERE IS NO SIGN-UP, in either mode, and there is no link to one. Officers and committee
 * members are appointed; an account exists because somebody with authority created it.
 * Anyone who reaches this page without an account is meant to be turned away, so the only
 * thing offered is a way to ask the Registrar.
 *
 * The form posts with `credentials: 'include'` so the browser stores the HttpOnly session
 * cookies the route handler sets. The token itself never reaches this code.
 */
export function SignInForm({ apiUrl, mode }: { apiUrl: string; mode: 'password' | 'code' }) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // One action for the form; only one of its steps is ever on screen. It stays pending from
  // the press until /today has replaced this page, so the button cannot come back in the
  // second or two between the session being set and the queue appearing.
  const action = useAction();

  async function post(path: string, body: unknown) {
    const res = await fetch(`${apiUrl}/v1/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}) as { message?: string });
      throw new Error(payload.message ?? 'Something went wrong. Try again.');
    }
    return res.json();
  }

  function requestCode(e: React.FormEvent) {
    e.preventDefault();
    action.run(
      () => post('code', { email }),
      () => setStep('code'),
    );
  }

  function verify(e: React.FormEvent) {
    e.preventDefault();
    action.run(
      async () => {
        try {
          await post('verify', { email, code });
        } catch (err) {
          setCode('');
          throw err;
        }
      },
      (_result, router) => {
        router.replace('/today');
        router.refresh();
      },
    );
  }

  function signInWithPassword(e: React.FormEvent) {
    e.preventDefault();
    action.run(
      async () => {
        try {
          await post('password', { email, password });
        } catch (err) {
          setPassword('');
          throw err;
        }
      },
      (_result, router) => {
        router.replace('/today');
        router.refresh();
      },
    );
  }

  if (mode === 'password') {
    return (
      <form onSubmit={signInWithPassword} className="signin-form">
        <label htmlFor="email">Your council email address</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="officer@ksdc.in"
          autoComplete="username"
          required
          autoFocus
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        {action.error && <p className="form-error">{action.error}</p>}
        <BusyButton
          type="submit"
          busy={action.pending}
          busyLabel="Signing in…"
          disabled={!email || password.length < 10}
        >
          Sign in
        </BusyButton>
        <p className="form-note">
          Accounts are created by the Registrar. If you do not have one, ask the office
          rather than trying to register - there is no way to sign yourself up, by design.
        </p>
      </form>
    );
  }

  if (step === 'email') {
    return (
      <form onSubmit={requestCode} className="signin-form">
        <label htmlFor="email">Your council email address</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="officer@ksdc.in"
          autoComplete="email"
          required
          autoFocus
        />
        {action.error && <p className="form-error">{action.error}</p>}
        <BusyButton type="submit" busy={action.pending} busyLabel="Sending…" disabled={!email}>
          Email me a code
        </BusyButton>
        <p className="form-note">
          There is no password. We email a code that works once, for ten minutes.
        </p>
      </form>
    );
  }

  return (
    <form onSubmit={verify} className="signin-form">
      <label htmlFor="code">Enter the code sent to {email}</label>
      <input
        id="code"
        // inputMode numeric brings up the digit keypad on a phone; one-time-code lets the
        // OS offer the code straight from the notification.
        inputMode="numeric"
        // Six digits from the council's own mailer, eight from Supabase. Pinning six here
        // would silently refuse every real code on the other driver.
        pattern="\d{6,8}"
        maxLength={8}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        autoComplete="one-time-code"
        className="code-input"
        required
        autoFocus
      />
      {action.error && <p className="form-error">{action.error}</p>}
      <BusyButton
        type="submit"
        busy={action.pending}
        busyLabel="Checking…"
        disabled={code.length < 6}
      >
        Sign in
      </BusyButton>
      <button
        type="button"
        className="link-button"
        disabled={action.pending}
        onClick={() => {
          setStep('email');
          setCode('');
          action.setError(null);
        }}
      >
        Use a different address
      </button>
    </form>
  );
}
