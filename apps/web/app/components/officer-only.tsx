import type { ReactElement } from 'react';
import { API_URL, type Session } from '@/lib/api';
import { websiteAccess } from '@/lib/website-access';
import { SignOutButton } from './sign-out';

/**
 * The first line of every page:
 *
 *   const gate = await officerOnly();
 *   if (gate.notice) return gate.notice;
 *
 * For the officer it hands back the session and the page carries on. For anyone else it
 * hands back the one page they see on this website, and the page returns it before it has
 * fetched anything. The decision is lib/website-access.ts; this is only how it looks.
 */
export async function officerOnly(): Promise<
  { session: Session; notice: null } | { session: Session; notice: ReactElement }
> {
  const access = await websiteAccess();
  if (access.officer) return { session: access.session, notice: null };
  return {
    session: access.session,
    notice: <NotForThisWebsite signedInAs={access.signedInAs} notice={access.notice} name={access.session.user.name} />,
  };
}

function NotForThisWebsite({ signedInAs, notice, name }: { signedInAs: string; notice: string; name: string }) {
  return (
    <main className="shell signin-shell">
      <header className="masthead">
        <div>
          <span className="council">Karnataka State Dental Council</span>
          <h1>Complaints Register</h1>
        </div>
      </header>
      <div className="empty">
        <strong>{notice}</strong>
        <p>You are signed in as {signedInAs}.</p>
        <p>
          <SignOutButton apiUrl={process.env.NEXT_PUBLIC_API_URL ?? API_URL} name={name || signedInAs} />
        </p>
      </div>
    </main>
  );
}
