import 'react-native-url-polyfill/auto';
import * as SecureStore from 'expo-secure-store';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The council's Supabase client, for the phone.
 *
 * Four things about this differ from the server's client, and each of them matters.
 *
 *   IT USES THE PUBLISHABLE KEY, never the secret one. The secret key bypasses row-level
 *   security entirely; shipping it in an app bundle would put every council's case files
 *   behind a string anybody can extract from an APK in a minute. There is no configuration
 *   in which the mobile app holds it.
 *
 *   THE SESSION LIVES IN THE KEYCHAIN, not in AsyncStorage. A refresh token is a
 *   thirty-day credential to a statutory register; on a member's own unmanaged phone it
 *   belongs in the platform's secure store, which is hardware-backed on both iOS and
 *   modern Android. SecureStore has a 2 KB per-value limit, so the session is split
 *   across keys rather than truncated silently - see ChunkedSecureStore below.
 *
 *   URL POLYFILL FIRST. React Native ships an incomplete URL implementation and
 *   supabase-js builds request URLs with it. Without the import at the very top of this
 *   file the failures are late and misleading - a request that 404s against a URL that
 *   looks correct in the log.
 *
 *   detectSessionInUrl IS OFF. That is a browser concern - there is no address bar here -
 *   and leaving it on makes supabase-js reach for `window` during startup.
 *
 * What this client may DO is deliberately narrow. Per ADR-0002 the phone reads through
 * row-level security policies keyed on its JWT claims, and WRITES go through the register's
 * own API with a bearer token, because audit.append() takes its actor from session settings
 * a direct client never sets - and an unattributed write breaks the chain the legal case
 * rests on. Reads are not granted yet either: no table is granted to `authenticated` until
 * the policies for this app are written, one table at a time.
 */

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/**
 * SecureStore refuses values over 2048 bytes. A Supabase session - two JWTs plus the user
 * object - goes past that comfortably, and the failure mode without this is a warning at
 * write time and a silent sign-out on next launch.
 */
const CHUNK = 1800;

const ChunkedSecureStore = {
  async getItem(key: string): Promise<string | null> {
    const head = await SecureStore.getItemAsync(`${key}.0`);
    if (head === null) return null;

    const parts = [head];
    for (let i = 1; ; i++) {
      const part = await SecureStore.getItemAsync(`${key}.${i}`);
      if (part === null) break;
      parts.push(part);
    }
    return parts.join('');
  },

  async setItem(key: string, value: string): Promise<void> {
    await ChunkedSecureStore.removeItem(key);
    for (let i = 0; i * CHUNK < value.length; i++) {
      await SecureStore.setItemAsync(`${key}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK));
    }
  },

  async removeItem(key: string): Promise<void> {
    for (let i = 0; ; i++) {
      const part = await SecureStore.getItemAsync(`${key}.${i}`);
      if (part === null) break;
      await SecureStore.deleteItemAsync(`${key}.${i}`);
    }
  },
};

let client: SupabaseClient | undefined;

export function supabase(): SupabaseClient {
  if (client) return client;

  if (!url || !publishableKey) {
    throw new Error(
      'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set. ' +
        'Copy .env.example to .env. Only the PUBLISHABLE key belongs here - the secret ' +
        'key bypasses row-level security and must never be in an app bundle.',
    );
  }

  client = createClient(url, publishableKey, {
    auth: {
      storage: ChunkedSecureStore,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}

/**
 * Where the register's own API lives, for the writes that must be attributed.
 *
 * Reads may go straight to Supabase; writes may not. See the note above.
 */
export function apiUrl(): string {
  const base = process.env.EXPO_PUBLIC_API_URL;
  if (!base) {
    throw new Error('EXPO_PUBLIC_API_URL must point at the register (writes go through it).');
  }
  return base.replace(/\/+$/, '');
}
