import { API_URL } from '@/lib/api';
import { SignInForm } from './sign-in-form';

export const dynamic = 'force-dynamic';

export default function SignInPage() {
  // The browser talks to the API directly for sign-in, so it needs the public URL rather
  // than the one the Next server uses internally.
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? API_URL;

  return (
    <main className="shell signin-shell">
      <header className="masthead">
        <div>
          <span className="council">Karnataka State Dental Council</span>
          <h1>Complaints Register</h1>
        </div>
      </header>
      <SignInForm apiUrl={apiUrl} />
    </main>
  );
}
