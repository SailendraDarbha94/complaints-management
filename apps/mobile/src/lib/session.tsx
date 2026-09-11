import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

/**
 * Who is signed in, and which council they are acting for.
 *
 * The council does not come from a lookup: it is a claim in the access token, put there by
 * public.custom_access_token_hook while Supabase minted it. That matters here because a
 * phone has no server to ask, and because the same claim is what row-level security
 * filters every row on. If it is absent the account is not an active member of any council
 * this register knows, and the right behaviour is to say so rather than to show an empty
 * list that looks like a council with no complaints.
 *
 * The claims are READ here, never trusted as authority. The token was verified by Supabase
 * before it was issued and is verified again by Postgres on every query; this is only
 * unpacking what it says so the UI can show the right thing.
 */

export interface CouncilClaims {
  councilId: string | null;
  councilRole: 'officer' | 'committee_member' | 'auditor' | null;
  appUserId: string | null;
}

interface SessionState {
  session: Session | null;
  claims: CouncilClaims;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const EMPTY: CouncilClaims = { councilId: null, councilRole: null, appUserId: null };

const Ctx = createContext<SessionState | null>(null);

/** Decode, do not verify. Verification happened at issue and happens again at every query. */
function claimsFrom(session: Session | null): CouncilClaims {
  if (!session?.access_token) return EMPTY;
  try {
    const payload = session.access_token.split('.')[1];
    if (!payload) return EMPTY;
    const json = JSON.parse(
      // React Native has atob but not Buffer, and the payload is base64url.
      decodeURIComponent(
        atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
          .split('')
          .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
          .join(''),
      ),
    ) as { app_metadata?: Record<string, string> };

    const meta = json.app_metadata ?? {};
    return {
      councilId: meta.council_id ?? null,
      councilRole: (meta.council_role as CouncilClaims['councilRole']) ?? null,
      appUserId: meta.app_user_id ?? null,
    };
  } catch {
    return EMPTY;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const sb = supabase();

    // The stored session first, so a returning member is not shown a sign-in form they do
    // not need while the network is checked.
    void sb.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    // And thereafter: sign-in, sign-out, and every silent token refresh. The refresh is
    // the one that matters - it re-runs the access token hook, so a council added or
    // revoked since sign-in reaches the app without anyone signing out.
    const { data: sub } = sb.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      session,
      claims: claimsFrom(session),
      loading,
      async signIn(email, password) {
        const { error } = await supabase().auth.signInWithPassword({ email, password });
        // Wrong password, unknown address and disabled account read the same, exactly as
        // on the web. The difference is only useful to somebody guessing.
        if (error) throw new Error('That email address and password do not match.');
      },
      async signOut() {
        await supabase().auth.signOut();
      },
    }),
    [session, loading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider.');
  return ctx;
}
