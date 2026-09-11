/**
 * The API's address as the browser sees it.
 *
 * Kept apart from lib/api.ts because that module reads cookies through next/headers, which
 * a client component may not import — pulling it in fails the build. Nothing secret lives
 * here: NEXT_PUBLIC_* is baked into the bundle and visible to anyone who opens the page.
 */
export const PUBLIC_API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL ?? 'http://localhost:8080';
