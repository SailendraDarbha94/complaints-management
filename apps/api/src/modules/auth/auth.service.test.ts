import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, initDb, withCouncil, type Db } from '@ksdc/db';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { assertSendable, type OutboundMessage, MailerPort } from '../notifications/mailer.js';
import { seedCouncilAndOfficer } from '../../test-support/fixtures.js';

/**
 * Sign-in. The tests that matter are the ones about what the endpoint refuses to tell an
 * attacker, and what happens to a stolen refresh token.
 */

let db: Db;
const councilA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const councilB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const officerId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const officerEmail = 'officer@auth.test';

/** Captures mail instead of sending it, and exposes the code the test needs. */
class CapturingMailer extends MailerPort {
  sent: OutboundMessage[] = [];
  async send(message: OutboundMessage) {
    assertSendable(message.to);
    this.sent.push(message);
    return { transport: 'console' as const, messageId: crypto.randomUUID() };
  }
  lastCode(): string {
    const last = this.sent.at(-1);
    if (!last) throw new Error('No mail was sent');
    const match = /Your code is (\d{6})\./.exec(last.text);
    if (!match) throw new Error(`No code in: ${last.text}`);
    return match[1]!;
  }
}

let mailer: CapturingMailer;
let auth: AuthService;

beforeAll(async () => {
  db = initDb({ connectionString: process.env.TEST_DATABASE_URL });
  await withCouncil({ councilId: councilA }, (tx) =>
    seedCouncilAndOfficer(tx, { councilId: councilA, officerId, code: 'AUTH' }),
  );
  await withCouncil({ councilId: councilB }, (tx) =>
    seedCouncilAndOfficer(tx, {
      councilId: councilB,
      officerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      code: 'AUTB',
    }),
  );
  // The seeded officer's address is derived from the council code; give it a stable one.
  await db.execute(sql`
    UPDATE app_user SET email = ${officerEmail} WHERE id = ${officerId}::uuid
  `);
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  mailer = new CapturingMailer();
  auth = new AuthService(new TokenService(), mailer);

  // Retire live codes and sessions, and push every past request outside the rate-limit
  // window. The limiter counts rows by created_at regardless of whether they were used,
  // and the application role has no DELETE grant, so backdating is how a test starts
  // clean. Five requests an hour is a real limit, and one test's requests would
  // otherwise silence the next test's.
  await db.execute(sql`
    UPDATE auth_otp
    SET consumed_at = COALESCE(consumed_at, now()),
        created_at = created_at - interval '2 hours'
    WHERE created_at > now() - interval '2 hours'
  `);
  await db.execute(sql`
    UPDATE auth_session SET revoked_at = now(), revoked_reason = 'test reset'
    WHERE revoked_at IS NULL
  `);
});

async function signIn() {
  await auth.requestCode(officerEmail);
  return auth.verifyCode(officerEmail, mailer.lastCode());
}

describe('requesting a code', () => {
  it('emails a six-digit code', async () => {
    await auth.requestCode(officerEmail);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(officerEmail);
    expect(mailer.lastCode()).toMatch(/^\d{6}$/);
  });

  it('answers identically for an address nobody owns', async () => {
    // An endpoint that says "no such user" enumerates the people who can alter this
    // register, and there are about four of them.
    const known = await auth.requestCode(officerEmail);
    const unknown = await auth.requestCode('nobody@auth.test');
    expect(unknown).toEqual(known);
    // But no mail was actually sent to the stranger.
    expect(mailer.sent.map((m) => m.to)).toEqual([officerEmail]);
  });

  it('retires the previous code, so only one is ever live', async () => {
    await auth.requestCode(officerEmail);
    const first = mailer.lastCode();
    await auth.requestCode(officerEmail);
    const second = mailer.lastCode();

    // Two live codes would double an attacker's guessing budget for free.
    await expect(auth.verifyCode(officerEmail, first)).rejects.toThrow(/not valid/i);
    await expect(auth.verifyCode(officerEmail, second)).resolves.toBeTruthy();
  });

  it('stops issuing codes after five requests in an hour', async () => {
    for (let i = 0; i < 5; i++) await auth.requestCode(officerEmail);
    expect(mailer.sent).toHaveLength(5);
    const sixth = await auth.requestCode(officerEmail);
    // Same answer, no sixth email.
    expect(sixth).toEqual({ sent: true });
    expect(mailer.sent).toHaveLength(5);
  });

  it('never stores the code itself', async () => {
    await auth.requestCode(officerEmail);
    const code = mailer.lastCode();
    const row = await db.execute<{ code_hash: string }>(sql`
      SELECT code_hash FROM auth_otp
      WHERE lower(email) = ${officerEmail} AND consumed_at IS NULL
    `);
    expect(row.rows[0]!.code_hash).not.toContain(code);
    expect(row.rows[0]!.code_hash).toMatch(/^scrypt\$/);
  });
});

describe('verifying a code', () => {
  it('signs in and reports the memberships', async () => {
    const session = await signIn();
    expect(session.user.email).toBe(officerEmail);
    expect(session.council.councilId).toBe(councilA);
    expect(session.council.role).toBe('officer');
    expect(session.accessToken.split('.')).toHaveLength(3);
    expect(session.refreshToken).toBeTruthy();
  });

  it('burns the code after five wrong guesses', async () => {
    await auth.requestCode(officerEmail);
    const real = mailer.lastCode();
    const wrong = real === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
      await expect(auth.verifyCode(officerEmail, wrong)).rejects.toThrow(/not valid/i);
    }
    // Even the correct code no longer works: guessing burns it rather than merely
    // slowing the guesser down.
    await expect(auth.verifyCode(officerEmail, real)).rejects.toThrow(/not valid/i);
  });

  it('cannot reuse a code', async () => {
    await auth.requestCode(officerEmail);
    const code = mailer.lastCode();
    await auth.verifyCode(officerEmail, code);
    await expect(auth.verifyCode(officerEmail, code)).rejects.toThrow(/not valid/i);
  });

  it('refuses an expired code', async () => {
    await auth.requestCode(officerEmail);
    const code = mailer.lastCode();
    await db.execute(sql`
      UPDATE auth_otp SET expires_at = now() - interval '1 minute'
      WHERE lower(email) = ${officerEmail} AND consumed_at IS NULL
    `);
    await expect(auth.verifyCode(officerEmail, code)).rejects.toThrow(/not valid/i);
  });

  it('gives the same message whatever went wrong', async () => {
    // Expired, wrong, already used and never-issued must be indistinguishable.
    const messages: string[] = [];
    await auth.requestCode(officerEmail);
    const code = mailer.lastCode();

    await auth.verifyCode(officerEmail, code);
    await auth.verifyCode(officerEmail, code).catch((e) => messages.push(e.message));
    await auth.verifyCode('nobody@auth.test', '123456').catch((e) => messages.push(e.message));
    await auth.verifyCode(officerEmail, '999999').catch((e) => messages.push(e.message));

    expect(new Set(messages).size).toBe(1);
  });

  it('refuses an account whose council membership has ended', async () => {
    // Inside a council scope: council_membership is protected by row-level security, so
    // an UPDATE from outside one matches nothing and the test would pass vacuously.
    await withCouncil({ councilId: councilA }, (tx) =>
      tx.execute(sql`
        UPDATE council_membership SET ends_on = current_date - 1
        WHERE app_user_id = ${officerId}::uuid
      `),
    );

    await auth.requestCode(officerEmail);
    await expect(auth.verifyCode(officerEmail, mailer.lastCode())).rejects.toThrow(
      /not a member of any council/i,
    );

    await withCouncil({ councilId: councilA }, (tx) =>
      tx.execute(sql`
        UPDATE council_membership SET ends_on = NULL WHERE app_user_id = ${officerId}::uuid
      `),
    );
  });
});

describe('refresh tokens', () => {
  it('rotates on every use', async () => {
    const first = await signIn();
    const second = await auth.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.user.id).toBe(first.user.id);
  });

  it('revokes the whole family when a rotated token is presented again', async () => {
    const first = await signIn();
    const second = await auth.refresh(first.refreshToken);

    // Replaying the old token is the signature of a captured token: the legitimate
    // holder would be using the newer one.
    await expect(auth.refresh(first.refreshToken)).rejects.toThrow(/expired/i);

    // And the attacker's newer token dies with it, so neither party keeps the session.
    await expect(auth.refresh(second.refreshToken)).rejects.toThrow(/expired/i);
  });

  it('refuses a token that was never issued', async () => {
    await expect(auth.refresh('not-a-real-token')).rejects.toThrow(/not found/i);
  });

  it('refuses to refresh after signing out', async () => {
    const session = await signIn();
    await auth.signOut(session.refreshToken);
    await expect(auth.refresh(session.refreshToken)).rejects.toThrow(/expired/i);
  });
});

describe('the access token', () => {
  it('carries the council, so a request cannot silently act on another one', async () => {
    const tokens = new TokenService();
    const session = await signIn();
    const claims = await tokens.verifyAccessToken(session.accessToken);
    expect(claims.councilId).toBe(councilA);
    expect(claims.sub).toBe(officerId);
    expect(claims.role).toBe('officer');
  });

  it('refuses a tampered token', async () => {
    const tokens = new TokenService();
    const session = await signIn();
    const [header, payload, signature] = session.accessToken.split('.');
    const forged = [header, Buffer.from('{"sub":"attacker"}').toString('base64url'), signature].join('.');
    await expect(tokens.verifyAccessToken(forged)).rejects.toThrow();
  });
});

describe('switching council', () => {
  it('refuses a council the user is not a member of', async () => {
    const session = await signIn();
    const claims = await new TokenService().verifyAccessToken(session.accessToken);
    await expect(auth.switchCouncil(officerId, claims.sid, councilB)).rejects.toThrow(
      /not a member/i,
    );
  });
});

describe('the shared-inbox guard', () => {
  it('refuses to send system mail to the inbox complaints arrive in', () => {
    // registrar@ksdc.in is the pile the officer is escaping. Adding system mail to it
    // would make this product part of the problem it exists to solve.
    expect(() => assertSendable('registrar@ksdc.in')).toThrow(/Refusing to send/);
    expect(() => assertSendable('support@ksdc.in')).toThrow(/Refusing to send/);
    expect(() => assertSendable('officer@ksdc.in')).not.toThrow();
  });
});
