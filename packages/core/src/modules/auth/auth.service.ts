import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Logger } from '../../common/logger.js';
import { UnauthorizedError } from '../../common/domain-error.js';
import { sql } from 'drizzle-orm';
import { getDb, type Db } from '@ksdc/db';
import type { Role } from '@ksdc/contracts';
import { MailerPort } from '../notifications/mailer.js';
import { TokenService, hashRefreshToken } from './token.service.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Passwordless sign-in.
 *
 * Auth tables are global — a login attempt happens before any council is known, and one
 * person may sit on two councils' committees — so this service talks to the database
 * directly rather than through withCouncil(). Everything it returns is then scoped.
 */

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_REQUESTS_PER_HOUR = 5;
const REFRESH_TTL_DAYS = 30;
const SCRYPT_KEYLEN = 32;

export interface Membership {
  councilId: string;
  councilCode: string;
  councilName: string;
  role: Role;
}

export interface SignedIn {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: { id: string; email: string; name: string };
  council: Membership;
  memberships: Membership[];
}

/** Deliberately vague, and identical whatever went wrong. */
const BAD_CODE = 'That code is not valid. Request a new one.';

export class AuthService {
  private readonly log = new Logger('auth');

  constructor(
    private readonly tokens: TokenService,
    private readonly mailer: MailerPort,
  ) {}

  private db(): Db {
    return getDb();
  }

  // ── Codes ────────────────────────────────────────────────────────────────

  private async hashCode(code: string, salt: Buffer): Promise<Buffer> {
    return scrypt(code, salt, SCRYPT_KEYLEN);
  }

  private async encodeCode(code: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await this.hashCode(code, salt);
    return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  private async codeMatches(code: string, stored: string): Promise<boolean> {
    const [scheme, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = await this.hashCode(code, Buffer.from(saltB64, 'base64url'));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /**
   * Request a sign-in code.
   *
   * Always resolves, whether or not the address belongs to anyone. An endpoint that says
   * "no such user" is an endpoint that enumerates the council's officers, and the set of
   * people who can alter this register is small enough to be worth not publishing.
   */
  async requestCode(
    email: string,
    opts: { ip?: string | null; purpose?: 'sign_in' | 'step_up' } = {},
  ): Promise<{ sent: boolean }> {
    const address = email.trim().toLowerCase();
    const purpose = opts.purpose ?? 'sign_in';
    const db = this.db();

    const recent = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM auth_otp
      WHERE lower(email) = ${address} AND created_at > now() - interval '1 hour'
    `);
    if ((recent.rows[0]?.n ?? 0) >= MAX_REQUESTS_PER_HOUR) {
      this.log.warn(`rate limited: ${address}`);
      return { sent: true }; // same answer either way
    }

    const user = await db.execute<{ id: string; full_name: string; is_active: boolean }>(sql`
      SELECT id, full_name, is_active FROM app_user WHERE lower(email) = ${address}
    `);
    const known = user.rows[0];
    if (!known || !known.is_active) {
      this.log.warn(`code requested for unknown or inactive address: ${address}`);
      return { sent: true };
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = await this.encodeCode(code);

    // Issuing a new code retires any live one, so only ever one code works at a time.
    // Two live codes would double an attacker's guessing budget for free.
    await db.execute(sql`
      UPDATE auth_otp SET consumed_at = now()
      WHERE lower(email) = ${address} AND purpose = ${purpose} AND consumed_at IS NULL
    `);

    await db.execute(sql`
      INSERT INTO auth_otp (email, code_hash, purpose, expires_at, request_ip)
      VALUES (${address}, ${codeHash}, ${purpose},
              now() + interval '${sql.raw(String(CODE_TTL_MINUTES))} minutes', ${opts.ip ?? null})
    `);

    await this.mailer.send({
      to: address,
      subject:
        purpose === 'sign_in'
          ? `${code} is your sign-in code`
          : `${code} confirms your request`,
      text: [
        `Your code is ${code}.`,
        '',
        `It expires in ${CODE_TTL_MINUTES} minutes and can be used once.`,
        '',
        purpose === 'sign_in'
          ? 'If you did not try to sign in to the KSDC complaints register, ignore this message.'
          : 'If you did not request this, ignore this message and tell the Registrar.',
      ].join('\n'),
    });

    return { sent: true };
  }

  /**
   * Verify a code and open a session.
   *
   * Attempts are counted on the row, so five wrong guesses burn the code rather than
   * merely slowing the guesser down.
   */
  async verifyCode(
    email: string,
    code: string,
    context: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<SignedIn> {
    const address = email.trim().toLowerCase();
    const db = this.db();

    const found = await db.execute<{
      id: string;
      code_hash: string;
      attempts: number;
      expired: boolean;
    }>(sql`
      SELECT id, code_hash, attempts, (expires_at < now()) AS expired
      FROM auth_otp
      WHERE lower(email) = ${address} AND purpose = 'sign_in' AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const otp = found.rows[0];
    if (!otp || otp.expired) throw new UnauthorizedError(BAD_CODE);

    if (otp.attempts >= MAX_ATTEMPTS) {
      await db.execute(sql`UPDATE auth_otp SET consumed_at = now() WHERE id = ${otp.id}::uuid`);
      throw new UnauthorizedError(BAD_CODE);
    }

    if (!(await this.codeMatches(code.trim(), otp.code_hash))) {
      await db.execute(sql`
        UPDATE auth_otp SET attempts = attempts + 1 WHERE id = ${otp.id}::uuid
      `);
      throw new UnauthorizedError(BAD_CODE);
    }

    await db.execute(sql`UPDATE auth_otp SET consumed_at = now() WHERE id = ${otp.id}::uuid`);

    const memberships = await this.membershipsFor(address);
    if (memberships.length === 0) {
      // The account exists but sits on no council, or every term has ended.
      throw new UnauthorizedError(
        'This account is not a member of any council. Ask the Registrar to restore your access.',
      );
    }

    const user = await db.execute<{ id: string; email: string; full_name: string }>(sql`
      UPDATE app_user SET last_login_at = now()
      WHERE lower(email) = ${address}
      RETURNING id, email, full_name
    `);
    const me = user.rows[0]!;

    return this.openSession(me, memberships[0]!, memberships, context);
  }

  /**
   * Which councils this person may act for. Active memberships only: a committee
   * member's term ends, and so does their access.
   *
   * Runs in a transaction with `app.auth_subject` set, because council_membership and
   * council are protected by row-level security keyed on a council we do not yet know --
   * discovering it is the point of this query. Migration 0003 adds a second, additive
   * policy keyed on this setting that exposes only this one person's own memberships.
   * Setting it transaction-locally means a pooled connection cannot carry it into the
   * next request.
   */
  private async membershipsFor(address: string): Promise<Membership[]> {
    return this.db().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.auth_subject', ${address}, true)`);
      const rows = await tx.execute<{
        council_id: string;
        code: string;
        name: string;
        role: Role;
      }>(sql`
        SELECT c.id AS council_id, c.code, c.name, m.role
        FROM council_membership m
        JOIN app_user u ON u.id = m.app_user_id
        JOIN council c ON c.id = m.council_id
        WHERE lower(u.email) = ${address}
          AND m.starts_on <= current_date
          AND (m.ends_on IS NULL OR m.ends_on >= current_date)
        ORDER BY c.code
      `);
      return rows.rows.map((r) => ({
        councilId: r.council_id,
        councilCode: r.code,
        councilName: r.name,
        role: r.role,
      }));
    });
  }

  private async openSession(
    user: { id: string; email: string; full_name: string },
    council: Membership,
    memberships: Membership[],
    context: { ip?: string | null; userAgent?: string | null },
  ): Promise<SignedIn> {
    const refresh = this.tokens.newRefreshToken();
    const familyId = crypto.randomUUID();

    const session = await this.db().execute<{ id: string }>(sql`
      INSERT INTO auth_session (app_user_id, refresh_token_hash, family_id, user_agent, ip, expires_at)
      VALUES (${user.id}::uuid, ${refresh.hash}, ${familyId}::uuid,
              ${context.userAgent ?? null}, ${context.ip ?? null},
              now() + interval '${sql.raw(String(REFRESH_TTL_DAYS))} days')
      RETURNING id
    `);

    const access = await this.tokens.issueAccessToken({
      sub: user.id,
      councilId: council.councilId,
      role: council.role,
      email: user.email,
      name: user.full_name,
      sid: session.rows[0]!.id,
    });

    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: refresh.token,
      user: { id: user.id, email: user.email, name: user.full_name },
      council,
      memberships,
    };
  }

  /**
   * Rotate a refresh token.
   *
   * Presenting a token that has already been rotated means it was captured — the
   * legitimate holder would have the newer one — so the whole family is revoked and both
   * parties have to sign in again. Annoying once; the alternative is an attacker holding
   * a session indefinitely.
   */
  async refresh(
    refreshToken: string,
    context: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<SignedIn> {
    const db = this.db();
    const hash = hashRefreshToken(refreshToken);

    const found = await db.execute<{
      id: string;
      app_user_id: string;
      family_id: string;
      rotated_at: Date | null;
      revoked_at: Date | null;
      expired: boolean;
      email: string;
      full_name: string;
    }>(sql`
      SELECT s.id, s.app_user_id, s.family_id, s.rotated_at, s.revoked_at,
             (s.expires_at < now()) AS expired, u.email, u.full_name
      FROM auth_session s
      JOIN app_user u ON u.id = s.app_user_id
      WHERE s.refresh_token_hash = ${hash}
    `);

    const session = found.rows[0];
    if (!session) throw new UnauthorizedError('Session not found. Sign in again.');

    if (session.rotated_at) {
      await db.execute(sql`
        UPDATE auth_session
        SET revoked_at = now(), revoked_reason = 'refresh token reuse detected'
        WHERE family_id = ${session.family_id}::uuid AND revoked_at IS NULL
      `);
      this.log.error(
        `refresh token reuse on family ${session.family_id} — whole family revoked`,
      );
      throw new UnauthorizedError('Session expired. Sign in again.');
    }

    if (session.revoked_at || session.expired) {
      throw new UnauthorizedError('Session expired. Sign in again.');
    }

    const memberships = await this.membershipsFor(session.email.toLowerCase());
    if (memberships.length === 0) {
      await db.execute(sql`
        UPDATE auth_session SET revoked_at = now(), revoked_reason = 'no active membership'
        WHERE family_id = ${session.family_id}::uuid AND revoked_at IS NULL
      `);
      throw new UnauthorizedError('Your council membership has ended.');
    }

    const next = this.tokens.newRefreshToken();
    await db.execute(sql`UPDATE auth_session SET rotated_at = now() WHERE id = ${session.id}::uuid`);
    const rotated = await db.execute<{ id: string }>(sql`
      INSERT INTO auth_session (app_user_id, refresh_token_hash, family_id, user_agent, ip, expires_at)
      VALUES (${session.app_user_id}::uuid, ${next.hash}, ${session.family_id}::uuid,
              ${context.userAgent ?? null}, ${context.ip ?? null},
              now() + interval '${sql.raw(String(REFRESH_TTL_DAYS))} days')
      RETURNING id
    `);

    const council = memberships[0]!;
    const access = await this.tokens.issueAccessToken({
      sub: session.app_user_id,
      councilId: council.councilId,
      role: council.role,
      email: session.email,
      name: session.full_name,
      sid: rotated.rows[0]!.id,
    });

    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: next.token,
      user: { id: session.app_user_id, email: session.email, name: session.full_name },
      council,
      memberships,
    };
  }

  /**
   * Switch council. A token re-mint, not a new session — which is why requirement 38's
   * picker works from day one with a single council.
   */
  async switchCouncil(
    userId: string,
    sessionId: string,
    councilId: string,
  ): Promise<{ accessToken: string; expiresIn: number; council: Membership }> {
    const db = this.db();
    const user = await db.execute<{ email: string; full_name: string }>(
      sql`SELECT email, full_name FROM app_user WHERE id = ${userId}::uuid`,
    );
    const me = user.rows[0];
    if (!me) throw new UnauthorizedError('Sign in again.');

    const memberships = await this.membershipsFor(me.email.toLowerCase());
    const target = memberships.find((m) => m.councilId === councilId);
    if (!target) throw new UnauthorizedError('You are not a member of that council.');

    const access = await this.tokens.issueAccessToken({
      sub: userId,
      councilId: target.councilId,
      role: target.role,
      email: me.email,
      name: me.full_name,
      sid: sessionId,
    });
    return { accessToken: access.token, expiresIn: access.expiresIn, council: target };
  }

  /** Sign out. Revokes the family, so every device on that chain goes too. */
  async signOut(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await this.db().execute(sql`
      UPDATE auth_session
      SET revoked_at = now(), revoked_reason = 'signed out'
      WHERE family_id = (SELECT family_id FROM auth_session WHERE refresh_token_hash = ${hashRefreshToken(refreshToken)})
        AND revoked_at IS NULL
    `);
  }
}
