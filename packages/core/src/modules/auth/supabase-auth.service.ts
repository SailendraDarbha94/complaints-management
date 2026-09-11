import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sql } from 'drizzle-orm';
import { getDb } from '@ksdc/db';
import { Logger } from '../../common/logger.js';
import { UnauthorizedError } from '../../common/domain-error.js';

/**
 * Signing in through Supabase.
 *
 * The council's own passwordless flow already works, and this is the same shape: an
 * address gets a numeric code, the code is exchanged for a session. What differs is who
 * mints and stores the session, and three consequences of that are worth stating.
 *
 *   SIGN-UP IS OFF. `shouldCreateUser: false` on every request, so asking for a code for
 *   an address Supabase has never seen does not quietly create an account for it. The
 *   dashboard setting that disables sign-ups is the belt; this is the braces, and it
 *   belongs in code because a dashboard toggle is one careless click from being back on.
 *
 *   THE ANSWER IS ALWAYS THE SAME. Whether the address is a council officer, a stranger,
 *   or nobody at all, requesting a code returns { sent: true }. Anything else turns this
 *   endpoint into a way of asking which addresses belong to the council's officers.
 *
 *   THE CODE LENGTH IS SUPABASE'S. The council's own flow issues six digits; a Supabase
 *   project issues whatever its Auth settings say, which is eight by default. The route
 *   handler validates against a range rather than a fixed length, and does not assume.
 *
 * Uses the anon/publishable key for the sign-in calls, exactly as a browser would, so a
 * bug here cannot reach past what an unauthenticated caller is allowed. The secret key is
 * never used for sign-in - it would bypass row-level security and every rate limit
 * Supabase applies.
 */

export interface SupabaseSession {
  accessToken: string;
  refreshToken: string;
  /** Seconds. Supabase's default is 3600. */
  expiresIn: number;
  user: { id: string; email: string | null };
}

function config(): { url: string; anonKey: string } {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'AUTH_DRIVER=supabase needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or the ' +
        'legacy NEXT_PUBLIC_SUPABASE_ANON_KEY).',
    );
  }
  return { url: url.replace(/\/+$/, ''), anonKey };
}

export class SupabaseAuthService {
  private readonly log = new Logger('auth:supabase');
  private client: SupabaseClient | undefined;

  private sb(): SupabaseClient {
    if (this.client) return this.client;
    const { url, anonKey } = config();
    this.client = createClient(url, anonKey, {
      // A server process holds no session of its own. Persisting one here would mean
      // every request after the first inherited whoever signed in before it.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return this.client;
  }

  /**
   * Send a one-time code. Never reveals whether the address is known.
   */
  async requestCode(email: string): Promise<void> {
    const { error } = await this.sb().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });

    if (error) {
      // Supabase answers 422 for an unknown address when sign-up is off, and 429 when the
      // per-address or per-hour limit is hit. Neither is told to the caller: the first
      // enumerates officers, and the second tells someone their probing is working. Both
      // are logged, because the officer whose code never arrived will ask.
      this.log.warn(`code request for ${email} refused by Supabase: ${error.message}`);
    }
  }

  /**
   * Exchange a code for a session.
   *
   * `type: 'email'` is the one that accepts the numeric code from the email body. The
   * other types verify a hashed token from a link, which is a different flow and not one
   * the council uses - an officer may well open the mail on a different device.
   */
  async verifyCode(email: string, code: string): Promise<SupabaseSession> {
    const { data, error } = await this.sb().auth.verifyOtp({
      email,
      token: code,
      type: 'email',
    });

    if (error || !data.session) {
      // Expired, wrong and already-used all read the same. The difference is only useful
      // to somebody guessing.
      throw new UnauthorizedError('That code is not valid. Request a new one.');
    }

    return session(data.session);
  }

  /**
   * Sign in with an address and a password.
   *
   * There is deliberately NO sign-up counterpart here, and there never should be. The
   * council's officers and committee members are appointed, not registered: an account
   * exists because somebody with authority created it, which on this project means the
   * admin API with the secret key. An endpoint that creates accounts would make
   * membership of a statutory body's register self-service.
   *
   * That is only half the guarantee, though. The other half is the project's own
   * disable_signup setting - Supabase's /auth/v1/signup is reachable with the publishable
   * key whatever this codebase does or does not expose.
   */
  async signInWithPassword(email: string, password: string): Promise<SupabaseSession> {
    const { data, error } = await this.sb().auth.signInWithPassword({ email, password });

    if (error || !data.session) {
      // Wrong password, unknown address and disabled account all read the same. Saying
      // which would turn this into a way of asking who holds an account.
      throw new UnauthorizedError('That email address and password do not match.');
    }
    return session(data.session);
  }

  /** Rotate a session on the refresh token alone. */
  async refresh(refreshToken: string): Promise<SupabaseSession> {
    const { data, error } = await this.sb().auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) throw new UnauthorizedError('Session expired.');
    return session(data.session);
  }

  /**
   * End a session.
   *
   * Scoped to the one session rather than every session the user holds: signing out of the
   * browser should not sign the officer out of the mobile app they are holding.
   */
  async signOut(accessToken: string | null | undefined): Promise<void> {
    if (!accessToken) return;
    const { url, anonKey } = config();
    const res = await fetch(`${url}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` },
    });
    // A token that has already expired cannot be revoked and does not need to be.
    if (!res.ok && res.status !== 401) {
      this.log.warn(`sign-out returned ${res.status}`);
    }
  }

  /**
   * Link a Supabase identity to an application user, by address.
   *
   * Called after a successful verify. The hook that puts the council into the token reads
   * app_user.supabase_user_id, so an officer whose row has never been linked signs in and
   * finds an empty register - this repairs that, once, on first sign-in.
   *
   * Goes straight to the database rather than through withCouncil(): the council is not
   * known yet, and app_user carries no row-level security by design. The WHERE clause is
   * the safety - it will not re-point a row that already belongs to a DIFFERENT Supabase
   * user, so two accounts cannot fight over one officer, and it matches only active users.
   */
  async linkUser(args: { supabaseUserId: string; email: string }): Promise<string | null> {
    const rows = await getDb().execute<{ id: string }>(sql`
      UPDATE app_user
      SET supabase_user_id = ${args.supabaseUserId}::uuid
      WHERE lower(email) = lower(${args.email})
        AND is_active
        AND (supabase_user_id IS NULL OR supabase_user_id = ${args.supabaseUserId}::uuid)
      RETURNING id
    `);
    if (!rows.rows[0]) {
      this.log.warn(
        `signed in as ${args.email}, but no active app_user has that address - the ` +
          'register will be empty for them until somebody adds them.',
      );
      return null;
    }
    return rows.rows[0].id;
  }
}

function session(s: {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  user: { id: string; email?: string };
}): SupabaseSession {
  return {
    accessToken: s.access_token,
    refreshToken: s.refresh_token,
    expiresIn: s.expires_in ?? 3600,
    user: { id: s.user.id, email: s.user.email ?? null },
  };
}
