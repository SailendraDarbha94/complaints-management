import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { ATTACHMENT_LIMITS, prepareAttachment } from './attachment-prep.js';

/**
 * What the assistant may read of an attachment, decided from the bytes.
 *
 * Real PDFs, made here with pdf-lib, so the cutting is tested on the same library and the
 * same kind of file it will meet; pictures as their real signatures and headers, padded,
 * since nothing here decodes a picture - only its kind and its size are judged.
 */

async function pdf(
  pages: number,
  opts: { pad?: { bytes: number; onPage: number }; encrypted?: boolean } = {},
): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    doc.addPage([595, 842]).drawText(`Page ${i} of ${pages}`, { x: 50, y: 780, size: 12, font });
  }
  if (opts.pad) {
    // Weight carried BY one page (pointed at from its dictionary, as a page's own images
    // are): a copy of that page carries it, a copy without that page does not.
    const weight = doc.context.register(doc.context.stream(new Uint8Array(opts.pad.bytes)));
    doc.getPage(opts.pad.onPage - 1).node.set(PDFName.of('KsdcWeight'), weight);
  }
  if (opts.encrypted) {
    // pdf-lib cannot encrypt, but an /Encrypt entry in the trailer is what marks a file as
    // encrypted - to pdf-lib, to the API, and to every viewer.
    doc.context.trailerInfo.Encrypt = doc.context.register(
      doc.context.obj({ Filter: 'Standard', V: 1, R: 2, P: -44 }),
    );
  }
  return Buffer.from(await doc.save({ useObjectStreams: !opts.encrypted }));
}

async function pageCount(bytes: Buffer): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

/**
 * Every page dictionary in the file, whether or not its page tree lists it - a page dragged
 * in by a pointer is in the bytes sent even though no viewer would show it.
 */
async function pagesInTheBytes(bytes: Buffer): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.context
    .enumerateIndirectObjects()
    .filter(([, o]) => o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Page')).length;
}

/** Bytes that do not compress, so a file that carries them cannot hide it. */
function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 2463534242;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function padded(head: number[] | Buffer, total = 64): Buffer {
  const h = Buffer.isBuffer(head) ? head : Buffer.from(head);
  return Buffer.concat([h, Buffer.alloc(Math.max(0, total - h.length))]);
}

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/**
 * A JPEG with the structure a real one has: SOI, an APP0 segment, any `extra` segments, a
 * start-of-frame that carries the size, a start-of-scan, scan data padding it out to
 * `total` bytes, and EOI. Whole, because the metadata stripper walks it segment by segment.
 */
function jpeg(width = 1200, height = 1600, total = 64, extra: number[] = []): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const sos = [0xff, 0xda, 0x00, 0x0c, 0x03, 1, 0x00, 2, 0x11, 3, 0x11, 0x00, 0x3f, 0x00];
  const head = Buffer.from([0xff, 0xd8, ...app0, ...extra, ...sof0, ...sos]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, total - head.length - eoi.length), 0x11), eoi]);
}

/** One PNG chunk: length, type, data, and a CRC the stripper does not check. */
function chunk(type: string, data: number[] | Buffer): Buffer {
  const d = Buffer.from(data);
  return Buffer.concat([Buffer.from(be32(d.length)), Buffer.from(type, 'latin1'), d, Buffer.alloc(4)]);
}

/** A whole PNG - signature, IHDR, any `extra` chunks, IDAT padding it to `total`, IEND. */
function png(width = 800, height = 600, total = 64, extra: Buffer[] = []): Buffer {
  const sig = Buffer.from([0x89, ...Buffer.from('PNG\r\n'), 0x1a, 0x0a]);
  const ihdr = chunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]);
  const iend = chunk('IEND', []);
  const fixed = sig.length + ihdr.length + extra.reduce((n, c) => n + c.length, 0) + iend.length + 12;
  return Buffer.concat([sig, ihdr, ...extra, chunk('IDAT', Buffer.alloc(Math.max(0, total - fixed), 0x22)), iend]);
}

function gif(version: '87a' | '89a' = '89a', width = 320, height = 240): Buffer {
  return padded([...Buffer.from(`GIF${version}`), ...le16(width), ...le16(height), 0xf7, 0, 0]);
}

function webp(width = 1000, height = 750): Buffer {
  return padded([
    ...Buffer.from('RIFF'), 0x40, 0, 0, 0, ...Buffer.from('WEBP'), ...Buffer.from('VP8X'),
    10, 0, 0, 0, 0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1),
  ]);
}

describe('a PDF', () => {
  it('of at most the allowed pages is sent whole - every page, copied into a new file', async () => {
    const r = await prepareAttachment(await pdf(3), { maxPdfPages: 10 });
    expect(r).toMatchObject({ ok: true, kind: 'pdf', mediaType: 'application/pdf', pagesTotal: 3, pagesSent: 3 });
    expect(r.ok && (await pageCount(r.data))).toBe(3);
  });

  it('leaves behind a file embedded in it: only the pages named on the record are sent', async () => {
    // A two-page letter carrying, inside the PDF, a 200 KB attachment of its own - a
    // scanner's bundle, or another patient's records. The officer is told "all 2 pages".
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([595, 842]);
    doc.addPage([595, 842]);
    await doc.attach(noise(200_000), 'another-patient.pdf', { mimeType: 'application/pdf' });
    const bytes = Buffer.from(await doc.save());
    expect(bytes.length).toBeGreaterThan(200_000);

    const r = await prepareAttachment(bytes, { maxPdfPages: 10 });
    expect(r).toMatchObject({ ok: true, pagesTotal: 2, pagesSent: 2 });
    if (!r.ok) return;
    expect(r.data.length).toBeLessThan(20_000);
    expect((await PDFDocument.load(r.data)).catalog.get(PDFName.of('Names'))).toBeUndefined();
  });

  it('does not let a link, a form field or an attached-file note drag other pages or files in', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < 12; i++) doc.addPage([595, 842]);
    const [first, last] = [doc.getPage(0), doc.getPage(11)];
    const c = doc.context;
    // A link on page 1 to page 12 - a contents page, say.
    const link = c.register(c.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], Dest: [last.ref, 'Fit'] }));
    // A form field shown on page 1 AND on page 12: page 1's widget reaches page 12's
    // through the field they share.
    const field = c.register(c.obj({ FT: 'Tx', T: PDFString.of('name') }));
    const appearance = c.register(c.stream('0 0 m', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
    const widgetHere = c.register(
      c.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 10, 10], P: first.ref, Parent: field, AP: { N: appearance } }),
    );
    const widgetThere = c.register(c.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 10, 10], P: last.ref, Parent: field }));
    c.lookup(field, PDFDict).set(PDFName.of('Kids'), c.obj([widgetHere, widgetThere]));
    // A note with a 100 KB file attached to it.
    const embedded = c.register(c.stream(noise(100_000), { Type: 'EmbeddedFile' }));
    const note = c.register(
      c.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [0, 0, 10, 10], FS: { Type: 'Filespec', F: PDFString.of('x.pdf'), EF: { F: embedded } } }),
    );
    first.node.set(PDFName.of('Annots'), c.obj([link, widgetHere, note]));
    last.node.set(PDFName.of('Annots'), c.obj([widgetThere]));
    const bytes = Buffer.from(await doc.save());

    const r = await prepareAttachment(bytes, { maxPdfPages: 10 });
    expect(r).toMatchObject({ ok: true, pagesTotal: 12, pagesSent: 10 });
    if (!r.ok) return;
    // Ten pages in the bytes, not eleven: page 12 did not come along.
    expect(await pagesInTheBytes(r.data)).toBe(10);
    expect(r.data.length).toBeLessThan(20_000);
    // What page 1 shows is kept - the filled-in field, as drawn - without its pointers.
    const out = await PDFDocument.load(r.data);
    const annots = out.getPage(0).node.Annots() as PDFArray;
    expect(annots.size()).toBe(1);
    const kept = out.context.lookup(annots.get(0), PDFDict);
    expect(kept.get(PDFName.of('Subtype'))).toBe(PDFName.of('Widget'));
    expect(kept.get(PDFName.of('AP'))).toBeDefined();
    expect(kept.get(PDFName.of('P'))).toBeUndefined();
    expect(kept.get(PDFName.of('Parent'))).toBeUndefined();
  });

  it('of exactly the allowed pages is not cut', async () => {
    const r = await prepareAttachment(await pdf(10), { maxPdfPages: 10 });
    expect(r).toMatchObject({ ok: true, pagesTotal: 10, pagesSent: 10 });
  });

  it('that is longer is cut to its first pages, and says how many of how many', async () => {
    const r = await prepareAttachment(await pdf(23), { maxPdfPages: 10 });
    expect(r).toMatchObject({ ok: true, kind: 'pdf', pagesTotal: 23, pagesSent: 10 });
    if (!r.ok) return;
    expect(await pageCount(r.data)).toBe(10);
    // The FIRST pages - the letter, not the tail of the enclosures.
    expect(r.data.toString('latin1')).not.toContain('Page 11 of 23');
  });

  it('is cut the same way every time', async () => {
    const bytes = await pdf(5);
    const a = await prepareAttachment(bytes, { maxPdfPages: 2 });
    const b = await prepareAttachment(bytes, { maxPdfPages: 2 });
    expect(a.ok && b.ok && a.data.equals(b.data)).toBe(true);
  });

  it('treats a page limit below one as one', async () => {
    const r = await prepareAttachment(await pdf(4), { maxPdfPages: 0 });
    expect(r).toMatchObject({ ok: true, pagesTotal: 4, pagesSent: 1 });
  });

  it('that is encrypted is refused, in plain words', async () => {
    const r = await prepareAttachment(await pdf(2, { encrypted: true }), { maxPdfPages: 10 });
    expect(r).toEqual({ ok: false, reason: 'This PDF is password-protected or encrypted, so it cannot be read.' });
  });

  it('that is damaged is refused', async () => {
    const garbage = Buffer.from(`%PDF-1.7\n${'this is not a pdf at all '.repeat(40)}`);
    const r = await prepareAttachment(garbage, { maxPdfPages: 10 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/damaged|no pages/);
  });

  it('too large to send whole is refused - but read when its first pages are small enough', async () => {
    const over = ATTACHMENT_LIMITS.maxPdfBytes + 1_000_000;
    const one = await prepareAttachment(await pdf(1, { pad: { bytes: over, onPage: 1 } }), { maxPdfPages: 10 });
    expect(one).toMatchObject({ ok: false });
    expect(!one.ok && one.reason).toMatch(/^This PDF is 21\.\d MB; at most 20\.0 MB can be sent\.$/);

    // The same weight in a long file, on a page after the ones kept: cut, it is small.
    const long = await prepareAttachment(await pdf(12, { pad: { bytes: over, onPage: 12 } }), { maxPdfPages: 10 });
    expect(long).toMatchObject({ ok: true, pagesTotal: 12, pagesSent: 10 });
    expect(long.ok && long.data.length).toBeLessThan(1_000_000);

    // And on a page that IS kept, the cut file is still too large, and says so.
    const early = await prepareAttachment(await pdf(12, { pad: { bytes: over, onPage: 2 } }), { maxPdfPages: 10 });
    expect(!early.ok && early.reason).toMatch(/^This PDF is 21\.\d MB even cut to its first 10 pages; at most 20\.0 MB can be sent\.$/);
  });
});

describe('a picture', () => {
  it.each([
    ['JPEG', jpeg(), 'image/jpeg'],
    ['PNG', png(), 'image/png'],
    ['GIF87a', gif('87a'), 'image/gif'],
    ['GIF89a', gif('89a'), 'image/gif'],
    ['WebP', webp(), 'image/webp'],
  ])('%s is recognised by its bytes and sent as it came', async (_name, bytes, mediaType) => {
    const r = await prepareAttachment(bytes, { maxPdfPages: 10 });
    expect(r).toEqual({ ok: true, kind: 'image', mediaType, data: bytes, pagesTotal: null, pagesSent: null });
  });

  it('is judged by its bytes, not by what it claims - there is no name to claim with', async () => {
    // A ".pdf" that is really a PNG is a PNG; prepareAttachment never sees the filename.
    expect(await prepareAttachment(png(), { maxPdfPages: 10 })).toMatchObject({ ok: true, kind: 'image' });
  });

  it('over the size limit is refused', async () => {
    const big = jpeg(1200, 1600, ATTACHMENT_LIMITS.maxImageBytes + 1);
    const r = await prepareAttachment(big, { maxPdfPages: 10 });
    expect(r).toEqual({ ok: false, reason: 'This picture is 7.5 MB; pictures over 7.5 MB cannot be sent.' });
    // At the limit exactly, it goes.
    expect(await prepareAttachment(jpeg(1200, 1600, ATTACHMENT_LIMITS.maxImageBytes), { maxPdfPages: 10 })).toMatchObject({ ok: true });
  });

  it('wider or taller than the API takes is refused', async () => {
    const r = await prepareAttachment(png(9000, 3000), { maxPdfPages: 10 });
    expect(r).toEqual({ ok: false, reason: 'This picture is 9000 x 3000 pixels; pictures over 8000 pixels on a side cannot be sent.' });
  });

  it('leaves without its EXIF - a phone photo can say where it was taken', async () => {
    // APP1 "Exif" with a GPS position in it, a comment, and an IPTC segment: all dropped.
    const text = (s: string) => [...Buffer.from(s, 'latin1')];
    const seg = (marker: number, body: number[]) => [0xff, marker, ...be16(body.length + 2), ...body];
    const photo = jpeg(1200, 1600, 400, [
      ...seg(0xe1, text('Exif\0\0GPSLatitude 12.9716N GPSLongitude 77.5946E')),
      ...seg(0xfe, text('taken at home')),
      ...seg(0xed, text('Photoshop 3.0\0IPTC')),
    ]);
    const r = await prepareAttachment(photo, { maxPdfPages: 10 });
    expect(r).toMatchObject({ ok: true, kind: 'image', mediaType: 'image/jpeg' });
    const sent = r.ok ? r.data.toString('latin1') : '';
    expect(sent).not.toMatch(/GPS|Exif|taken at home|IPTC/);
    // Still a JPEG with its frame and its picture: only the metadata went.
    expect(r.ok && r.data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(r.ok && r.data.equals(jpeg(1200, 1600, 400 - (photo.length - (r.ok ? r.data.length : 0))))).toBe(true);
  });

  it('leaves without its PNG text and EXIF chunks', async () => {
    const photo = png(800, 600, 300, [
      chunk('eXIf', Buffer.from('GPSLatitude 12.9716N', 'latin1')),
      chunk('tEXt', Buffer.from('Comment\0taken at home', 'latin1')),
    ]);
    const r = await prepareAttachment(photo, { maxPdfPages: 10 });
    expect(r).toMatchObject({ ok: true, mediaType: 'image/png' });
    expect(r.ok ? r.data.toString('latin1') : '').not.toMatch(/GPS|taken at home|eXIf|tEXt/);
    expect(r.ok ? r.data.toString('latin1') : '').toMatch(/IHDR[\s\S]*IDAT[\s\S]*IEND/);
  });

  it('whose structure cannot be walked is refused, not sent with whatever it carries', async () => {
    // A readable size but no start-of-scan: its metadata cannot be shown to be gone.
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, ...be16(100), ...be16(100), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    const r = await prepareAttachment(padded([0xff, 0xd8, ...app0, ...sof0], 64), { maxPdfPages: 10 });
    expect(r).toEqual({ ok: false, reason: 'This picture appears to be damaged: its structure cannot be read.' });
  });

  it('whose size cannot be read is refused rather than sent to fail the request', async () => {
    // A JPEG signature and then nothing a reader can follow.
    const r = await prepareAttachment(padded([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]), { maxPdfPages: 10 });
    expect(r).toEqual({ ok: false, reason: 'This picture appears to be damaged: its size cannot be read.' });
  });
});

describe('anything else', () => {
  const ftyp = (brand: string) => padded([0, 0, 0, 0x18, ...Buffer.from('ftyp'), ...Buffer.from(brand)]);

  it.each([
    ['an iPhone HEIC photo', ftyp('heic')],
    ['an iPhone HEIC photo', ftyp('mif1')],
    ['a TIFF scan', padded([...Buffer.from('II*'), 0])],
    ['a TIFF scan', padded([...Buffer.from('MM'), 0, 0x2a])],
    ['a BMP picture', padded(Buffer.from('BM'))],
    ['a Word, Excel or other Office file, or a ZIP archive', padded([...Buffer.from('PK'), 3, 4])],
    ['an old-style Word or Excel file', padded([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
  ])('is refused, naming what it looks like: %s', async (looksLike, bytes) => {
    const r = await prepareAttachment(bytes, { maxPdfPages: 10 });
    expect(r).toEqual({
      ok: false,
      reason: `This is ${looksLike}. Only PDFs and JPEG, PNG, GIF or WebP pictures can be read.`,
    });
  });

  it('that cannot be named is refused all the same', async () => {
    const r = await prepareAttachment(Buffer.from('Dear Sir, please find my complaint below.'), { maxPdfPages: 10 });
    expect(r).toEqual({
      ok: false,
      reason: 'This is not a kind of file that can be read. Only PDFs and JPEG, PNG, GIF or WebP pictures can be read.',
    });
  });

  it('that is empty says so', async () => {
    expect(await prepareAttachment(Buffer.alloc(0), { maxPdfPages: 10 })).toEqual({ ok: false, reason: 'The file is empty.' });
  });
});
