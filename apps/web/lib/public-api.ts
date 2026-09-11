/**
 * The API's address as the browser sees it.
 *
 * Kept apart from lib/api.ts because that module reads cookies through next/headers, which
 * a client component may not import — pulling it in fails the build. Nothing secret lives
 * here: NEXT_PUBLIC_* is baked into the bundle and visible to anyone who opens the page.
 */
/**
 * Empty string, not a host.
 *
 * The route handlers live inside this app now, so /v1/... is same-origin and a relative
 * URL is both correct and the only thing that cannot be wrong in production. The old
 * default pointed at localhost:8080, the separate NestJS service that no longer exists -
 * which would have sent every browser fetch to a dead port.
 *
 * NEXT_PUBLIC_API_URL is still honoured, for the case where the mobile app or a separate
 * deployment needs an absolute origin.
 */
export const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
