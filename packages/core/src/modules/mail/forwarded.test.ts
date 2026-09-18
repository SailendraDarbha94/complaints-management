import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { snippetOf, unwrapForward, type ForwardedOriginal } from './forwarded.js';

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
  it('reads Outlook 2007/2010\'s "Name [mailto:addr]" without keeping the mailto:', async () => {
    const out = await unwrapBody(
      [
        '-----Original Message-----',
        'From: Kavitha Devi [mailto:kdevi@example.in]',
        'Sent: Tuesday, September 16, 2026 7:12 PM',
        'To: registrar@ksdc.in',
        'Subject: Complaint against Dr Ramesh',
        '',
        'My crown was fitted in June and came off within a week.',
      ].join('\r\n'),
    );
    expect(out.fromAddress).toBe('kdevi@example.in');
    expect(out.fromName).toBe('Kavitha Devi');
  });

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

describe('a Roundcube forward (the Council webmail at ksdc.in)', () => {
  // The structure of the first real forward from the office account - Roundcube 1.6.19 -
  // with every name, address and word of the complaint invented.
  //
  // Roundcube draws NO separator line. The forwarded message opens straight into a table of
  // header rows, and the text/plain alternative Roundcube generates from it (its own
  // html2text, not mailparser's) upper-cases each <th>, indents with a space and two tabs,
  // and puts the value on the line below. Before this was handled, the case it opened named
  // the Council itself as the complainant.
  type Row = [label: string, value: string];

  const ROWS: Row[] = [
    ['Subject', 'Treatment complaint'],
    ['Date', '2026-09-16 11:40'],
    ['From', 'Lakshmi Narayan Rao <ln.rao1958@example.in>'],
    ['To', '"registrar@ksdc.in" <registrar@ksdc.in>'],
  ];
  const LETTER = [
    'To',
    'The Registrar',
    'Karnataka State Dental Council',
    '',
    'Respected Sir,',
    '',
    'Subject: Complaint against Example Dental Clinic, Jayanagar',
    '',
    'The bridge fitted in August has come loose twice and the clinic will not refund me.',
    '',
    'Yours faithfully,',
    'L. N. Rao',
  ];

  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /** A Roundcube forward as it arrives: multipart/alternative, text part first. */
  function roundcube(rows: Row[], subject = 'Fwd: Treatment complaint'): Buffer {
    const text = [
      ...rows.flatMap(([label, value]) => [` \t\t${label.toUpperCase()}:`, ` \t\t${value}`, '']),
      ...LETTER,
    ].join('\r\n');
    const html = [
      "<html><body style='font-size: 12pt; font-family: Helvetica,Arial,sans-serif'>",
      '<div id="signature"></div>',
      '<table border="0" cellspacing="0" cellpadding="0">',
      '<tbody>',
      ...rows.flatMap(([label, value]) => [
        '<tr>',
        `<th align="right" valign="baseline" nowrap="nowrap">${label}:</th>`,
        `<td>${escape(value)}</td>`,
        '</tr>',
      ]),
      '</tbody>',
      '</table>',
      '<br />',
      '<div id="forwardbody1">',
      ...LETTER.map((l) => `<div>${escape(l) || '<br />'}</div>`),
      '</div>',
      '</body></html>',
    ].join('\r\n');
    const b = '=_invented0boundary';
    return Buffer.from(
      [
        'From: Registrar Karnataka State Dental Council <registrar@ksdc.in>',
        'To: intake@ksdc-register.example',
        `Subject: ${subject}`,
        'Message-ID: <rc-001@ksdc.in>',
        'Date: Thu, 17 Sep 2026 12:02:00 +0530',
        'MIME-Version: 1.0',
        'User-Agent: Roundcube Webmail/1.6.19',
        `Content-Type: multipart/alternative; boundary="${b}"`,
        '',
        `--${b}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        text,
        `--${b}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        html,
        `--${b}--`,
        '',
      ].join('\r\n'),
      'utf8',
    );
  }

  const unwrapRoundcube = async (rows: Row[], subject?: string) =>
    unwrapForward(await simpleParser(roundcube(rows, subject)));

  it('finds the complainant in the header table, not the office that forwarded it', async () => {
    const out = await unwrapRoundcube(ROWS);
    expect(out.kind).toBe('header_block');
    expect(out.fromAddress).toBe('ln.rao1958@example.in');
    expect(out.fromName).toBe('Lakshmi Narayan Rao');
    expect(out.subject).toBe('Treatment complaint');
    expect(out.dateText).toBe('2026-09-16 11:40');
    // Text, never a timestamp: "2026-09-16 11:40" says nothing about its timezone.
    expect(out.date).toBeNull();
  });

  it("keeps the complainant's letter as the body, and no header rows in it", async () => {
    const out = await unwrapRoundcube(ROWS);
    expect(out.body).toMatch(/^To\r?\nThe Registrar/);
    expect(out.body).toMatch(/come loose twice/);
    expect(out.body).not.toMatch(/ln\.rao1958/);
    // A "Subject:" line inside the letter belongs to the letter, not to the header block.
    expect(out.body).toMatch(/Subject: Complaint against Example Dental Clinic/);
  });

  it('reads the rows in whatever order they come', async () => {
    const out = await unwrapRoundcube([ROWS[2]!, ROWS[0]!, ROWS[3]!, ROWS[1]!]);
    expect(out.fromAddress).toBe('ln.rao1958@example.in');
    expect(out.subject).toBe('Treatment complaint');
  });

  it('accepts the Fw: and FW: that other clients put on a forward', async () => {
    for (const subject of ['Fw: Treatment complaint', 'FW: Treatment complaint']) {
      const out = await unwrapRoundcube(ROWS, subject);
      expect(out.fromAddress).toBe('ln.rao1958@example.in');
    }
  });

  it('does not take a pasted header block for the sender when the subject is not a forward', async () => {
    // Somebody writing to us directly who pastes an earlier email into their complaint
    // stays the complainant: the pasted From: is somebody else.
    const out = await unwrapRoundcube(ROWS, 'Treatment complaint');
    expect(out.kind).toBe('none');
    expect(out.fromAddress).toBeNull();
  });

  it('reads an empty row as empty, not as a sender called "TO:"', async () => {
    const out = await unwrapRoundcube([
      ['Subject', 'Treatment complaint'],
      ['From', ''],
      ['To', 'registrar@ksdc.in'],
      ['Date', '2026-09-16 11:40'],
    ]);
    expect(out.fromName ?? '').not.toMatch(/TO:/i);
    expect(out.fromAddress).not.toBe('registrar@ksdc.in');
  });

  it('reads the same header block written one label per line in plain text', async () => {
    const out = await unwrapBody(
      [
        'Subject: Treatment complaint',
        'Date: 2026-09-16 11:40',
        'From: Lakshmi Narayan Rao <ln.rao1958@example.in>',
        'To: registrar@ksdc.in',
        '',
        'The bridge fitted in August has come loose twice.',
      ].join('\r\n'),
    );
    expect(out.kind).toBe('header_block');
    expect(out.fromAddress).toBe('ln.rao1958@example.in');
    expect(out.body).toBe('The bridge fitted in August has come loose twice.');
  });

  it('reads a Roundcube plain-text forward through its Original Message rule', async () => {
    // Roundcube in plain-text compose mode draws "-------- Original Message --------",
    // which is the Outlook desktop shape; it is filed under that name.
    const out = await unwrapBody(
      [
        '-------- Original Message --------',
        'Subject: Treatment complaint',
        'Date: 2026-09-16 11:40',
        'From: Lakshmi Narayan Rao <ln.rao1958@example.in>',
        'To: registrar@ksdc.in',
        '',
        'The bridge fitted in August has come loose twice.',
      ].join('\r\n'),
    );
    expect(out.fromAddress).toBe('ln.rao1958@example.in');
    expect(out.body).toBe('The bridge fitted in August has come loose twice.');
  });
});

// ─── Every client the research covered, one describe each ───────────────────────
//
// A research pass read the forward code of the webmail clients Indian institutions use -
// the source itself for Roundcube, Zimbra, Horde and SquirrelMail; documented and observed
// samples for Outlook, Yahoo and Zoho, which are closed - built a forward in each of their
// modes, and ran every one through mailparser 3.9.28. The messages below reproduce the part
// mailparser reads for each, character for character, with every person and clinic
// invented. A multipart message's HTML part is kept only where the parser comes to read
// it: given a text part, mailparser takes .text from that and leaves the HTML alone.

/** What a test message is built from. See mime(). */
interface Parts {
  subject: string;
  /** The text/plain part. */
  text?: string;
  /** Its Content-Type, where that is more than plain UTF-8: format=flowed, say. */
  textType?: string;
  /** The text/html part. With `text` as well, the two travel as multipart/alternative. */
  html?: string;
  /** Beside the body, in multipart/mixed. With no body at all, it IS the message. */
  attachment?: { type: string; name?: string; content: string; base64?: boolean };
}

/**
 * A message as the mail server hands it over. Which parts it has is part of what a test
 * tests: HTML alone makes mailparser write .text itself, with html-to-text, and that is a
 * different text from the one the client would have written.
 */
function mime(p: Parts): Buffer {
  const part = (type: string, content: string, extra: string[]) => [
    `Content-Type: ${type}`,
    ...extra,
    '',
    content,
  ];
  const multipart = (subtype: string, parts: string[][]) => [
    `Content-Type: multipart/${subtype}; boundary="=_${subtype}"`,
    '',
    ...parts.flatMap((lines) => [`--=_${subtype}`, ...lines]),
    `--=_${subtype}--`,
    '',
  ];
  const eightBit = ['Content-Transfer-Encoding: 8bit'];

  const text =
    p.text === undefined ? null : part(p.textType ?? 'text/plain; charset=UTF-8', p.text, eightBit);
  const html = p.html === undefined ? null : part('text/html; charset=UTF-8', p.html, eightBit);
  const body = text && html ? multipart('alternative', [text, html]) : (text ?? html);

  const a = p.attachment;
  const attached = a
    ? part(a.name ? `${a.type}; name="${a.name}"` : a.type, a.content, [
        a.name ? `Content-Disposition: attachment; filename="${a.name}"` : 'Content-Disposition: attachment',
        ...(a.base64 ? ['Content-Transfer-Encoding: base64'] : []),
      ])
    : null;
  const message = body && attached ? multipart('mixed', [body, attached]) : (body ?? attached ?? []);

  return Buffer.from(
    [
      'From: Dental Council Office <office@ksdc.example.in>',
      'To: intake@ksdc-register.example',
      `Subject: ${p.subject}`,
      'Message-ID: <fixture@ksdc.example.in>',
      'Date: Thu, 17 Sep 2026 11:05:42 +0530',
      'MIME-Version: 1.0',
      ...message,
    ]
      .join('\n')
      .replace(/\r?\n/g, '\r\n'),
    'utf8',
  );
}

const unwrapMime = async (p: Parts) => unwrapForward(await simpleParser(mime(p)));

/** A token PDF, for the attachments that travel beside a forward. */
const PDF = { type: 'application/pdf', name: 'bill.pdf', content: 'JVBERi0xLjQKJSVFT0YK', base64: true };

/**
 * The complainant's words and nothing else: the body opens with their salutation and
 * holds a line of their letter, and no header row, rule or quote marker survives in it.
 */
function expectLetter(body: string | null, opens: string, holds: string | RegExp): void {
  expect(body?.split('\n')[0]?.trim()).toBe(opens);
  expect(body).toMatch(holds);
  expect(body).not.toMatch(/^[ \t]*(?:From|To|Cc|Sent|Date|Subject)[ \t]*:/im);
  expect(body).not.toMatch(/^[ \t]*(?:-{3,}|={3,}|_{3,})/m);
  expect(body).not.toMatch(/^[ \t]*>/m);
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('a stock Roundcube forward (read from the source, 1.3 to 1.7)', () => {
  // Every stock version draws "-------- Original Message --------" above the header table,
  // in both compose modes. The office's real forward had none (the describe above), so the
  // officer deleted the line or a plugin on the host removed it: both must read.
  //
  // That rule is the shape Outlook desktop draws too, and `kind` names the SHAPE, so a stock
  // Roundcube forward comes out as outlook_desktop.
  const SUBJECT = 'Complaint regarding root canal treatment';
  const ROWS: Array<[string, string]> = [
    ['Subject', SUBJECT],
    ['Date', '2026-09-16 19:12'],
    ['From', 'Anita Rao <anita.rao@example.in>'],
    ['To', 'Registrar Office <registrar.office@example.com>'],
  ];
  const NOTE = 'Please register this complaint.';
  const SEPARATOR = '-------- Original Message --------';
  const LETTER = [
    'Dear Sir/Madam,',
    '',
    'I underwent a root canal treatment at Sample Dental Clinic, Example Nagar, on 2 September 2026. The tooth is still painful and the clinic has refused to see me again.',
    '',
    'I request the Council to look into this.',
    '',
    'Regards,',
    'Anita Rao',
  ];

  /**
   * Roundcube's own text alternative of its HTML: each label upper-cased on a line of its
   * own, the value under it. The indent is two tabs, after a space when TinyMCE has put
   * newlines between the blocks.
   */
  function text(separator: boolean, indent: string): string {
    return [
      ...(separator ? [NOTE, '', SEPARATOR, ''] : []),
      ...ROWS.flatMap(([label, value]) => [`${indent}${label.toUpperCase()}:`, `${indent}${value}`, '']),
      ...LETTER,
    ].join('\n');
  }

  /** The HTML: `tidy` is TinyMCE 5's layout, a newline around every block; otherwise one line. */
  function html(separator: boolean, tidy: boolean): string {
    const blocks = [
      ...(separator
        ? [`<p>${NOTE}</p>`, `<p>${SEPARATOR}</p>`]
        : ['<p><br /></p>', '<div id="signature"></div>']),
      '<table border="0" cellspacing="0" cellpadding="0">',
      '<tbody>',
      ...ROWS.flatMap(([label, value]) => [
        '<tr>',
        `<th align="right" valign="baseline" nowrap="nowrap">${label}:</th>`,
        `<td>${escapeHtml(value)}</td>`,
        '</tr>',
      ]),
      '</tbody>',
      '</table>',
      '<p><br /></p>',
      '<div id="forwardbody1">',
      `<div dir="ltr">${LETTER[0]}`,
      ...LETTER.slice(1).map((l) => `<div>${l || '&nbsp;'}</div>`),
      '</div>',
      '</div>',
    ];
    return [
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8" /></head>' +
        "<body style='font-size: 10pt; font-family: Verdana,Geneva,sans-serif'>",
      blocks.join(tidy ? '\n' : ''),
      '</body></html>',
      '',
    ].join('\n');
  }

  // Plain-text compose, as sent: format=flowed, so the long line is soft-broken and the
  // From: line is space-stuffed (" From:"). mailparser undoes both before we see it.
  const PLAIN = [
    NOTE,
    '',
    '',
    '',
    SEPARATOR,
    `Subject: ${SUBJECT}`,
    'Date: 2026-09-16 19:12',
    ' From: Anita Rao <anita.rao@example.in>',
    'To: Registrar Office <registrar.office@example.com>',
    '',
    'Dear Sir/Madam,',
    '',
    'I underwent a root canal treatment at Sample Dental Clinic, Example ',
    'Nagar, on 2 September 2026. The tooth is still painful and the clinic ',
    'has refused to see me again.',
    '',
    'I request the Council to look into this.',
    '',
    'Regards,',
    'Anita Rao',
    '',
  ].join('\n');

  const CASES: Array<{ mode: string; parts: Omit<Parts, 'subject'>; kind: string }> = [
    {
      mode: 'HTML compose, as stock Roundcube sends it: the rule, then the table',
      parts: { text: text(true, ' \t\t'), html: html(true, true) },
      kind: 'outlook_desktop',
    },
    {
      mode: 'HTML compose with the rule gone, as the office sent it',
      parts: { text: text(false, '\t\t'), html: html(false, false) },
      kind: 'header_block',
    },
    {
      // Not something Roundcube sends: what arrives if a relay drops the text part. Then
      // mailparser's own rendering runs the table into "Subject:XDate:YFrom:Anita\nRao <..."
      // and the parser has to read the HTML instead.
      mode: 'the HTML alone, on one line',
      parts: { html: html(false, false) },
      kind: 'header_block',
    },
    {
      mode: 'the HTML alone, as TinyMCE lays it out',
      parts: { html: html(false, true) },
      kind: 'header_block',
    },
    {
      mode: 'plain-text compose, format=flowed',
      parts: { text: PLAIN, textType: 'text/plain; charset=US-ASCII; format=flowed' },
      kind: 'outlook_desktop',
    },
  ];

  for (const { mode, parts, kind } of CASES) {
    it(`reads ${mode}`, async () => {
      const out = await unwrapMime({ subject: `Fwd: ${SUBJECT}`, ...parts });
      expect(out.kind).toBe(kind);
      expect(out.fromAddress).toBe('anita.rao@example.in');
      expect(out.fromName).toBe('Anita Rao');
      expect(out.subject).toBe(SUBJECT);
      expect(out.dateText).toBe('2026-09-16 19:12');
      expect(out.date).toBeNull();
      expectLetter(out.body, 'Dear Sir/Madam,', /clinic has refused to see me again/);
      expect(out.body).not.toMatch(/register this complaint/);
    });
  }
});

describe('a Zimbra forward (read from the source, 8.8 to 10.1)', () => {
  // HTML compose is Zimbra's default, and the text alternative its browser code writes
  // from the HTML has NO separator: the <hr> over the headers becomes a blank line. Every
  // line ends in a space. The date is "Sent:", in the forwarder's browser time zone and
  // with no zone written.
  const SUBJECT = 'Complaint regarding root canal treatment at Sample Dental Clinic, Udupi';
  const SENT = 'Tuesday, September 15, 2026 7:42:18 PM';
  const NOTE = 'Please register the complaint below and place it before the next scrutiny meeting.';
  const EMAIL = 'ravi.shankar@example.in';
  const ROWS: Array<[string, string]> = [
    ['From', `"Ravi Shankar" <${EMAIL}>`],
    ['To', 'registrar@ksdc.example.in'],
    ['Cc', 'grievance@health.example.in'],
    ['Sent', SENT],
    ['Subject', SUBJECT],
  ];
  const LETTER = [
    'Respected Sir/Madam,',
    '',
    'I underwent root canal treatment on a lower molar at Sample Dental Clinic, Udupi, under Dr. P. Example between 2 and 20 August 2026. The tooth is still painful and the crown has come off twice. The clinic has refused to refund the Rs. 18,000 I paid.',
    '',
    'I request the Council to look into this.',
    '',
    'Regards,',
    'Ravi Shankar',
    'Mobile: XXXXX XXXXX',
  ];

  /** The HTML part, as Zimbra's editor sends it: one line, <b> labels, a marked <hr>. */
  const HTML =
    [
      '<html><body><div style="font-family: arial,helvetica,sans-serif; font-size: 12pt; color: #000000">',
      `<div>${NOTE}</div><div><br></div><div>Registrar</div><div><br></div>`,
      '<hr id="zwchr" data-marker="__DIVIDER__">',
      `<div data-marker="__HEADERS__">${ROWS.map(([l, v]) => `<b>${l}: </b>${escapeHtml(v)}<br>`).join('')}</div><br>`,
      `<div data-marker="__QUOTED_TEXT__"><div dir="ltr">${LETTER[0]}`,
      ...LETTER.slice(1).map((l) => `<div>${l || '<br>'}</div>`),
      `<div>Email: <a href="mailto:${EMAIL}">${EMAIL}</a></div></div><br></div></div></body></html>`,
    ].join('') + '\n';

  /** Zimbra's text alternative of that HTML. */
  const TEXT = [
    `${NOTE} `,
    '',
    'Registrar ',
    '',
    '',
    ...ROWS.map(([l, v]) => `${l}: ${v} `),
    '',
    ...LETTER.map((l) => (l ? `${l} ` : '')),
    `Email: [ mailto:${EMAIL} | ${EMAIL} ] `,
    '',
    '',
  ].join('\n');

  it('reads the default HTML compose, whose text part has no separator at all', async () => {
    const out = await unwrapMime({ subject: `Fwd: ${SUBJECT}`, text: TEXT, html: HTML });
    expect(out.kind).toBe('header_block');
    expect(out.fromAddress).toBe(EMAIL);
    expect(out.fromName).toBe('Ravi Shankar');
    expect(out.subject).toBe(SUBJECT);
    expect(out.dateText).toBe(SENT);
    expectLetter(out.body, 'Respected Sir/Madam,', /crown has come off twice/);
    expect(out.body).not.toMatch(/scrutiny meeting/);
  });

  it('reads the HTML alone, where the <hr> becomes a line of hyphens', async () => {
    const out = await unwrapMime({ subject: `Fwd: ${SUBJECT}`, html: HTML });
    expect(out.kind).toBe('header_block');
    expect(out.fromAddress).toBe(EMAIL);
    expect(out.fromName).toBe('Ravi Shankar');
    expect(out.subject).toBe(SUBJECT);
    expect(out.dateText).toBe(SENT);
    expectLetter(out.body, 'Respected Sir/Madam,', /crown has come off twice/);
  });

  it('reads plain-text compose, under "----- Forwarded Message -----"', async () => {
    // The rule is the same shape as Gmail's, and `kind` names the shape: this is 'gmail'.
    const out = await unwrapMime({
      subject: 'Fwd: Overcharging and rude behaviour at a dental clinic in Hubballi',
      text: [
        'Kindly register this complaint.',
        '',
        '----- Forwarded Message -----',
        'From: "Lakshmi Narayan" <lakshmi.narayan@example.com>',
        'To: "KSDC Registrar" <registrar@ksdc.example.in>',
        'Sent: Monday, September 14, 2026 9:05:11 AM',
        'Subject: Overcharging and rude behaviour at a dental clinic in Hubballi',
        '',
        'Dear Sir,',
        '',
        'On 3 September 2026 I took my mother to Example Dental Clinic, Hubballi,',
        'for an extraction. We were quoted Rs. 1,500 and charged Rs. 6,500. When I',
        'asked for a bill the doctor on duty shouted at us and refused.',
        '',
        'Please take action.',
        '',
        'Lakshmi Narayan',
        'XXXXXXXXXX',
        '',
      ].join('\n'),
    });
    expect(out.kind).toBe('gmail');
    expect(out.fromAddress).toBe('lakshmi.narayan@example.com');
    expect(out.fromName).toBe('Lakshmi Narayan');
    expect(out.subject).toBe('Overcharging and rude behaviour at a dental clinic in Hubballi');
    expect(out.dateText).toBe('Monday, September 14, 2026 9:05:11 AM');
    expectLetter(out.body, 'Dear Sir,', /shouted at us and refused/);
  });

  it('reads a forward as an attachment, which Zimbra always sends for a conversation', async () => {
    const inner = raw(
      {
        Date: 'Tue, 15 Sep 2026 19:42:18 +0530',
        From: `Ravi Shankar <${EMAIL}>`,
        To: 'registrar@ksdc.example.in',
        'Message-ID': '<inner-zimbra@mail.example.in>',
        Subject: SUBJECT,
        'MIME-Version': '1.0',
        'Content-Type': 'text/plain; charset="UTF-8"',
      },
      [
        'Respected Sir/Madam,',
        '',
        'I underwent root canal treatment on a lower molar at Sample Dental Clinic,',
        'Udupi. The tooth is still painful and the crown has come off twice.',
        '',
        'Regards,',
        'Ravi Shankar',
        '',
      ].join('\r\n'),
    );
    const out = await unwrapMime({
      subject: `Fwd: ${SUBJECT}`,
      text: 'Please register the attached complaint. \n',
      html:
        '<html><body><div style="font-family: arial,helvetica,sans-serif; font-size: 12pt; color: #000000">' +
        '<div>Please register the attached complaint.</div></div></body></html>',
      attachment: { type: 'message/rfc822', content: inner.toString('utf8') },
    });
    expect(out.kind).toBe('rfc822_attachment');
    expect(out.fromAddress).toBe(EMAIL);
    expect(out.fromName).toBe('Ravi Shankar');
    expect(out.subject).toBe(SUBJECT);
    // The only route with a real offset: 19:42:18 at +0530 is 14:12:18 UTC.
    expect(out.date?.toISOString()).toBe('2026-09-15T14:12:18.000Z');
    expect(out.dateText).toBeNull();
    expectLetter(out.body, 'Respected Sir/Madam,', /crown has come off twice/);
  });

  it('reads the quote-the-original preference, and unquotes the letter', async () => {
    // Headers and letter both "> "-quoted. Left quoted, the letter would be dropped whole by
    // snippetOf() and the card in the tray would be blank.
    const out = await unwrapMime({
      subject: `Fwd: ${SUBJECT}`,
      text: [
        'Please register the complaint below. ',
        '',
        ...ROWS.map(([l, v]) => `> ${l}: ${v}`),
        '',
        '> Respected Sir/Madam,',
        '',
        '> I underwent root canal treatment on a lower molar at Sample Dental Clinic,',
        '> Udupi, under Dr. P. Example between 2 and 20 August 2026. The tooth is still',
        '> painful and the crown has come off twice. The clinic has refused to refund the',
        '> Rs. 18,000 I paid.',
        '',
        '> I request the Council to look into this.',
        '',
        '> Regards,',
        '> Ravi Shankar',
        '> Mobile: XXXXX XXXXX',
        `> Email: [ mailto:${EMAIL} | ${EMAIL} ]`,
        '',
      ].join('\n'),
    });
    expect(out.kind).toBe('header_block');
    expect(out.fromAddress).toBe(EMAIL);
    expect(out.fromName).toBe('Ravi Shankar');
    expect(out.subject).toBe(SUBJECT);
    expect(out.dateText).toBe(SENT);
    expectLetter(out.body, 'Respected Sir/Madam,', /crown has come off twice/);
    expect(snippetOf(out.body)).toMatch(/^Respected Sir\/Madam, I underwent/);
  });
});

describe('a Horde IMP forward (read from the source, IMP 6.2)', () => {
  // Horde names the sender in the opening rule - "----- Forwarded message from Name <addr>
  // -----" - right-aligns its labels, and closes the forward with "----- End forwarded
  // message -----". Its Date is the original header verbatim, offset and all; it is kept
  // as text anyway, like every other in-body date.
  const SUBJECT =
    'Complaint against Dr. P. Example, Example Dental Clinic, Jayanagar - root canal treatment';
  const LETTER = [
    'Respected Sir/Madam,',
    '',
    'I am writing to register a complaint against Dr. P. Example of Example Dental Clinic, 14th Cross, Jayanagar 4th Block, Bengaluru. I underwent root canal treatment on my lower left molar between 3 August and 24 August 2026 and paid Rs. 18,500 in total.',
    '',
    'Since the final sitting the tooth has been painful and swollen. When I went back on 5 September the clinic refused to see me without a fresh consultation fee.',
    '',
    'I request the Council to look into this matter. Copies of the bills and the X-ray report are available with me.',
    '',
    'Thanking you,',
    'Kavitha Ramesh',
  ];
  const OPENING = '----- Forwarded message from Kavitha Ramesh <kavitha.ramesh@example.in> -----';
  const CLOSING = '----- End forwarded message -----';

  const expectKavitha = (out: ForwardedOriginal) => {
    expect(out.fromAddress).toBe('kavitha.ramesh@example.in');
    expect(out.fromName).toBe('Kavitha Ramesh');
    expect(out.subject).toBe(SUBJECT);
    expectLetter(out.body, 'Respected Sir/Madam,', /available with me\.\n\nThanking you,\nKavitha Ramesh$/);
  };

  it('reads plain-text compose, and stops the letter at "End forwarded message"', async () => {
    // As sent: format=flowed with DelSp=Yes. The long Subject is soft-broken over two lines
    // and the indented labels are space-stuffed; mailparser puts both back.
    const out = await unwrapMime({
      subject: `Fwd: ${SUBJECT}`,
      textType: 'text/plain; charset=UTF-8; format=flowed; DelSp=Yes',
      text: [
        'Forwarding for registration as a complaint.',
        '',
        OPENING,
        '    Date: Mon, 14 Sep 2026 10:12:33 +0530',
        '    From: Kavitha Ramesh <kavitha.ramesh@example.in>',
        'Subject: Complaint against Dr. P. Example, Example Dental Clinic,  ',
        'Jayanagar - root canal treatment',
        '      To: Dental Council Office <office@dentalcouncil.example.in>',
        '',
        'Respected Sir/Madam,',
        '',
        'I am writing to register a complaint against Dr. P. Example of Example  ',
        'Dental Clinic, 14th Cross, Jayanagar 4th Block, Bengaluru. I underwent  ',
        'root canal treatment on my lower left molar between 3 August and 24  ',
        'August 2026 and paid Rs. 18,500 in total.',
        '',
        'Since the final sitting the tooth has been painful and swollen. When I  ',
        'went back on 5 September the clinic refused to see me without a fresh  ',
        'consultation fee.',
        '',
        'I request the Council to look into this matter. Copies of the bills  ',
        'and the X-ray report are available with me.',
        '',
        'Thanking you,',
        'Kavitha Ramesh',
        '',
        CLOSING,
        '',
        '',
      ].join('\n'),
    });
    // The opening rule carries a sender, which no separator shape matches; the header block
    // under it is what is read.
    expect(out.kind).toBe('header_block');
    expect(out.dateText).toBe('Mon, 14 Sep 2026 10:12:33 +0530');
    expect(out.date).toBeNull();
    expectKavitha(out);
    expect(out.body).not.toMatch(/End forwarded message/);
  });

  it('reads HTML compose, whose text part pads the labels with non-breaking spaces', async () => {
    // Horde turns the alignment padding into "&nbsp; &nbsp;" and its own text alternative
    // keeps them as U+00A0 - which [ \t] does not match, so only Subject: was a label.
    const out = await unwrapMime({
      subject: `Fwd: ${SUBJECT}`,
      text: [
        OPENING,
        '\xa0 \xa0Date: Mon, 14 Sep 2026 10:12:33 +0530',
        '\xa0 \xa0From: Kavitha Ramesh <kavitha.ramesh@example.in>',
        `Subject: ${SUBJECT}`,
        '\xa0 \xa0 \xa0To: Dental Council Office <office@dentalcouncil.example.in>',
        '',
        ...LETTER,
        '',
        CLOSING,
        '',
      ].join('\n'),
    });
    expect(out.kind).toBe('header_block');
    expect(out.dateText).toBe('Mon, 14 Sep 2026 10:12:33 +0530');
    expectKavitha(out);
  });

  it('reads the default forward, where the attached original IS the whole message', async () => {
    // Nothing typed, so Horde sends the message/rfc822 part alone: mailparser gives no
    // text at all, only the attachment.
    const inner = raw(
      {
        Date: 'Mon, 14 Sep 2026 10:12:33 +0530',
        'Message-ID': '<inner-horde@mail.example.in>',
        Subject: SUBJECT,
        From: 'Kavitha Ramesh <kavitha.ramesh@example.in>',
        To: 'Dental Council Office <office@dentalcouncil.example.in>',
        'MIME-Version': '1.0',
        'Content-Type': 'text/plain; charset="UTF-8"',
      },
      [...LETTER, ''].join('\r\n'),
    );
    const out = await unwrapMime({
      subject: `Fwd: ${SUBJECT}`,
      attachment: { type: 'message/rfc822', name: 'Forwarded Message', content: inner.toString('utf8') },
    });
    expect(out.kind).toBe('rfc822_attachment');
    expect(out.date?.toISOString()).toBe('2026-09-14T04:42:33.000Z');
    expect(out.dateText).toBeNull();
    expectKavitha(out);
  });
});

describe('a SquirrelMail forward (read from the source, 1.4)', () => {
  // SquirrelMail draws a 74-character "Original Message" rule, left-aligns its labels with
  // the padding after the colon, and closes the header block with a bare rule. It also
  // hard-wraps every line at 76 when it sends - header lines included - so a subject that
  // names a dentist and a clinic spills onto a line with no label. Its subject is
  // "[Fwd: ...]", which the Fwd: gate does not recognise; the rule is what is read.
  const SUBJECT =
    'Complaint against Dr. P. Example, Example Dental Clinic, Jayanagar - root canal treatment';
  const RULE = `${'-'.repeat(28)} Original Message ${'-'.repeat(28)}`;
  const HEADER = [
    'Subject: Complaint against Dr. P. Example, Example Dental Clinic,',
    'Jayanagar - root canal treatment',
    'From:    "Kavitha Ramesh" <kavitha.ramesh@example.in>',
    'Date:    Mon, September 14, 2026 10:12 am',
    'To:      "Dental Council Office" <office@dentalcouncil.example.in>',
  ];

  const expectKavitha = (out: ForwardedOriginal) => {
    expect(out.fromAddress).toBe('kavitha.ramesh@example.in');
    // SquirrelMail double-quotes the display name; the quotes are not part of it.
    expect(out.fromName).toBe('Kavitha Ramesh');
    expect(out.subject).toBe(SUBJECT);
  };

  it('reads an inline forward, joining the wrapped subject and the extra Cc address', async () => {
    const out = await unwrapMime({
      subject: `[Fwd: ${SUBJECT}]`,
      text: [
        'Please register this complaint.',
        RULE,
        ...HEADER,
        'Cc:      "Ramesh Rao" <ramesh.rao@example.com>',
        '         consumer-help@example.com',
        '-'.repeat(74),
        '',
        'Respected Sir/Madam,',
        '',
        'I am writing to register a complaint against Dr. P. Example of Example',
        'Dental Clinic, 14th Cross, Jayanagar 4th Block, Bengaluru. I underwent',
        'root canal treatment on my lower left molar between 3 August and 24 August',
        '2026 and paid Rs. 18,500 in total.',
        '',
        'Since the final sitting the tooth has been painful and swollen. When I',
        'went back on 5 September the clinic refused to see me without a fresh',
        'consultation fee.',
        '',
        'I request the Council to look into this matter. Copies of the bills and',
        'the X-ray report are available with me.',
        '',
        'Thanking you,',
        'Kavitha Ramesh',
        '',
        '',
      ].join('\n'),
    });
    // The "Original Message" shape is Outlook desktop's too, so the kind says so.
    expect(out.kind).toBe('outlook_desktop');
    expectKavitha(out);
    expect(out.dateText).toBe('Mon, September 14, 2026 10:12 am');
    expectLetter(out.body, 'Respected Sir/Madam,', /available with me/);
    expect(out.body).not.toMatch(/consumer-help/);
  });

  it('reads an inline forward of an HTML original that carried a PDF', async () => {
    // SquirrelMail flattens an HTML original with regexes, so the letter arrives with runs
    // of blank lines and entities left undecoded ("doctor&#39;s"). That is what was sent,
    // and it is left as it is.
    const out = await unwrapMime({
      subject: `[Fwd: ${SUBJECT}]`,
      text: [
        '',
        RULE,
        ...HEADER,
        '-'.repeat(74),
        '',
        '',
        'Respected Sir/Madam,',
        '',
        '',
        '',
        '',
        'I am writing to register a complaint against Dr. P. Example of Example',
        'Dental Clinic, Jayanagar. The doctor&#39;s clinic charged me Rs. 18,500',
        'for a root canal that has failed &amp; now needs to be redone.',
        '',
        '',
        '',
        '',
        'The bill is attached.',
        '',
        '',
        '',
        '',
        'Thanking you,',
        '',
        'Kavitha Ramesh',
        '',
        '',
        '',
      ].join('\n'),
      attachment: PDF,
    });
    expect(out.kind).toBe('outlook_desktop');
    expectKavitha(out);
    expect(out.dateText).toBe('Mon, September 14, 2026 10:12 am');
    expectLetter(out.body, 'Respected Sir/Madam,', /The bill is attached\./);
  });

  it('reads "Forward as Attachment", an empty text part beside the original', async () => {
    const inner = raw(
      {
        Date: 'Mon, 14 Sep 2026 10:12:33 +0530',
        'Message-ID': '<inner-squirrel@mail.example.in>',
        Subject: SUBJECT,
        From: 'Kavitha Ramesh <kavitha.ramesh@example.in>',
        To: 'Dental Council Office <office@dentalcouncil.example.in>',
        'MIME-Version': '1.0',
        'Content-Type': 'text/plain; charset="UTF-8"',
      },
      'Respected Sir/Madam,\r\n\r\nI request the Council to look into this matter.\r\n',
    );
    const out = await unwrapMime({
      subject: `Fwd: ${SUBJECT}`,
      text: '',
      attachment: { type: 'message/rfc822', name: `${SUBJECT}.eml`, content: inner.toString('utf8') },
    });
    expect(out.kind).toBe('rfc822_attachment');
    expectKavitha(out);
    expect(out.date?.toISOString()).toBe('2026-09-14T04:42:33.000Z');
    expect(out.dateText).toBeNull();
    expectLetter(out.body, 'Respected Sir/Madam,', /look into this matter/);
  });
});

describe('an Outlook forward (closed source: documented and observed shapes)', () => {
  // Outlook has no single separator. Outlook on the web and mobile put 32 underscores in
  // their text part; classic Outlook for Windows, composing in HTML, puts nothing - the
  // rule is a CSS border - and only its plain-text compose writes "-----Original
  // Message-----". The constant is the block: From, Sent, To, [Cc], Subject.
  const CELL = 'KSDC Complaints Cell <complaints.cell@example.in>';

  /** Classic Outlook's Word HTML, which draws the rule over the headers as a CSS border. */
  const WORD_HTML = [
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns="http://www.w3.org/TR/REC-html40">',
    '<head>',
    '<meta http-equiv="Content-Type" content="text/html; charset=us-ascii">',
    '<meta name="Generator" content="Microsoft Word 15 (filtered medium)">',
    '<style><!--',
    'p.MsoNormal, li.MsoNormal, div.MsoNormal',
    '\t{margin:0cm;',
    '\tfont-size:12.0pt;',
    '\tfont-family:"Aptos",sans-serif;}',
    '--></style><!--[if gte mso 9]><xml>',
    '<o:shapedefaults v:ext="edit" spidmax="1026" />',
    '</xml><![endif]-->',
    '</head>',
    '<body lang="EN-IN" link="#467886" vlink="#96607D" style="word-wrap:break-word">',
    '<div class="WordSection1">',
    '<p class="MsoNormal"><span style="font-size:11.0pt">Forwarded for registration.<o:p></o:p></span></p>',
    '<p class="MsoNormal"><span style="font-size:11.0pt"><o:p>&nbsp;</o:p></span></p>',
    '<div>',
    '<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">',
    '<p class="MsoNormal"><b><span lang="EN-US" style="font-size:11.0pt;font-family:&quot;Calibri&quot;,sans-serif">From:</span></b>' +
      '<span lang="EN-US" style="font-size:11.0pt;font-family:&quot;Calibri&quot;,sans-serif"> Lakshminarayana Chikkaballapur Venkatasubbaiah &lt;lakshminarayana.venkatasubbaiah@example.in&gt;',
    '<br>',
    '<b>Sent:</b> Wednesday, 16 September 2026 19:12<br>',
    '<b>To:</b> KSDC Complaints Cell &lt;complaints.cell@example.in&gt;<br>',
    '<b>Subject:</b> Overcharging for complete dentures<o:p></o:p></span></p>',
    '</div>',
    '</div>',
    '<p class="MsoNormal"><o:p>&nbsp;</o:p></p>',
    '<p class="MsoNormal">Sir,<o:p></o:p></p>',
    '<p class="MsoNormal"><o:p>&nbsp;</o:p></p>',
    '<p class="MsoNormal">I was quoted Rs. 18,000 for complete dentures and charged Rs. 42,000 after the work was done.<o:p></o:p></p>',
    '<p class="MsoNormal"><o:p>&nbsp;</o:p></p>',
    '<p class="MsoNormal">Lakshminarayana C. V.<o:p></o:p></p>',
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');

  const expectLakshminarayana = (out: ForwardedOriginal) => {
    expect(out.kind).toBe('header_block');
    expect(out.fromAddress).toBe('lakshminarayana.venkatasubbaiah@example.in');
    expect(out.fromName).toBe('Lakshminarayana Chikkaballapur Venkatasubbaiah');
    expect(out.subject).toBe('Overcharging for complete dentures');
    expect(out.dateText).toBe('Wednesday, 16 September 2026 19:12');
    expectLetter(out.body, 'Sir,', /charged Rs\. 42,000/);
    expect(out.body).not.toMatch(/Forwarded for registration/);
  };

  it('reads Outlook on the web, HTML only, with a subject wrapped past 80 columns', async () => {
    // 2024 markup: &nbsp; straight after each label, a U+00A0 after "From:". And html-to-text
    // wraps at 80, so the end of the subject lands on a line of its own - which used to be
    // read as the first line of the letter.
    const subject =
      'Complaint against Dr. Harsha Vardhan Example of Example Dental Studio regarding a failed root canal';
    const out = await unwrapMime({
      subject: `Fw: ${subject}`,
      html: [
        '<html>',
        '<head>',
        '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
        '<style type="text/css" style="display:none;"> P {margin-top:0;margin-bottom:0;} </style>',
        '</head>',
        '<body dir="ltr">',
        '<div class="elementToProof" style="font-family: Aptos, Aptos_EmbeddedFont, Aptos_MSFontService, Calibri, Helvetica, sans-serif; font-size: 12pt; color: rgb(0, 0, 0);">',
        'Please register this complaint.</div>',
        '<div id="appendonsend"></div>',
        '<hr style="display: inline-block; width: 98%;">',
        '<div id="divRplyFwdMsg" dir="ltr"><span style="font-family: Calibri, sans-serif; font-size: 11pt; color: rgb(0, 0, 0);"><b>From:</b>&nbsp;Kavya Nagendra &lt;kavya.nagendra@example.in&gt;<br>',
        '<b>Sent:</b>&nbsp;Wednesday, September 16, 2026 7:12 PM<br>',
        '<b>To:</b>&nbsp;KSDC Complaints Cell &lt;complaints.cell@example.in&gt;<br>',
        `<b>Subject:</b>&nbsp;${subject}</span>`,
        '<div>&nbsp;</div>',
        '</div>',
        '<div dir="ltr">',
        '<div>Respected Sir/Madam,</div>',
        '<div><br>',
        '</div>',
        '<div>I had a root canal done on tooth 36 at Example Dental Studio in July 2026. The tooth still hurts and the clinic will not see me again.</div>',
        '<div><br>',
        '</div>',
        '<div>Regards,</div>',
        '<div>Kavya Nagendra</div>',
        '</div>',
        '</body>',
        '</html>',
        '',
      ].join('\n'),
    });
    expect(out.kind).toBe('header_block');
    expect(out.fromAddress).toBe('kavya.nagendra@example.in');
    expect(out.fromName).toBe('Kavya Nagendra');
    expect(out.subject).toBe(subject);
    expect(out.dateText).toBe('Wednesday, September 16, 2026 7:12 PM');
    expectLetter(out.body, 'Respected Sir/Madam,', /will not see me again/);
  });

  it('reads classic Outlook, HTML only, whose From line wraps the address off it', async () => {
    // No rule at all in the text, and the long display name pushes the address onto a line
    // with no label: "From: Lakshminarayana Chikkaballapur Venkatasubbaiah\n<addr>".
    const out = await unwrapMime({ subject: 'FW: Overcharging for complete dentures', html: WORD_HTML });
    expectLakshminarayana(out);
  });

  it('reads classic Outlook HTML beside an attachment, where mailparser writes no text', async () => {
    // An HTML part next to a PDF, with no text part: mailparser 3.9 then sets no .text at
    // all. Only the HTML has the forward in it.
    const out = await unwrapMime({
      subject: 'FW: Overcharging for complete dentures',
      html: WORD_HTML,
      attachment: PDF,
    });
    expectLakshminarayana(out);
  });

  it('reads Outlook on the web, whose text part has the 32 underscores', async () => {
    const out = await unwrapMime({
      subject: 'Fw: Complaint about an extraction at Example Dental Studio',
      text: [
        'Please register this complaint.',
        '',
        '_'.repeat(32),
        'From: Shreya Kulkarni <shreya.k@example.com>',
        'Sent: Monday, September 14, 2026 11:05 AM',
        `To: ${CELL}`,
        'Subject: Complaint about an extraction at Example Dental Studio',
        '',
        'Dear Sir,',
        '',
        'My lower wisdom tooth was extracted on 2 September and the socket is still bleeding. Nobody at the clinic answers the phone.',
        '',
        'Shreya Kulkarni',
        '',
        '',
      ].join('\n'),
    });
    expect(out.kind).toBe('outlook_web');
    expect(out.fromAddress).toBe('shreya.k@example.com');
    expect(out.fromName).toBe('Shreya Kulkarni');
    expect(out.subject).toBe('Complaint about an extraction at Example Dental Studio');
    expect(out.dateText).toBe('Monday, September 14, 2026 11:05 AM');
    expectLetter(out.body, 'Dear Sir,', /socket is still bleeding/);
  });

  it('reads classic Outlook HTML compose, whose text part has no rule and a trailing space', async () => {
    const out = await unwrapMime({
      subject: 'FW: Complaint - orthodontic treatment abandoned midway',
      text: [
        'Forwarded for registration.',
        '',
        'From: Mohammed Irfan <irfan.m@example.in> ',
        'Sent: Tuesday, 15 September 2026 10:41',
        `To: ${CELL}`,
        'Subject: Complaint - orthodontic treatment abandoned midway',
        '',
        'Sir,',
        '',
        'My braces were fitted in January. The orthodontist stopped coming to the clinic in May and the clinic will not refund the fee. Receipt attached.',
        '',
        'Mohammed Irfan',
        '',
        '',
      ].join('\n'),
      attachment: { ...PDF, name: 'Receipt.pdf' },
    });
    expect(out.kind).toBe('header_block');
    expect(out.fromAddress).toBe('irfan.m@example.in');
    expect(out.fromName).toBe('Mohammed Irfan');
    expect(out.subject).toBe('Complaint - orthodontic treatment abandoned midway');
    expect(out.dateText).toBe('Tuesday, 15 September 2026 10:41');
    expectLetter(out.body, 'Sir,', /will not refund the fee/);
  });

  it('reads classic Outlook plain-text compose, under "-----Original Message-----"', async () => {
    const out = await unwrapMime({
      subject: 'FW: Infection after implant surgery',
      text: [
        'Forwarded for registration.',
        '',
        '-----Original Message-----',
        'From: Anitha Gowda <anitha.gowda@example.com> ',
        'Sent: Thursday, 17 September 2026 09:30',
        `To: ${CELL}`,
        'Subject: Infection after implant surgery',
        '',
        'Sir,',
        '',
        'I developed an infection one week after an implant was placed at a clinic in Mysuru. The dentist says it is my fault.',
        '',
        'Anitha Gowda',
        '',
        '',
      ].join('\n'),
    });
    expect(out.kind).toBe('outlook_desktop');
    expect(out.fromAddress).toBe('anitha.gowda@example.com');
    expect(out.fromName).toBe('Anitha Gowda');
    expect(out.subject).toBe('Infection after implant surgery');
    expect(out.dateText).toBe('Thursday, 17 September 2026 09:30');
    expectLetter(out.body, 'Sir,', /says it is my fault/);
  });

  it('reads Outlook for Android, whose signature sits right on top of the rule', async () => {
    const out = await unwrapMime({
      subject: 'Fw: Wrong tooth extracted',
      text: [
        'Sir, one more complaint received today.',
        '',
        'Get Outlook for Android<https://aka.ms/AAb9ysg>',
        '_'.repeat(32),
        'From: Prakash Shetty <prakash.shetty@example.in>',
        'Sent: Tuesday, September 15, 2026 8:09:37 PM',
        `To: ${CELL}`,
        'Subject: Wrong tooth extracted',
        '',
        'Sir,',
        '',
        'The dentist removed my upper left molar instead of the right one on 10 September.',
        '',
        'Prakash Shetty',
        '',
        '',
      ].join('\n'),
    });
    expect(out.kind).toBe('outlook_web');
    expect(out.fromAddress).toBe('prakash.shetty@example.in');
    expect(out.fromName).toBe('Prakash Shetty');
    expect(out.subject).toBe('Wrong tooth extracted');
    expect(out.dateText).toBe('Tuesday, September 15, 2026 8:09:37 PM');
    expectLetter(out.body, 'Sir,', /upper left molar/);
  });
});

describe('a Yahoo Mail forward (closed source: documented text, inferred HTML)', () => {
  // Yahoo's own text part puts the rule and EVERY header on one line, each value glued to
  // the next label - "...<kavya.nair@example.in>To: ...Sent: ...GMT+5:30Subject: ..." - and
  // starts the letter on the next line with a leading space. No line-based reading can
  // take that apart safely. Yahoo always sends the HTML part as well, where each header
  // has a <div> of its own, and that is what gets read.
  const SUBJECT = 'Complaint against Dr. P. Example - failed root canal';
  const SENT = 'Tuesday, September 16, 2026, 07:12:04 PM GMT+5:30';
  const LETTER =
    'I had root canal treatment on a lower left molar at Example Dental Clinic, Jayanagar, on 2 August 2026. The tooth still hurts and the clinic has refused to see me again.';

  const HTML = [
    '<html><head></head><body><div class="ydp5e0d7a41yahoo-style-wrap" style="font-family:Helvetica Neue, Helvetica, Arial, sans-serif;font-size:13px;"><div></div>',
    '        <div dir="ltr" data-setdir="false">Please register the complaint below.</div><div dir="ltr" data-setdir="false">Dental Council Office</div><div><br></div>',
    '        ',
    '        </div><div id="yahoo_quoted_8841052739" class="yahoo_quoted">',
    '            <div style="font-family:\'Helvetica Neue\', Helvetica, Arial, sans-serif;font-size:13px;color:#26282a;">',
    '                ',
    '                <div>',
    '                    ----- Forwarded Message ----- ' +
      '<div>From: Kavya Nair &lt;kavya.nair@example.in&gt;</div>' +
      '<div>To: "dentalcouncil.office@example.in" &lt;dentalcouncil.office@example.in&gt;</div>' +
      '<div>Cc: Arjun Nair &lt;arjun.nair@example.com&gt;</div>' +
      `<div>Sent: ${SENT}</div>` +
      `<div>Subject: ${SUBJECT}</div><div><br></div>`,
    '                </div>',
    '                <div><br></div>',
    '                <div><br></div>',
    '                <div><div id="yiv4417302259"><div><div dir="ltr">Respected Sir/Madam,</div>' +
      `<div dir="ltr">${LETTER}</div><div dir="ltr"><br></div>` +
      '<div dir="ltr">Kindly look into this.</div><div dir="ltr"><br></div><div dir="ltr">Kavya Nair</div></div></div></div>',
    '            </div>',
    '        </div></body></html>',
  ].join('\n');

  const expectKavya = (out: ForwardedOriginal) => {
    // The rule is Gmail's shape, and `kind` names the shape.
    expect(out.kind).toBe('gmail');
    expect(out.fromAddress).toBe('kavya.nair@example.in');
    expect(out.fromName).toBe('Kavya Nair');
    expect(out.subject).toBe(SUBJECT);
    expect(out.dateText).toBe(SENT);
    expectLetter(out.body, 'Respected Sir/Madam,', /refused to\s+see me again/);
    expect(out.body).not.toMatch(/Dental Council Office/);
  };

  it('reads the multipart message Yahoo sends, through its HTML part', async () => {
    const out = await unwrapMime({
      subject: `Fw: ${SUBJECT}`,
      text: [
        'Please register the complaint below.',
        'Dental Council Office',
        '  ----- Forwarded Message ----- From: Kavya Nair <kavya.nair@example.in>' +
          'To: "dentalcouncil.office@example.in" <dentalcouncil.office@example.in>' +
          `Cc: Arjun Nair <arjun.nair@example.com>Sent: ${SENT}Subject: ${SUBJECT}`,
        ' Respected Sir/Madam,',
        LETTER,
        '',
        'Kindly look into this.',
        '',
        'Kavya Nair',
      ].join('\n'),
      html: HTML,
    });
    expectKavya(out);
  });

  it('reads the HTML part alone', async () => {
    expectKavya(await unwrapMime({ subject: `Fw: ${SUBJECT}`, html: HTML }));
  });
});

describe('a Zoho Mail forward (closed source: documented text, inferred HTML)', () => {
  // Zoho's rule is made of "=", written twice - once above the headers and again below
  // them, with the letter straight after the second. It puts a space before each colon
  // ("From : ") and none before the address ("Ramesh Gowda<addr>").
  const SUBJECT =
    'Complaint against Dr. P. Sample, XYZ Dental Clinic, Malleshwaram - ill-fitting complete denture';
  const RULE = '============ Forwarded message ============';
  const HTML =
    [
      '<!DOCTYPE html><html><head><meta content="text/html;charset=UTF-8" http-equiv="Content-Type"></head><body>',
      '<div style="font-family: Verdana, Arial, Helvetica, sans-serif; font-size: 10pt;">',
      '<div>Please register this complaint.<br></div><div><br></div><div>Regards,<br></div><div>Dental Council Office<br></div><div><br></div>',
      '<div class="zmail_extra_hr" style="border-top: 1px solid rgb(204, 204, 204); height: 0px; margin-top: 10px; margin-bottom: 10px; line-height: 0px;"><br></div>',
      '<div class="zmail_extra" data-zmail-z="1"><div><br></div><div id="Zm-_Id_-Sgn1" data-zbluepencil-ignore="true">',
      `<div>${RULE}<br></div>`,
      '<div>From : Ramesh Gowda&lt;<a href="mailto:ramesh.gowda@example.in" target="_blank">ramesh.gowda@example.in</a>&gt;<br></div>',
      '<div>To : &lt;<a href="mailto:office@example.in" target="_blank">office@example.in</a>&gt;<br></div>',
      '<div>Date : Tue, 16 Sep 2026 19:12:04 +0530<br></div>',
      `<div>Subject : ${SUBJECT}<br></div>`,
      `<div>${RULE}<br></div></div><div><br></div>`,
      '<blockquote style="border-left: 1px solid rgb(204, 204, 204); padding-left: 6px; margin: 0px 0px 0px 5px;"><div dir="ltr">',
      '<div>Dear Sir,</div><div><br></div>',
      '<div>I got a complete denture made at XYZ Dental Clinic in June 2026. It does not fit and I cannot eat. The doctor now asks for more money to remake it.</div>',
      '<div><br></div><div>Please take action.</div><div><br></div><div>Ramesh Gowda</div></div></blockquote></div><div><br></div></div><br></body></html>',
    ].join('') + '\n';

  const expectRamesh = (out: ForwardedOriginal) => {
    // No separator shape is made of "=": the header block under it is what is read.
    expect(out.kind).toBe('header_block');
    expect(out.fromAddress).toBe('ramesh.gowda@example.in');
    expect(out.fromName).toBe('Ramesh Gowda');
    expect(out.subject).toBe(SUBJECT);
    expect(out.dateText).toBe('Tue, 16 Sep 2026 19:12:04 +0530');
    expectLetter(out.body, 'Dear Sir,', /asks for more money to remake it/);
    expect(out.body).not.toMatch(/Forwarded message/);
  };

  it('reads the text part, and drops the rule Zoho repeats under the headers', async () => {
    const out = await unwrapMime({
      subject: `Fwd: ${SUBJECT}`,
      text: [
        'Please register this complaint.',
        '',
        'Regards,',
        'Dental Council Office',
        '',
        '',
        '',
        RULE,
        'From : Ramesh Gowda<ramesh.gowda@example.in>',
        'To : <office@example.in>',
        'Date : Tue, 16 Sep 2026 19:12:04 +0530',
        `Subject : ${SUBJECT}`,
        RULE,
        'Dear Sir,',
        '',
        'I got a complete denture made at XYZ Dental Clinic in June 2026. It does not fit and I cannot eat. The doctor now asks for more money to remake it.',
        '',
        'Please take action.',
        '',
        'Ramesh Gowda',
        '',
      ].join('\n'),
      html: HTML,
    });
    expectRamesh(out);
  });

  it('reads the HTML alone: wrapped subject, "Name<addr [addr]>", blockquoted letter', async () => {
    // html-to-text puts a blank line after every header, wraps the subject at 80, renders
    // the mailto link as "addr [addr]" inside Zoho's angle brackets, and quotes the letter.
    expectRamesh(await unwrapMime({ subject: `Fwd: ${SUBJECT}`, html: HTML }));
  });
});

describe('a Rediffmail forward (an UNVERIFIED placeholder)', () => {
  // No sample of a Rediffmail forward could be found and its compose code is served only
  // after login, so this is a guess, not a record: a Gmail-like rule, <b> labels, the
  // original in a blockquote. It is here for the generic things it exercises - a subject
  // wrapped at 80 and a quoted letter in HTML-only mail - and nothing in the parser is
  // keyed to it. A real forward from Rediffmail should replace it.
  it('reads an HTML-only forward with a wrapped subject and a blockquoted letter', async () => {
    const subject =
      'Complaint about Dr. Farida Sample - painful extraction and no follow-up at Sample Dental Care';
    const out = await unwrapMime({
      subject: `Fwd: ${subject}`,
      html: [
        '<html><body><div>Please register this complaint.</div><div>Dental Council Office</div><br><br>',
        '<div>--------- Forwarded message ---------</div>',
        '<div><b>From:</b> "Pooja Shetty" &lt;pooja.shetty@example.in&gt;</div>',
        '<div><b>Date:</b> Tue, 16 Sep 2026 19:12:04 +0530</div>',
        '<div><b>To:</b> office@example.in</div>',
        `<div><b>Subject:</b> ${subject}</div>`,
        '<br>',
        '<blockquote style="border-left:2px solid #1010ff;margin-left:5px;padding-left:5px;"><div>Respected Sir,</div><div><br></div>' +
          '<div>My wisdom tooth was extracted at Sample Dental Care on 20 August 2026. The pain has not stopped and the clinic does not answer my calls.</div>' +
          '<div><br></div><div>Pooja Shetty</div></blockquote>',
        '</body></html>',
        '',
      ].join('\n'),
    });
    expect(out.kind).toBe('gmail');
    expect(out.fromAddress).toBe('pooja.shetty@example.in');
    expect(out.fromName).toBe('Pooja Shetty');
    expect(out.subject).toBe(subject);
    expect(out.dateText).toBe('Tue, 16 Sep 2026 19:12:04 +0530');
    expectLetter(out.body, 'Respected Sir,', /does not answer my calls/);
  });
});

describe('what reading harder must not do', () => {
  it('does not take a header table pasted into a direct HTML message for the sender', async () => {
    // The HTML is read when the text gives no sender, but under the same Fwd: gate: a
    // complainant writing to us directly stays the complainant.
    const out = await unwrapMime({
      subject: 'Complaint against Example Dental Clinic',
      html:
        '<div>Sir, the clinic wrote to me as below and will not refund me.</div>' +
        '<table><tr><th>From:</th><td>Example Dental Clinic &lt;billing@clinic.example.in&gt;</td></tr>' +
        '<tr><th>Date:</th><td>2026-09-10 10:00</td></tr>' +
        '<tr><th>Subject:</th><td>Your bill</td></tr></table>' +
        '<div>Please help. Regards, A. Patient</div>',
    });
    expect(out.kind).toBe('none');
    expect(out.fromAddress).toBeNull();
  });

  it('leaves a letter that starts straight under the Subject line as the letter', async () => {
    // Outlook for Mac writes no blank line under the headers. "Dear Sir," directly under a
    // short subject was not wrapped there by anybody and is not part of it.
    const out = await unwrapMime({
      subject: 'Fwd: Crown came off',
      text: [
        'From: Asha Kumari <asha.k@example.in>',
        'Date: Thursday, 17 September 2026 at 10:02',
        'To: Registrar <registrar@ksdc.in>',
        'Subject: Crown came off',
        'Dear Sir,',
        '',
        'My crown came off a week after it was fitted.',
      ].join('\n'),
    });
    expect(out.subject).toBe('Crown came off');
    expect(out.body).toMatch(/^Dear Sir,\n\nMy crown came off/);
  });

  it('does not take an indented first line of the letter for the end of a long subject', async () => {
    // Yahoo's shape: the letter on the very next line, with a leading space. However long
    // the subject, a wrapper never indents what it carries over.
    const out = await unwrapBody(
      [
        '---------- Forwarded message ---------',
        'From: Kavya Nair <kavya.nair@example.in>',
        'Subject: Complaint against Dr. P. Example of Example Dental Clinic - failed root canal',
        ' Respected Sir/Madam,',
        'The tooth still hurts.',
      ].join('\r\n'),
    );
    expect(out.subject).toBe('Complaint against Dr. P. Example of Example Dental Clinic - failed root canal');
    expect(out.body).toMatch(/^Respected Sir\/Madam,/);
  });

  it('keeps a forward nested at the top of the letter, rule and all', async () => {
    // A rule opening the body is dropped only when nothing but the letter follows it. Here
    // the complainant forwarded the clinic's own email on to us: that is evidence.
    const out = await unwrapBody(
      [
        '---------- Forwarded message ---------',
        'From: Kavitha Devi <kdevi@example.in>',
        'Date: Tue, 16 Sep 2026 at 19:12',
        'Subject: Fwd: Your bill',
        'To: <registrar@ksdc.in>',
        '',
        '---------- Forwarded message ---------',
        'From: Example Dental Clinic <billing@clinic.example.in>',
        'Subject: Your bill',
        '',
        'Rs. 40,000 is due.',
      ].join('\r\n'),
    );
    expect(out.fromAddress).toBe('kdevi@example.in');
    expect(out.body).toMatch(/^-{10} Forwarded message -{9}\nFrom: Example Dental Clinic/);
  });

  it("leaves the letter's own Date:, To: and Subject: lines in the letter, as written", async () => {
    // A letter to the Council routinely opens with labelled lines of its own. Gmail's rows
    // touch, so the blank line under them is where the block ends, however much the lines
    // after it look like headers - and the letter's long Subject: is not "unwrapped" onto
    // the salutation under it.
    const letter = [
      'Date: 12/09/2026',
      'To: The Registrar, Karnataka State Dental Council, Bengaluru',
      'Subject: Complaint regarding the root canal treatment done at Example Dental Clinic, Jayanagar',
      'Respected Sir,',
      'I write about my treatment.',
    ];
    const out = await unwrapBody(
      [
        '---------- Forwarded message ---------',
        'From: Kavitha Devi <kdevi@example.in>',
        'Date: Tue, 16 Sep 2026 at 19:12',
        'Subject: Complaint against Dr Ramesh',
        'To: <registrar@ksdc.in>',
        '',
        ...letter,
      ].join('\r\n'),
    );
    expect(out.fromAddress).toBe('kdevi@example.in');
    expect(out.dateText).toBe('Tue, 16 Sep 2026 at 19:12');
    expect(out.to).toBe('<registrar@ksdc.in>');
    expect(out.subject).toBe('Complaint against Dr Ramesh');
    expect(out.body).toBe(letter.join('\n'));
  });

  it('ends a Roundcube header table at a header it has already read', async () => {
    // Roundcube's rows are apart, so a blank line cannot end its block. But no header comes
    // twice in one block: the letter's own From: and Date: are the letter's, and its "To:"
    // with the addressee under it is not a row to be joined up.
    const letter = [
      'From: L. N. Rao, 12 3rd Cross, Jayanagar, Bengaluru',
      '',
      'Date: 10/09/2026',
      '',
      'To:',
      'The Registrar,',
      'Karnataka State Dental Council',
      '',
      'Respected Sir,',
      '',
      'The bridge fitted in August has come loose twice.',
    ];
    const rows = [
      ['SUBJECT', 'Treatment complaint'],
      ['DATE', '2026-09-16 11:40'],
      ['FROM', 'Lakshmi Narayan Rao <ln.rao1958@example.in>'],
      ['TO', 'registrar@ksdc.in'],
    ];
    const out = await unwrapMime({
      subject: 'Fwd: Treatment complaint',
      text: [...rows.flatMap(([l, v]) => [`\t\t${l}:`, `\t\t${v}`, '']), ...letter].join('\n'),
    });
    expect(out.kind).toBe('header_block');
    expect(out.fromAddress).toBe('ln.rao1958@example.in');
    expect(out.dateText).toBe('2026-09-16 11:40');
    expect(out.to).toBe('registrar@ksdc.in');
    expect(out.body).toBe(letter.join('\n'));
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
