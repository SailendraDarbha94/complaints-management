import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { imageSize } from '../mail/image-size.js';
import type { AttachmentReadResult } from './types.js';

/**
 * One attachment's bytes, made ready to send to the model - or refused, in plain words.
 *
 * The register's tools (register-tools.ts) and the evaluation's (eval-tools.ts) both hand
 * their bytes to this one function, so the two can never disagree about what is readable:
 * a file the evaluation reads is a file the officer's assistant would read too, cut the
 * same way, and a file one refuses the other refuses with the same reason.
 *
 * WHAT IS READABLE is what the Claude API takes: PDFs, and JPEG, PNG, GIF and WebP
 * pictures. (From the register only PDFs, JPEGs and PNGs ever arrive: mail ingest does not
 * keep GIF or WebP files - sniff() in documents/storage.ts - so the playbook and the
 * officer's guide promise only those three.)
 *
 * Decided from the BYTES, never from the filename or the content type the email
 * declared - those are the sender's claims, and a "photo.jpg" that is really an iPhone HEIC
 * would otherwise go to the API and come back as a malformed request, failing the whole
 * suggestion after it had been paid for. Every refusal here is, in the same way, a request
 * that would have failed or cost far more than it was worth, caught while the model can
 * still decide without the file.
 *
 * The reasons are written for the model to pass on to the officer, who is not technical:
 * "an iPhone HEIC photo", not "unsupported media type". They never quote the file.
 */

export const ATTACHMENT_LIMITS = {
  /**
   * The Claude API, called directly, takes a picture of up to 10 MB once base64-encoded
   * (the vision page, checked 12 October 2026), and base64 is four bytes for every three:
   * 7.5 MB of picture is exactly 10 MB on the wire. Through Amazon Bedrock or Google Cloud
   * the limit is 5 MB, so this must come down to 3_900_000 if the engine ever moves there.
   */
  maxImageBytes: 7_500_000,
  /**
   * What is SENT of a PDF - after it has been cut to its first pages. One request may be
   * 32 MB in all; 20 MB of PDF is about 27 MB once encoded, which leaves room for the rest
   * of the conversation, and the engine keeps every file of one email within that too.
   */
  maxPdfBytes: 20_000_000,
  /** The API refuses a picture wider or taller than this, in pixels. */
  maxImageSidePx: 8_000,
  /**
   * The largest PDF this will even open to cut. The register stores nothing larger
   * (MAX_UPLOAD_BYTES in documents/storage.ts), so this only stops a caller handing in
   * something absurd; a scanned bundle up to this size is still cut and sent if its first
   * pages fit within maxPdfBytes.
   */
  maxPdfInputBytes: 50 * 1024 * 1024,
} as const;

type Readable =
  | { kind: 'pdf'; mediaType: 'application/pdf' }
  | { kind: 'image'; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' };

/** Readable, or - for a refusal the officer can act on - what the file looks like. */
type Sniffed = Readable | { kind: 'other'; looksLike: string | null };

const ascii = (b: Buffer, from: number, to: number) => b.toString('latin1', from, to);

/**
 * The file's kind, from its first bytes.
 *
 * The readable kinds by their signatures; then the kinds the Council actually receives
 * and cannot be read, by name, so the refusal says what the file is. A patient
 * photographing a bill on an iPhone is the common case, not an exotic one.
 */
function sniffKind(b: Buffer): Sniffed {
  if (ascii(b, 0, 5) === '%PDF-') return { kind: 'pdf', mediaType: 'application/pdf' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { kind: 'image', mediaType: 'image/jpeg' };
  }
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a &&
      b[6] === 0x1a && b[7] === 0x0a) {
    return { kind: 'image', mediaType: 'image/png' };
  }
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return { kind: 'image', mediaType: 'image/gif' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { kind: 'image', mediaType: 'image/webp' };

  // ISO base media ('ftyp' at offset 4, the brand at 8): what iPhones and many Android
  // phones save photos as.
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) {
      return { kind: 'other', looksLike: 'an iPhone HEIC photo' };
    }
    if (brand === 'avif' || brand === 'avis') return { kind: 'other', looksLike: 'an AVIF photo' };
    return { kind: 'other', looksLike: 'a video or a phone photo in a format that cannot be read' };
  }
  if (ascii(b, 0, 4) === 'II*\u0000' || ascii(b, 0, 4) === 'MM\u0000*') return { kind: 'other', looksLike: 'a TIFF scan' };
  if (ascii(b, 0, 2) === 'BM') return { kind: 'other', looksLike: 'a BMP picture' };
  // A .docx, .xlsx or .pptx is a ZIP archive inside; so is a ZIP sent as such.
  if (ascii(b, 0, 4) === 'PK\u0003\u0004') return { kind: 'other', looksLike: 'a Word, Excel or other Office file, or a ZIP archive' };
  if (b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
    return { kind: 'other', looksLike: 'an old-style Word or Excel file' };
  }
  if (ascii(b, 0, 5) === '{\\rtf') return { kind: 'other', looksLike: 'a Word (RTF) document' };
  return { kind: 'other', looksLike: null };
}

const READABLE_KINDS = 'Only PDFs and JPEG, PNG, GIF or WebP pictures can be read.';

function refuse(reason: string): AttachmentReadResult {
  return { ok: false, reason };
}

/** 7_500_000 -> "7.5 MB". Decimal megabytes, as the limits above are written. */
function mb(bytes: number): string {
  return `${(Math.round(bytes / 100_000) / 10).toFixed(1)} MB`;
}

/**
 * Ready one file for the model, or say why not.
 *
 * A PDF is never sent as it arrived: its first `maxPdfPages` pages - all of them, when it
 * has no more - are copied into a new PDF, and pagesTotal / pagesSent say how many of how
 * many, for the model (which is told what it did not see) and for the officer (who is
 * shown what was sent). See preparePdf for why even a short one is rebuilt. The size limit
 * is judged on what would be SENT, so a long scanned bundle whose first pages are small is
 * still read.
 */
export async function prepareAttachment(
  bytes: Buffer,
  opts: { maxPdfPages: number },
): Promise<AttachmentReadResult> {
  if (bytes.length === 0) return refuse('The file is empty.');
  const kind = sniffKind(bytes);
  if (kind.kind === 'other') {
    return refuse(kind.looksLike ? `This is ${kind.looksLike}. ${READABLE_KINDS}` : `This is not a kind of file that can be read. ${READABLE_KINDS}`);
  }
  if (kind.kind === 'image') return prepareImage(bytes, kind.mediaType);
  return preparePdf(bytes, Math.max(1, Math.floor(opts.maxPdfPages)));
}

function prepareImage(bytes: Buffer, mediaType: Extract<Readable, { kind: 'image' }>['mediaType']): AttachmentReadResult {
  if (bytes.length > ATTACHMENT_LIMITS.maxImageBytes) {
    return refuse(`This picture is ${mb(bytes.length)}; pictures over ${mb(ATTACHMENT_LIMITS.maxImageBytes)} cannot be sent.`);
  }
  // A picture whose header cannot be read would go to the API and fail the whole request
  // as malformed. Refusing the one file lets the model decide without it.
  const size = imageSize(bytes);
  if (!size || size.width < 1 || size.height < 1) {
    return refuse('This picture appears to be damaged: its size cannot be read.');
  }
  const side = ATTACHMENT_LIMITS.maxImageSidePx;
  if (size.width > side || size.height > side) {
    return refuse(`This picture is ${size.width} x ${size.height} pixels; pictures over ${side} pixels on a side cannot be sent.`);
  }
  const clean = stripImageMetadata(bytes, mediaType);
  if (!clean) return refuse('This picture appears to be damaged: its structure cannot be read.');
  return { ok: true, kind: 'image', mediaType, data: clean, pagesTotal: null, pagesSent: null };
}

/**
 * A picture without what the camera wrote about it.
 *
 * A phone photo of a bill or a complaint letter carries EXIF data, and EXIF can hold the
 * GPS position the photo was taken at - often the complainant's home. None of it helps the
 * model read the page, so it never leaves the office: for JPEG the APP1 (EXIF, XMP), APP13
 * (IPTC) and comment segments are dropped; for PNG the eXIf and text chunks. The image data
 * itself is untouched. The cost is EXIF's rotation hint, so a photo taken sideways may
 * arrive sideways; the model reads rotated text well enough, and a location is not worth it.
 *
 * Null when the structure cannot be walked: a file whose metadata cannot be found cannot be
 * shown to be free of it, so it is refused rather than sent as it came.
 * (GIF and WebP are passed as they are: mail intake never stores either, so they cannot
 * reach here from real mail.)
 */
export function stripImageMetadata(b: Buffer, mediaType: string): Buffer | null {
  if (mediaType === 'image/jpeg') return stripJpeg(b);
  if (mediaType === 'image/png') return stripPng(b);
  return b;
}

function stripJpeg(b: Buffer): Buffer | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const keep: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    // Start of scan: the compressed image follows, to the end. Kept whole.
    if (marker === 0xda) {
      keep.push(b.subarray(i));
      return Buffer.concat(keep);
    }
    // Markers that carry no length.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      keep.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const length = b.readUInt16BE(i + 2);
    const end = i + 2 + length;
    if (length < 2 || end > b.length) return null;
    // APP1 (EXIF, XMP), APP13 (IPTC / Photoshop), COM (free text): dropped.
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) keep.push(b.subarray(i, end));
    i = end;
  }
  return null;
}

const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

function stripPng(b: Buffer): Buffer | null {
  if (b.length < 8) return null;
  const keep: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const length = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    const end = i + 12 + length;
    if (end > b.length) return null;
    if (!PNG_METADATA_CHUNKS.has(type)) keep.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(keep);
  }
  return null;
}

/**
 * A PDF's first pages, copied into a new file - ALWAYS, even when it has no more pages
 * than the limit.
 *
 * The officer is shown "letter.pdf (all 2 pages)" as the record of what left the office,
 * and a PDF as it arrived can carry far more than its pages: files embedded in it (a
 * scanner's bundle, a portfolio - another patient's records, as easily as this one's), the
 * earlier revisions an edit leaves behind (text "redacted" by a later save is still in the
 * file), form data, scripts. Copying only the pages leaves all of that behind, so what is
 * sent is what the record names.
 *
 * Copying a page also copies everything it POINTS at, and some things on a page point at
 * other pages: a link to page 20, a form field that appears on every page, a comment's
 * thread. A page cut from the front of a long file would then carry page 20 with it,
 * invisible in the page count but in the bytes. So those pointers are taken off the pages
 * before they are copied (sever), and annotations that carry files of their own are
 * dropped. What a page SHOWS - its contents, and the drawn appearance of a filled-in field
 * or a stamp - is kept.
 *
 * Not covered: a file whose pages share one resource dictionary listing every page's
 * images (some scanners write them so) still carries those images with any page it gives.
 * No page sent draws them, so the model is not shown them, but they are in the bytes; the
 * size limit is judged on those bytes, so they cannot make the file too large to send.
 */
async function preparePdf(bytes: Buffer, maxPages: number): Promise<AttachmentReadResult> {
  if (bytes.length > ATTACHMENT_LIMITS.maxPdfInputBytes) {
    return refuse(`This PDF is ${mb(bytes.length)}, too large to open.`);
  }

  let source: PDFDocument;
  let total: number;
  try {
    // Loaded with ignoreEncryption and then ASKED, rather than left to throw: pdf-lib's
    // EncryptedPDFError is compiled to ES5 and does not survive `instanceof`, so a thrown
    // one is indistinguishable from damage. updateMetadata: false - the source is never
    // saved; the changes sever() makes to it live only in memory, for the copy.
    source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    // pdf-lib cannot decrypt, and copying pages out of an encrypted file would carry
    // their encrypted streams into a new file nobody can read. The API cannot read a
    // password-protected PDF either.
    if (source.isEncrypted) return refuse('This PDF is password-protected or encrypted, so it cannot be read.');
    total = source.getPageCount();
  } catch {
    return refuse('This PDF appears to be damaged and cannot be read.');
  }
  if (total < 1) return refuse('This PDF has no pages.');

  const sent = Math.min(total, maxPages);
  let copy: Uint8Array;
  try {
    const indices = Array.from({ length: sent }, (_, i) => i);
    for (const i of indices) sever(source, i);
    // No metadata of its own (no creation date): the same file prepared twice is the same
    // bytes, which keeps a re-sent conversation identical and the tests exact.
    const out = await PDFDocument.create({ updateMetadata: false });
    const pages = await out.copyPages(source, indices);
    for (const page of pages) out.addPage(page);
    copy = await out.save();
  } catch {
    return refuse('This PDF appears to be damaged and cannot be read.');
  }
  if (copy.length > ATTACHMENT_LIMITS.maxPdfBytes) {
    return refuse(
      sent < total
        ? `This PDF is ${mb(copy.length)} even cut to its first ${sent} pages; at most ` +
            `${mb(ATTACHMENT_LIMITS.maxPdfBytes)} can be sent.`
        : `This PDF is ${mb(copy.length)}; at most ${mb(ATTACHMENT_LIMITS.maxPdfBytes)} can be sent.`,
    );
  }
  return {
    ok: true,
    kind: 'pdf',
    mediaType: 'application/pdf',
    data: Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength),
    pagesTotal: total,
    pagesSent: sent,
  };
}

/**
 * Annotations dropped from a page outright: each carries a file of its own (an attached
 * file, a sound, a film, a 3D model) or draws nothing of the letter and points elsewhere
 * (a link - to another page, which a copy would then carry whole; a comment's pop-up).
 */
const DROPPED_ANNOTATIONS = ['FileAttachment', 'Link', 'Popup', 'Sound', 'Movie', 'Screen', 'RichMedia', '3D'].map(
  (n) => PDFName.of(n),
);

/**
 * What an annotation that is kept may NOT point at: its page (P), the form field it belongs
 * to (Parent - and through the field's other widgets, every page it appears on), its
 * pop-up and the comment it replies to, and the actions and destinations it opens. Its
 * appearance (AP), which is what is drawn, is kept.
 */
const ANNOTATION_POINTERS = ['P', 'Parent', 'Popup', 'IRT', 'A', 'AA', 'Dest', 'FS'].map((n) => PDFName.of(n));

/** A page's own pointers out: the actions it runs, and the article threads (B) through other pages. */
const PAGE_POINTERS = ['AA', 'B'].map((n) => PDFName.of(n));

/** Take off one page of the (in-memory) source what would drag other pages or files into a copy. */
function sever(doc: PDFDocument, index: number): void {
  const page = doc.getPage(index).node;
  for (const key of PAGE_POINTERS) page.delete(key);
  const annots = page.Annots();
  if (!annots) return;
  const subtype = PDFName.of('Subtype');
  const kept = annots.asArray().flatMap((entry) => {
    const annot = doc.context.lookup(entry);
    if (!(annot instanceof PDFDict)) return [];
    const kind = doc.context.lookup(annot.get(subtype));
    if (DROPPED_ANNOTATIONS.some((n) => n === kind)) return [];
    // A shallow copy, so the original - which other pages' fields may still share - is
    // left alone; only the copy, without its pointers, goes on this page.
    const own = annot.clone();
    for (const key of ANNOTATION_POINTERS) own.delete(key);
    return [doc.context.register(own)];
  });
  if (kept.length > 0) page.set(PDFName.of('Annots'), doc.context.obj(kept));
  else page.delete(PDFName.of('Annots'));
}
