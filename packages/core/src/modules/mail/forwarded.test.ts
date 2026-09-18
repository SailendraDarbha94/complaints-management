import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { snippetOf, unwrapForward } from './forwarded.js';

/**
 * The forwarded-mail parser, against the shapes real clients actually emit.
 *
 * Every separator here was measured rather than remembered, because the counts are not
 * what anybody assumes: Gmail writes TEN leading hyphens and NINE trailing ones, Outlook
 * Web writes a bare rule of thirty-two underscores, Outlook desktop writes five each side.
 * A parser that matches any of these as a literal string fails silently on every message
 * from every other client — and silently is the problem, because the complaint would then
 * be filed under the officer's own name with nobody the wiser.
 */

/** Build a message the way a mail server would hand it over. */
function raw(headers: Record<string, string>, body: string): Buffer {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  return Buffer.from([...lines, '', body].join('\r\n'), 'utf8');
}

const FORWARD_HEADERS = {
  From: 'Dental Officer <officer@ksdc.in>',
  To: 'intake@ksdc-register.example',
  Subject: 'Fwd: Complaint against Dr Ramesh',
  'Message-ID': '<fwd-001@mail.gmail.com>',
  Date: 'Wed, 17 Sep 2026 10:14:00 +0530',
  'Content-Type': 'text/plain; charset=utf-8',
};

async function unwrapBody(body: string) {
  return unwrapForward(await simpleParser(raw(FORWARD_HEADERS, body)));
}

describe('a Gmail forward', () => {
  // Ten leading hyphens, NINE trailing. Measured, not guessed. The historical form was
  // ten and ten, which is exactly why this is matched by shape and not by string.
  const GMAIL = [
    'Sir, please log this one.',
    '',
    '---------- Forwarded message ---------',
    'From: *Kavitha Devi* <kdevi@example.in>',
    'Date: Tue, 16 Sep 2026 at 19:12',
    'Subject: Complaint against Dr Ramesh',
    'To: <registrar@ksdc.in>',
    '',
    'My crown was fitted in June and came off within a week.',
    'The doctor has refused to refit it without charging again.',
  ].join('\r\n');

  it('finds the complainant, not the officer who forwarded it', async () => {
    const out = await unwrapBody(GMAIL);
    expect(out.kind).toBe('gmail');
    expect(out.fromAddress).toBe('kdevi@example.in');
    expect(out.subject).toBe('Complaint against Dr Ramesh');
  });

  it('strips the asterisks Gmail wraps the display name in', async () => {
    // They are the plain-text rendering of Gmail's <strong class="gmail_sendername">.
    // Left in, they are written to the party record and print on a letter.
    const out = await unwrapBody(GMAIL);
    expect(out.fromName).toBe('Kavitha Devi');
  });

  it('keeps the forwarded date as TEXT, because it carries no timezone', async () => {
    const out = await unwrapBody(GMAIL);
    expect(out.date).toBeNull();
    expect(out.dateText).toBe('Tue, 16 Sep 2026 at 19:12');
  });

  it("drops the officer's covering note and keeps the complainant's words", async () => {
    const out = await unwrapBody(GMAIL);
    expect(out.body).toMatch(/crown was fitted in June/);
    expect(out.body).not.toMatch(/please log this one/);
  });

  it('still matches when Gmail emits the older symmetric separator', async () => {
    const out = await unwrapBody(GMAIL.replace(/-{9}$/m, '----------'));
    expect(out.fromAddress).toBe('kdevi@example.in');
  });
});

describe('the other clients', () => {
  it('reads an Outlook Web forward, whose separator is a bare rule of underscores', async () => {
    const out = await unwrapBody(
      [
        '________________________________',
        'From: Suresh Kumar <skumar@example.in>',
        'Sent: 16 September 2026 19:12',
        'To: Registrar KSDC <registrar@ksdc.in>',
        'Subject: Treatment complaint',
        '',
        'The extraction was done on the wrong tooth.',
      ].join('\r\n'),
    );
    expect(out.kind).toBe('outlook_web');
    expect(out.fromAddress).toBe('skumar@example.in');
    // Outlook says Sent: where everyone else says Date:.
    expect(out.dateText).toBe('16 September 2026 19:12');
    expect(out.subject).toBe('Treatment complaint');
  });

  it('reads an Outlook desktop forward', async () => {
    const out = await unwrapBody(
      [
        '-----Original Message-----',
        'From: Anita Rao <arao@example.in>',
        'Sent: Tuesday, 16 September 2026 19:12',
        'To: registrar@ksdc.in',
        'Subject: Implant failure',
        '',
        'The implant placed last year has failed.',
      ].join('\r\n'),
    );
    expect(out.kind).toBe('outlook_desktop');
    expect(out.fromAddress).toBe('arao@example.in');
  });

  it('reads an Apple Mail forward through its quote markers', async () => {
    // Apple Mail quotes the whole forwarded block with `>` in the text alternative, so a
    // parser anchored on ^From: finds nothing at all.
    const out = await unwrapBody(
      [
        'Begin forwarded message:',
        '',
        '> From: Prakash N <pn@example.in>',
        '> Subject: Root canal fees',
        '> Date: 16 September 2026 at 19:12:03 IST',
        '> To: registrar@ksdc.in',
        '>',
        '> I was charged twice for the same treatment.',
      ].join('\r\n'),
    );
    expect(out.kind).toBe('apple_mail');
    expect(out.fromAddress).toBe('pn@example.in');
    expect(out.subject).toBe('Root canal fees');
    expect(out.body).toMatch(/charged twice/);
  });

  it('reads the field order each client uses, rather than counting lines', async () => {
    // Gmail: From/Date/Subject/To. Outlook: From/Sent/To/Subject. Apple: From/Subject/Date/To.
    // Anything positional is wrong for two of the three.
    const appleOrder = await unwrapBody(
      [
        'Begin forwarded message:',
        '',
        'From: A B <ab@example.in>',
        'Subject: S',
        'Date: 1 Jan 2026',
        'To: registrar@ksdc.in',
        '',
        'body',
      ].join('\r\n'),
    );
    expect(appleOrder.subject).toBe('S');
    expect(appleOrder.dateText).toBe('1 Jan 2026');
  });
});

describe('forwarded as an attachment', () => {
  it('is preferred over everything else, and is the only source of a real timestamp', async () => {
    const inner = raw(
      {
        From: 'Sunitha Rangaswamy <sunitha@example.in>',
        To: 'registrar@ksdc.in',
        Subject: 'Complaint against Dr Ramesh',
        'Message-ID': '<inner-1@example.in>',
        Date: 'Mon, 14 Sep 2026 19:02:41 +0530',
        'Content-Type': 'text/plain; charset=utf-8',
      },
      'The bridge came loose within a fortnight.',
    );

    const outer = Buffer.from(
      [
        'From: Dental Officer <officer@ksdc.in>',
        'To: intake@ksdc-register.example',
        'Subject: Fwd: Complaint against Dr Ramesh',
        'Date: Wed, 17 Sep 2026 10:14:00 +0530',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Attaching the original.',
        '',
        '--b1',
        'Content-Type: message/rfc822',
        '',
        inner.toString('utf8'),
        '',
        '--b1--',
        '',
      ].join('\r\n'),
      'utf8',
    );

    const out = await unwrapForward(await simpleParser(outer));
    expect(out.kind).toBe('rfc822_attachment');
    expect(out.fromAddress).toBe('sunitha@example.in');
    expect(out.fromName).toBe('Sunitha Rangaswamy');
    // The only route where the offset is real. +0530 on the 14th at 19:02 is 13:32 UTC.
    expect(out.date?.toISOString()).toBe('2026-09-14T13:32:41.000Z');
    expect(out.dateText).toBeNull();
  });
});

describe('the awkward ones', () => {
  it('survives an HTML-only forward, where mailparser rewrites addresses as "X [X]"', async () => {
    // With no text/plain part mailparser synthesises one from the HTML, turning
    // <a href="mailto:X">X</a> into `X [X]` and hard-wrapping the result - so the angle
    // bracket that would close the address can land on the next line and the obvious
    // /<([^>]+)>/ returns null. This is a silent total failure if it is not handled.
    const html = [
      '<div>Please log this.</div>',
      '<div class="gmail_quote">',
      '<div>---------- Forwarded message ---------</div>',
      '<div>From: Meera Joshi &lt;<a href="mailto:meera@example.in">meera@example.in</a>&gt;</div>',
      '<div>Date: Tue, 16 Sep 2026 at 19:12</div>',
      '<div>Subject: Denture complaint</div>',
      '<div>To: &lt;<a href="mailto:registrar@ksdc.in">registrar@ksdc.in</a>&gt;</div>',
      '<div><br></div>',
      '<div>The denture does not fit and I have been asked to pay again.</div>',
      '</div>',
    ].join('');

    const out = await unwrapForward(
      await simpleParser(
        raw({ ...FORWARD_HEADERS, 'Content-Type': 'text/html; charset=utf-8' }, html),
      ),
    );
    expect(out.fromAddress).toBe('meera@example.in');
    expect(out.subject).toBe('Denture complaint');
  });

  it('says so plainly when a message was written to us directly', async () => {
    const out = await unwrapBody('I wish to complain about my dentist. Regards, A. Patient');
    expect(out.kind).toBe('none');
    expect(out.fromAddress).toBeNull();
  });

  it('refuses to invent a sender when it sees a separator it cannot read', async () => {
    // Better to hand the officer the whole thing and say 'generic' than to guess.
    const out = await unwrapBody(
      ['---------- Forwarded message ---------', 'something entirely unexpected'].join('\r\n'),
    );
    expect(out.kind).toBe('generic');
    expect(out.fromAddress).toBeNull();
    expect(out.body).toMatch(/entirely unexpected/);
  });

  it('takes a bare address with no angle brackets', async () => {
    const out = await unwrapBody(
      [
        '---------- Forwarded message ---------',
        'From: kdevi@example.in',
        'Subject: X',
        '',
        'body',
      ].join('\r\n'),
    );
    expect(out.fromAddress).toBe('kdevi@example.in');
  });

  it('lower-cases the address, because party.email is compared case-insensitively', async () => {
    const out = await unwrapBody(
      ['---------- Forwarded message ---------', 'From: A <KDevi@Example.IN>', '', 'b'].join('\r\n'),
    );
    expect(out.fromAddress).toBe('kdevi@example.in');
  });
});

describe('the snippet on the card', () => {
  it('is the complainant’s first words, not a quoted signature', () => {
    expect(
      snippetOf('My crown came off.\n> On Tue someone wrote:\n> regards\n--\nSent from my iPhone'),
    ).toBe('My crown came off. Sent from my iPhone');
  });

  it('ends with an ellipsis rather than mid-word', () => {
    const long = snippetOf('word '.repeat(200));
    expect(long.length).toBeLessThanOrEqual(280);
    expect(long.endsWith('…')).toBe(true);
  });

  it('is empty, not null, when there is nothing to show', () => {
    expect(snippetOf(null)).toBe('');
  });
});
