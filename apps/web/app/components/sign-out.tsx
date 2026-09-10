'use client';

import { useRouter } from 'next/navigation';

export function SignOutButton({ apiUrl, name }: { apiUrl: string; name: string }) {
  const router = useRouter();

  async function signOut() {
    await fetch(`${apiUrl}/v1/auth/signout`, { method: 'POST', credentials: 'include' });
    router.replace('/signin');
    router.refresh();
  }

  return (
    <span className="whoami">
      {name}
      {' · '}
      <button type="button" className="link-button inline" onClick={signOut}>
        Sign out
      </button>
    </span>
  );
}
