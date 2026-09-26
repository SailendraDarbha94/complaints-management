import { simpleParser, type ParsedMail } from 'mailparser';

/**
 * Parse a raw email the one way this module parses email - the mailbox, the unwrapper and
 * the attachment stager must all see the same structure.
 *
 * keepCidLinks: or every inline signature logo is inlined as a base64 data URI and a
 * routine email grows by megabytes.
 *
 * ignoreEmbedded: an email attached to another arrives as a message/rfc822 part, and when
 * that part is marked inline mailparser, by default, dissolves it into its parent - lifting
 * the attached email's files up among the parent's own. Two complaints forwarded together
 * then looked like one message carrying both patients' bills, and both were filed on the
 * first complainant's case. With this, an attached email always stays an attachment, and
 * the stager decides whose files are whose (see MailIntakeService.stageFrom).
 */
export function parseMessage(raw: Buffer): Promise<ParsedMail> {
  return simpleParser(raw, { keepCidLinks: true, ignoreEmbedded: true } as Parameters<typeof simpleParser>[1]);
}
