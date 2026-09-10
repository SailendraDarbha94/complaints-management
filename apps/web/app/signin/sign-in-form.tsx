'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Two steps: address, then the six-digit code that was emailed.
 *
 * The form talks to the API directly with `credentials: 'include'` so the browser stores
 * the HttpOnly session cookies the API sets. Going through the Next server instead would
 * mean the tokens passing through a second process for no gain.
 */
export function SignInForm({ apiUrl }: { apiUrl: string }) {
  const router = useRouter();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('code', { email });
      setStep('code');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('verify', { email, code });
      router.replace('/today');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCode('');
    } finally {
      setBusy(false);
    }
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
        {error && <p className="form-error">{error}</p>}
        <button type="submit" disabled={busy || !email}>
          {busy ? 'Sending…' : 'Email me a code'}
        </button>
        <p className="form-note">
          There is no password. We email a six-digit code that works once, for ten minutes.
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
        pattern="\d{6}"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        autoComplete="one-time-code"
        className="code-input"
        required
        autoFocus
      />
      {error && <p className="form-error">{error}</p>}
      <button type="submit" disabled={busy || code.length !== 6}>
        {busy ? 'Checking…' : 'Sign in'}
      </button>
      <button
        type="button"
        className="link-button"
        onClick={() => {
          setStep('email');
          setCode('');
          setError(null);
        }}
      >
        Use a different address
      </button>
    </form>
  );
}
