/**
 * What all the files of ONE email may send together - shared by the engine and the
 * register's file reader, so that both refuse exactly the same files.
 *
 * They must agree. The reader (register-tools.ts) counts a file against the email's read
 * limit, and writes it onto the suggestion as sent, the moment it hands the file over; the
 * engine then decides whether the file goes into the conversation. If the engine refused a
 * file the reader had passed, the reader's count would run one ahead of the engine's - so
 * a later file the engine would have taken is refused - and the row would say a file left
 * the office that never did. So the reader applies this same rule BEFORE it hands a file
 * over, and the engine applies it again as its own floor.
 *
 * No imports, on purpose: the engine must not load pdf-lib (attachment-prep.ts) and the
 * reader must not load the Anthropic SDK (engine.ts), and both need these numbers.
 */

/**
 * Every file one email may send, together, in raw bytes.
 *
 * A request may be 32 MB in all, and every file opened is re-sent with each request that
 * follows it. One PDF may be up to 20 MB (ATTACHMENT_LIMITS.maxPdfBytes) - about 27 MB
 * once encoded - so three of them, all within their own limits, would make a request the
 * API refuses outright (413), failing the suggestion after everything before it was paid
 * for. Kept to one file's worth, so that whatever the model opens, the request still goes.
 * A test keeps it equal to ATTACHMENT_LIMITS.maxPdfBytes.
 */
export const MAX_ATTACHMENT_BYTES_PER_EMAIL = 20_000_000;

/**
 * PDF pages one email may send, together. The API caps the PDF pages one request may
 * carry: 100 when the request's context window is under a million tokens (the PDF-support
 * page, checked 12 October 2026). The defaults, three files of ten pages, stay far below
 * it, so this binds only a configuration that raised MAIL_ASSISTANT_MAX_PDF_PAGES - where
 * going past the API's cap would be a refused request and a failed, paid-for suggestion.
 */
export const MAX_PDF_PAGES_PER_EMAIL = 100;

/** What the files already sent for this email add up to. */
export interface EmailFilesSent {
  bytes: number;
  pdfPages: number;
}

/**
 * Would this file take the email past either budget? 'bytes' or 'pages' if so - each
 * caller words the refusal for whoever reads it - and null if it fits.
 */
export function overEmailBudget(
  sent: EmailFilesSent,
  file: { bytes: number; pdfPages: number | null },
): 'bytes' | 'pages' | null {
  if (sent.bytes + file.bytes > MAX_ATTACHMENT_BYTES_PER_EMAIL) return 'bytes';
  if (sent.pdfPages + (file.pdfPages ?? 0) > MAX_PDF_PAGES_PER_EMAIL) return 'pages';
  return null;
}
