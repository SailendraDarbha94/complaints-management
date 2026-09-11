import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { SignJWT, exportPKCS8, exportSPKI, importPKCS8, importSPKI, jwtVerify } from 'jose';
import type { Role } from '@ksdc/contracts';

/**
 * Tokens.
 *
 * A short-lived access token the API can verify without touching the database, and an
 * opaque refresh token that can only be checked against a row — so a stolen refresh
 * token is revocable, and a stolen access token expires in fifteen minutes.
 *
 * EdDSA (Ed25519) rather than RS256: 32-byte keys, no parameter choices to get wrong, and
 * fast enough that verifying on every request costs nothing.
 */

/**
 * jose's key type, derived from its own import functions rather than named. `CryptoKey`
 * is a DOM global that Node's ES2023 lib does not declare, and jose has renamed this type
 * between majors - deriving it survives both.
 */
type SigningKey = Awaited<ReturnType<typeof importPKCS8>>;

const ALG = 'EdDSA';
const ACCESS_TTL_SECONDS = 15 * 60;
const ISSUER = 'ksdc-complaints';

/**
 * The development key pair is generated once per process, not once per instance.
 *
 * Per-instance keys would mean a second TokenService - a test helper, a script, a badly
 * scoped provider - silently signing tokens the rest of the process cannot verify, and
 * "signature verification failed" is a miserable thing to debug when the real cause is
 * that two objects exist. Production never reaches this path: it refuses to start
 * without configured keys.
 */
let ephemeralDevKeys: { privateKey: string; publicKey: string } | undefined;

export interface AccessClaims {
  sub: string;
  councilId: string;
  role: Role;
  email: string;
  name: string;
  /** The session this token belongs to, so revoking a session invalidates its refreshes. */
  sid: string;
}

@Injectable()
export class TokenService {
  private readonly log = new Logger('tokens');
  private keys: { privateKey: SigningKey; publicKey: SigningKey } | undefined;

  /**
   * Keys come from JWT_PRIVATE_KEY / JWT_PUBLIC_KEY (PKCS8 and SPKI PEM, from Secret
   * Manager in production). With none set, a pair is generated at boot: sessions then
   * survive only until the process restarts, which is right for development and would be
   * a silent disaster in production — so it refuses to do it there.
   */
  private async loadKeys() {
    if (this.keys) return this.keys;

    const priv = normalisePem(process.env.JWT_PRIVATE_KEY);
    const pub = normalisePem(process.env.JWT_PUBLIC_KEY);

    if (priv && pub) {
      this.keys = {
        privateKey: await importPKCS8(priv, ALG),
        publicKey: await importSPKI(pub, ALG),
      };
      return this.keys;
    }

    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must be set in production. Generating a key ' +
          'pair at boot would sign everyone out on every deploy and every cold start.',
      );
    }

    if (!ephemeralDevKeys) {
      ephemeralDevKeys = generateSigningKeys();
      this.log.warn(
        'No signing keys configured - generated an ephemeral pair for this process. ' +
          'Everyone is signed out when it restarts. Run `pnpm --filter @ksdc/api keys` ' +
          'for a real pair.',
      );
    }
    const pem = ephemeralDevKeys;
    this.keys = {
      privateKey: await importPKCS8(pem.privateKey, ALG),
      publicKey: await importSPKI(pem.publicKey, ALG),
    };
    return this.keys;
  }

  async issueAccessToken(claims: AccessClaims): Promise<{ token: string; expiresIn: number }> {
    const { privateKey } = await this.loadKeys();
    const token = await new SignJWT({
      councilId: claims.councilId,
      role: claims.role,
      email: claims.email,
      name: claims.name,
      sid: claims.sid,
    })
      .setProtectedHeader({ alg: ALG })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
      .sign(privateKey);

    return { token, expiresIn: ACCESS_TTL_SECONDS };
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    const { publicKey } = await this.loadKeys();
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: ISSUER,
      algorithms: [ALG],
    });
    return {
      sub: payload.sub!,
      councilId: payload.councilId as string,
      role: payload.role as Role,
      email: payload.email as string,
      name: payload.name as string,
      sid: payload.sid as string,
    };
  }

  /**
   * Refresh tokens are opaque random bytes, never JWTs: the point is that they can only
   * be validated against a row, so revoking one actually revokes it.
   *
   * Only the hash is stored. A plain SHA-256 is right here and a slow hash would be
   * wrong — the token is 256 bits of entropy, so there is no dictionary to attack, and
   * this runs on every token refresh.
   */
  newRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashRefreshToken(token) };
  }
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A PEM that has been through a .env file, a shell variable or Secret Manager arrives with
 * its line breaks written as a literal backslash-n more often than not - that is how the
 * keys script prints them, so that they survive being pasted into any of the three. Undo
 * it here rather than making every caller remember.
 */
function normalisePem(value: string | undefined): string | undefined {
  return value?.replace(/\\n/g, '\n').trim();
}

/** Generates a key pair for JWT_PRIVATE_KEY / JWT_PUBLIC_KEY. */
export function generateSigningKeys(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export { exportPKCS8, exportSPKI };
