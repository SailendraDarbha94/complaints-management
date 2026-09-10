/**
 * Generates the Ed25519 pair the API signs access tokens with.
 *
 *   pnpm --filter @ksdc/api keys
 *
 * In production these come from Secret Manager. Without them the API generates an
 * ephemeral pair per process, which signs everyone out on every deploy and every cold
 * start — so it refuses to do that in production rather than doing it quietly.
 */
import { generateSigningKeys } from '../src/modules/auth/token.service.js';

const { privateKey, publicKey } = generateSigningKeys();

// JSON.stringify escapes the newlines, so each PEM survives as one shell-safe line.
// Pasting a raw multi-line PEM into a .env file silently truncates it at the first break.
console.log('# Add these to your environment. Keep the private key secret.');
console.log('# In production they belong in Secret Manager, not in a file.');
console.log('');
console.log(`JWT_PRIVATE_KEY=${JSON.stringify(privateKey.trimEnd())}`);
console.log(`JWT_PUBLIC_KEY=${JSON.stringify(publicKey.trimEnd())}`);
