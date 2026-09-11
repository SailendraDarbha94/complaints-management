# @ksdc/mobile

The committee member's app. Expo SDK 57, expo-router, React Native 0.86.

**This is a scaffold.** It signs in and shows you which council you belong to. It does not
yet show a single case file, and that is deliberate — see below.

## Running it

```bash
pnpm --filter @ksdc/mobile start
```

Scan the QR code with Expo Go. `cp .env.example .env` first; only `EXPO_PUBLIC_*` values
belong in it, because Expo inlines them into the bundle.

## What is here

| | |
|---|---|
| `src/app/sign-in.tsx` | Email and password, matching the web. No sign-up, and no link to one. |
| `src/app/index.tsx` | The signed-in screen: account, role, council. |
| `src/lib/session.tsx` | The session, and reading the council claims back out of the token. |
| `src/lib/supabase.ts` | The client, with the session kept in the device keychain. |
| `metro.config.js` | Teaching Metro about the monorepo. |

About 520 lines. Everything else under `src/` from the template was deleted.

## Three things that are not obvious

**Only the publishable key is ever in this app.** The secret key bypasses row-level
security; in an APK it is one `unzip` away from every council's case files. There is no
configuration in which that changes.

**The session lives in the keychain, not AsyncStorage.** A refresh token is a thirty-day
credential to a statutory register, sitting on a member's own unmanaged phone. SecureStore
caps a value at 2 KB and a Supabase session is larger, so it is chunked across keys — the
failure without that is a warning when it is written and a mysterious sign-out days later.

**The council comes from a claim in the access token**, put there by
`public.custom_access_token_hook` when Supabase minted it. This app decodes it to decide
what to show; it never treats it as authority. The token was verified when it was issued
and is verified again by Postgres on every query.

## Why it shows no case files

No table in the register is granted to the `authenticated` role. A phone can read nothing,
by design, and the screen says so rather than showing an empty list that looks like a
council with no complaints.

That is the right order. The policies deciding which rows a member may see are written one
table at a time, as reviewed decisions — not switched on to make a screen look finished.
The `jwt_council_isolation` policies from migration 0006 are already in place and tested;
what is missing is the deliberate `GRANT SELECT` on each table the app should see.

## Reads here, writes through the register

Per `docs/adr/0002`: reads may come straight from Supabase, filtered by those policies.
**Writes go through the web app's `/v1` with a bearer token**, because `audit.append()`
takes its actor from session settings a direct PostgREST client never sets — and an
unattributed write breaks the chain the legal case rests on. `EXPO_PUBLIC_API_URL` points
at it.

## Still to do

- A real app icon and splash. The current ones are Expo's placeholders.
- `GRANT SELECT` per table, plus a case list and case detail screen.
- `FLAG_SECURE` / screenshot prevention on any screen showing complaint content.
- Push notifications, which was the officer's original ask for the committee.
- No tests yet.
