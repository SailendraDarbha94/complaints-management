import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import {
  TRUSTED_AUTHSERV_ID,
  authenticationResultsOf,
  notFromListedReason,
  parseAuthenticationResults,
  senderCheckOf,
  senderVerified,
} from './sender-check.js';

/**
 * Whether a message is really from the address on its From line, from the headers the
 * mail provider wrote on arrival. Pure, so no database.
 *
 * The header texts are shaped like the ones Gmail wrote on the Registrar's real forwards on
 * 15 October 2026 (addresses and signatures changed), folded over several lines as they
 * arrive.
 */

/** A message as it arrives: the provider's headers on top, then whatever the sender wrote. */
function raw(headerLines: string[], from = 'Registrar KSDC <registrar@ksdc.in>'): Buffer {
  return Buffer.from(
    [
      ...headerLines,
      `From: ${from}`,
      'To: ksdcregistrarblr@gmail.com',
      'Subject: Fwd: Complaint',
      'Date: Wed, 15 Oct 2026 10:14:00 +0530',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Please see below.',
    ].join('\r\n'),
    'utf8',
  );
}

const GMAIL_PASS = [
  'Authentication-Results: mx.google.com;',
  '       dkim=pass header.i=@ksdc.in header.s=default header.b=Xq3vK9aB;',
  '       spf=pass (google.com: domain of registrar@ksdc.in designates 103.21.58.10 as permitted sender) smtp.mailfrom=registrar@ksdc.in;',
  '       dmarc=none (p=NONE sp=NONE dis=NONE) header.from=ksdc.in',
];

const headersOf = async (lines: string[], from?: string) => (await simpleParser(raw(lines, from))).headers;

describe('reading an Authentication-Results header', () => {
  it('reads who wrote it and every result, through folding and comments', () => {
    const parsed = parseAuthenticationResults(GMAIL_PASS.join('\r\n').replace(/^Authentication-Results: /, ''));
    expect(parsed?.authservId).toBe(TRUSTED_AUTHSERV_ID);
    expect(parsed?.results.map((r) => `${r.method}=${r.result}`)).toEqual(['dkim=pass', 'spf=pass', 'dmarc=none']);
    expect(parsed?.results[0]?.props['header.i']).toBe('@ksdc.in');
    // The comment's "domain of registrar@ksdc.in" is not read as a property.
    expect(parsed?.results[1]?.props).toEqual({ 'smtp.mailfrom': 'registrar@ksdc.in' });
  });

  it('is read from a parsed message, topmost first', async () => {
    const headers = await headersOf([
      ...GMAIL_PASS,
      'Authentication-Results: mail.ksdc.in; spf=none smtp.mailfrom=ksdc.in',
    ]);
    const all = authenticationResultsOf(headers);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatch(/^mx\.google\.com;/);
  });
});

describe('whether the sender is confirmed', () => {
  it("confirms the Registrar's forward as Gmail checked it - dkim and spf passing for ksdc.in", async () => {
    expect(senderVerified(await headersOf(GMAIL_PASS), 'registrar@ksdc.in')).toBe(true);
  });

  it('confirms on a dkim pass alone, by header.d', async () => {
    const headers = await headersOf([
      'Authentication-Results: mx.google.com;',
      '       dkim=pass header.d=ksdc.in header.s=default header.b=Xq3vK9aB;',
      '       spf=softfail (google.com: domain of transitioning registrar@ksdc.in does not designate 203.0.113.9 as permitted sender) smtp.mailfrom=registrar@ksdc.in',
    ]);
    expect(senderVerified(headers, 'registrar@ksdc.in')).toBe(true);
  });

  it("does NOT confirm on an spf pass alone - ksdc.in's SPF list takes in a shared hosting service", async () => {
    // Anybody with an account on the web host's shared mail servers can send as
    // registrar@ksdc.in and pass SPF; only a ksdc.in signature cannot be had that way.
    const headers = await headersOf([
      'Authentication-Results: mx.google.com;',
      '       spf=pass (google.com: domain of registrar@ksdc.in designates 162.241.148.36 as permitted sender) smtp.mailfrom=registrar@ksdc.in;',
      '       dmarc=none (p=NONE sp=NONE dis=NONE) header.from=ksdc.in',
    ]);
    expect(senderVerified(headers, 'registrar@ksdc.in')).toBe(false);
    expect(senderCheckOf(['registrar@ksdc.in'], 'registrar@ksdc.in', headers)).toBe('unverified');
  });

  it('never takes a signature by a look-alike domain for the sender\'s own', async () => {
    for (const signer of ['header.d=sdc.in', 'header.d=evilksdc.in', 'header.d=ksdc.in.evil.com', 'header.i=@sdc.in', 'header.i=@evilksdc.in']) {
      const headers = await headersOf([`Authentication-Results: mx.google.com; dkim=pass ${signer} header.s=s1`]);
      expect(senderVerified(headers, 'registrar@ksdc.in'), signer).toBe(false);
    }
  });

  it('is not fooled by a fake result written into the envelope address the provider repeats', () => {
    // The sending server chooses the envelope address, and the provider writes it into its
    // own header twice - in the spf comment and as smtp.mailfrom. A quoted address can carry
    // ";" and brackets, enough to add a "dkim=pass" result of its own to that header.
    const quoted = '"a; dkim=pass header.d=ksdc.in b"@evil.com';
    const injected =
      `mx.google.com; spf=softfail (google.com: domain of transitioning ${quoted} does not ` +
      `designate 192.0.2.1 as permitted sender) smtp.mailfrom=${quoted}`;
    // A bracket inside the quotes ends the comment early in a reader that forgets the quotes.
    const breakout = '"x) dkim=pass header.d=ksdc.in; spf=none (y"@evil.com';
    const escaped =
      `mx.google.com; spf=softfail (google.com: domain of transitioning ${breakout} does not ` +
      `designate 192.0.2.1 as permitted sender) smtp.mailfrom=${breakout}`;

    // Read naively, the first header does hold a passing ksdc.in signature...
    expect(
      parseAuthenticationResults(injected)?.results.some((r) => r.method === 'dkim' && r.result === 'pass'),
    ).toBe(true);
    // ...but a provider header with quotes in it is not trusted at all.
    for (const header of [injected, escaped, `${GMAIL_PASS.join(' ').replace(/^Authentication-Results: /, '')} (\\")`]) {
      const headers = new Map([['authentication-results', header]]);
      expect(senderVerified(headers, 'registrar@ksdc.in'), header).toBe(false);
    }
  });

  it('accepts a signature by the domain a sub-domain sender belongs to, never by a bare country domain', async () => {
    const parent = await headersOf(['Authentication-Results: mx.google.com; dkim=pass header.i=@ksdc.in header.s=s1']);
    expect(senderVerified(parent, 'registrar@mail.ksdc.in')).toBe(true);
    const tld = await headersOf(['Authentication-Results: mx.google.com; dkim=pass header.d=in header.s=s1']);
    expect(senderVerified(tld, 'registrar@ksdc.in')).toBe(false);
    // Nor the other way: a sub-domain's signature does not speak for the parent's address.
    const child = await headersOf(['Authentication-Results: mx.google.com; dkim=pass header.d=mail.ksdc.in']);
    expect(senderVerified(child, 'registrar@ksdc.in')).toBe(false);
  });

  it("does not confirm on spf softfail with no signature - the Registrar's address typed into somebody else's mail", async () => {
    const headers = await headersOf([
      'Authentication-Results: mx.google.com;',
      '       spf=softfail (google.com: domain of transitioning registrar@ksdc.in does not designate 198.51.100.7 as permitted sender) smtp.mailfrom=registrar@ksdc.in;',
      '       dmarc=none (p=NONE sp=NONE dis=NONE) header.from=ksdc.in',
    ]);
    expect(senderVerified(headers, 'registrar@ksdc.in')).toBe(false);
  });

  it("does not confirm on a pass for another domain - a mailing list's or a marketing service's own signature", async () => {
    const headers = await headersOf([
      'Authentication-Results: mx.google.com;',
      '       dkim=pass header.i=@lists.example.org header.s=list header.b=Lm2nO3pQ;',
      '       dkim=fail header.i=@ksdc.in header.s=default header.b=Xq3vK9aB;',
      '       spf=pass (google.com: domain of list-bounces@lists.example.org designates 192.0.2.4 as permitted sender) smtp.mailfrom=list-bounces@lists.example.org',
    ]);
    expect(senderVerified(headers, 'registrar@ksdc.in')).toBe(false);
  });

  it('ignores a fake header lower down, however good it looks', async () => {
    // What the sender wrote into their own message, below what Gmail added on top.
    const headers = await headersOf([
      'Authentication-Results: mx.google.com;',
      '       spf=softfail smtp.mailfrom=registrar@ksdc.in',
      'Authentication-Results: mx.google.com;',
      '       dkim=pass header.i=@ksdc.in header.s=default;',
      '       spf=pass smtp.mailfrom=registrar@ksdc.in',
    ]);
    expect(senderVerified(headers, 'registrar@ksdc.in')).toBe(false);
  });

  it("reads only the provider's own header, not another server's above it", async () => {
    const headers = await headersOf([
      'Authentication-Results: relay.example.net; dkim=pass header.d=ksdc.in; spf=pass smtp.mailfrom=ksdc.in',
      ...GMAIL_PASS.map((l) => l.replace('dkim=pass', 'dkim=fail').replace('spf=pass', 'spf=fail')),
    ]);
    expect(senderVerified(headers, 'registrar@ksdc.in')).toBe(false);
  });

  it('does not confirm when there is no Authentication-Results header at all', async () => {
    expect(senderVerified(await headersOf([]), 'registrar@ksdc.in')).toBe(false);
    expect(senderVerified(null, 'registrar@ksdc.in')).toBe(false);
    expect(senderVerified(new Map(), 'registrar@ksdc.in')).toBe(false);
  });

  it('does not confirm a message with no usable sender address', async () => {
    const headers = await headersOf(GMAIL_PASS);
    expect(senderVerified(headers, null)).toBe(false);
    expect(senderVerified(headers, 'ksdc.in')).toBe(false);
  });
});

describe("the council's rule", () => {
  const LIST = ['registrar@ksdc.in'];

  it('makes no check at all when the council has no list', async () => {
    expect(senderCheckOf([], 'anyone@example.com', await headersOf([]))).toBeNull();
    expect(senderCheckOf(undefined, 'anyone@example.com', null)).toBeNull();
  });

  it('turns away any other address, however well signed', async () => {
    const adobe = await headersOf(
      ['Authentication-Results: mx.google.com; dkim=pass header.i=@mail.adobe.com; spf=pass smtp.mailfrom=bounce@mail.adobe.com'],
      'Adobe <mail@mail.adobe.com>',
    );
    expect(senderCheckOf(LIST, 'mail@mail.adobe.com', adobe)).toBe('not_allowed');
    expect(senderCheckOf(LIST, null, adobe)).toBe('not_allowed');
  });

  it('confirms or does not confirm a listed address, whatever case it is written in', async () => {
    expect(senderCheckOf(LIST, 'Registrar@KSDC.in', await headersOf(GMAIL_PASS))).toBe('verified');
    expect(senderCheckOf(LIST, 'registrar@ksdc.in', await headersOf([]))).toBe('unverified');
  });

  it('names the addresses in the reason for setting a message aside', () => {
    expect(notFromListedReason(LIST)).toBe(
      'Not from registrar@ksdc.in, the only address complaints are forwarded from. ' +
        'Set aside automatically - bring it back if it is a complaint.',
    );
    expect(notFromListedReason(['a@ksdc.in', 'b@ksdc.in', 'c@ksdc.in'])).toMatch(
      /^Not from a@ksdc\.in, b@ksdc\.in or c@ksdc\.in, the only addresses complaints/,
    );
  });
});
