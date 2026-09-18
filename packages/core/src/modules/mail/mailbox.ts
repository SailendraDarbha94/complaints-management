import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { Logger } from '../../common/logger.js';

/**
 * Reading the watched mailbox.
 *
 * READ-ONLY, and not merely by convention. `mailboxOpen({ readOnly: true })` issues
 * EXAMINE rather than SELECT, which RFC 3501 says must not change any permanent or
 * per-user state, and every body fetch imapflow builds is BODY.PEEK — there is no
 * non-peek code path in the library. So nothing here marks a message read, moves it or
 * deletes it, and the officer's own view of the mailbox is untouched by the software
 * watching it.
 *
 * That matters beyond politeness: the mailbox is the verbatim archival copy of every
 * complaint the Council receives, and this register keeps only the readable content plus a
 * hash. If the reader could alter the mailbox, the hash would be tying the register to
 * something the register itself had changed.
 */

export interface MailboxConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** A Google app password. Shown as four groups; the spaces are not part of it. */
  pass: string;
  mailbox: string;
}

export interface FetchedMessage {
  uid: number;
  uidValidity: string;
  mailbox: string;
  gmMsgId: string | null;
  /** The complete raw source. Never truncated — a partial read gives a useless hash. */
  raw: Buffer;
  parsed: ParsedMail;
}

/** Where the reader had got to. Both halves are needed; see `resumeFrom`. */
export interface MailboxCursor {
  uid: number;
  uidValidity: string;
}

/**
 * The name a mailbox is filed under: the ACCOUNT and the folder, never the folder alone.
 *
 * The read cursor is derived from the highest UID already stored under this name, so the
 * name has to identify the one server-side mailbox those UIDs belong to. Keyed on the
 * folder alone - 'INBOX' - it failed the day the real mailbox was connected: rows stored
 * earlier under 'INBOX' with UIDs up to 1002 made the reader believe it had already read
 * past the real messages at UIDs 9-12, and it fetched nothing. Every Gmail account has an
 * INBOX, so the same thing would silently swallow all the mail of any account the Council
 * moved to later.
 */
export function mailboxKey(config: Pick<MailboxConfig, 'user'>, path: string): string {
  return `${config.user.toLowerCase()}/${path}`;
}

export function mailboxConfigFromEnv(): MailboxConfig | null {
  const user = process.env.MAIL_IMAP_USER;
  const pass = process.env.MAIL_IMAP_PASSWORD;
  if (!user || !pass) return null;
  return {
    host: process.env.MAIL_IMAP_HOST ?? 'imap.gmail.com',
    port: Number(process.env.MAIL_IMAP_PORT ?? 993),
    secure: process.env.MAIL_IMAP_SECURE !== 'false',
    user,
    // Google shows an app password as four space-separated groups. People paste what they
    // are shown, and the spaces are not part of the secret.
    pass: pass.replace(/\s+/g, ''),
    mailbox: process.env.MAIL_IMAP_MAILBOX ?? 'INBOX',
  };
}

export class Mailbox {
  private readonly log = new Logger('mailbox');

  constructor(private readonly config: MailboxConfig) {}

  private client(): ImapFlow {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.pass },
      // imapflow logs every command at info level by default, which on a mailbox of
      // complaints means subject lines in the application log.
      logger: false,
    });
  }

  /**
   * Connect, and confirm the credentials work.
   *
   * Separate from fetching so `pnpm mail:check` can tell the officer whether the app
   * password is right without touching the register at all.
   */
  async check(): Promise<{ ok: true; mailbox: string; messages: number; uidNext: number }> {
    const client = this.client();
    await client.connect();
    try {
      const box = await client.mailboxOpen(this.config.mailbox, { readOnly: true });
      return {
        ok: true,
        mailbox: box.path,
        messages: box.exists,
        uidNext: box.uidNext ?? 0,
      };
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  /**
   * Everything after `cursor`, oldest first.
   *
   * Two things here are easy to get wrong and expensive to get wrong.
   *
   * UIDVALIDITY. When the server changes it, every UID the register stored means something
   * different or nothing at all. Reusing the old cursor then either skips real mail or
   * fetches unrelated messages at those numbers. So the cursor carries the validity with
   * it, and a change resets the scan to the beginning — safe only because the database has
   * real unique constraints on the message identity, not because this code is careful.
   *
   * The `${uid}:*` clamp. When there is nothing new, an IMAP server answers a range whose
   * start is beyond the last UID with the LAST message rather than with nothing. Without
   * the guard below, every idle poll re-ingests the most recent complaint.
   */
  async fetchSince(cursor: MailboxCursor | null): Promise<{
    messages: FetchedMessage[];
    cursor: MailboxCursor;
  }> {
    const client = this.client();
    await client.connect();

    try {
      const box = await client.mailboxOpen(this.config.mailbox, { readOnly: true });
      const uidValidity = String(box.uidValidity);

      const reset = cursor !== null && cursor.uidValidity !== uidValidity;
      if (reset) {
        this.log.warn(
          `UIDVALIDITY changed (${cursor.uidValidity} -> ${uidValidity}); rescanning ` +
            `${this.config.mailbox} from the start. Duplicates are caught by the database.`,
        );
      }
      const startUid = reset || !cursor ? 1 : cursor.uid + 1;

      const messages: FetchedMessage[] = [];
      let highest = reset || !cursor ? 0 : cursor.uid;

      for await (const msg of client.fetch(
        { uid: `${startUid}:*` },
        // `source: true` unqualified. Any maxLength here truncates the bytes and produces
        // a hash that can never match the full-message hash used for deduplication.
        { uid: true, source: true, envelope: true },
        { uid: true },
      )) {
        // The clamp. Without this the newest message comes back on every empty poll.
        if (msg.uid < startUid) continue;
        if (!msg.source) continue;

        messages.push({
          uid: msg.uid,
          uidValidity,
          mailbox: mailboxKey(this.config, box.path),
          gmMsgId: gmailIdOf(msg),
          raw: msg.source,
          // keepCidLinks, or every inline signature logo is inlined as a base64 data URI
          // and a routine email grows by megabytes.
          parsed: await simpleParser(msg.source, { keepCidLinks: true }),
        });
        if (msg.uid > highest) highest = msg.uid;
      }

      return { messages, cursor: { uid: highest, uidValidity } };
    } finally {
      await client.logout().catch(() => client.close());
    }
  }
}

/**
 * Gmail's X-GM-MSGID, when the server offers it.
 *
 * Server-assigned and stable, which makes it the one identifier a sender cannot influence
 * and the best dedupe key available. It is a 64-bit value that imapflow surfaces as a
 * BigInt, and `JSON.stringify` throws on a BigInt — so it is turned into text here, at the
 * boundary, rather than anywhere it might reach a log line or a payload.
 */
function gmailIdOf(msg: FetchMessageObject): string | null {
  const raw = (msg as unknown as { emailId?: unknown; xGmMsgid?: unknown }).xGmMsgid ??
    (msg as unknown as { emailId?: unknown }).emailId;
  if (raw === undefined || raw === null) return null;
  return typeof raw === 'bigint' ? raw.toString() : String(raw);
}
