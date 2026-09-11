import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Logger } from '../../common/logger.js';

/**
 * Outbound transactional mail: sign-in codes and the daily digest.
 *
 * This is NOT the council's correspondence. Letters to complainants and dentists are
 * drafted by the software and sent by the officer from council webmail (build plan §6);
 * switching that to real SMTP is a Phase 6 decision behind its own gate. What goes
 * through here is mail from the system to the people who operate it.
 *
 * Two transports, chosen by MAIL_TRANSPORT:
 *   console  writes to the log and to var/mail/outbox.log. The default, and the reason
 *            sign-in works locally with no credentials at all.
 *   smtp     nodemailer, for staging and production.
 */

export interface OutboundMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendResult {
  transport: 'console' | 'smtp';
  messageId: string;
}

export abstract class MailerPort {
  abstract send(message: OutboundMessage): Promise<SendResult>;
}

/**
 * Addresses this system must never write to.
 *
 * registrar@ksdc.in is where complaints arrive. It is the pile the officer is escaping,
 * and adding system mail to it would make the product part of the problem it exists to
 * solve. support@ksdc.in forwards into the same place.
 *
 * Held as a guard in code rather than as a note in the runbook, because a note does not
 * stop a config change at 11pm.
 */
const NEVER_SEND_TO = [/^registrar@/i, /^support@/i, /^info@/i, /^office@/i];

export function assertSendable(to: string): void {
  const address = to.trim().toLowerCase();
  if (!address.includes('@')) {
    throw new Error(`"${to}" is not an email address.`);
  }
  if (NEVER_SEND_TO.some((re) => re.test(address))) {
    throw new Error(
      `Refusing to send system mail to ${to}. Shared council inboxes are where complaints ` +
        'arrive; system mail goes to a person, not to the pile they are digging out of. ' +
        'See packages/core/src/modules/notifications/mailer.ts.',
    );
  }
}

export function mailFrom(): string {
  // Deliberately not an @ksdc.in address by default. Sending as the council needs either
  // mailbox API access or SPF/DKIM records nobody has arranged yet, and a system that
  // quietly forges the council's identity is worse than one that is obviously a robot.
  return process.env.MAIL_FROM ?? 'KSDC Complaints Register <no-reply@localhost>';
}

export class ConsoleMailer extends MailerPort {
  private readonly log = new Logger('mailer:console');
  private readonly outbox = process.env.MAIL_OUTBOX ?? join(process.cwd(), 'var', 'mail', 'outbox.log');

  async send(message: OutboundMessage): Promise<SendResult> {
    assertSendable(message.to);
    const messageId = crypto.randomUUID();

    const record =
      `\n${'='.repeat(78)}\n` +
      `id:      ${messageId}\n` +
      `from:    ${mailFrom()}\n` +
      `to:      ${message.to}\n` +
      `subject: ${message.subject}\n` +
      `${'-'.repeat(78)}\n${message.text}\n`;

    await mkdir(dirname(this.outbox), { recursive: true });
    await appendFile(this.outbox, record, 'utf8');

    // Printed in full so a sign-in code is usable in development without a mail server.
    this.log.log(`to ${message.to} — ${message.subject}\n${message.text}`);
    return { transport: 'console', messageId };
  }
}

export class SmtpMailer extends MailerPort {
  private readonly log = new Logger('mailer:smtp');
  private transporter: import('nodemailer').Transporter | undefined;

  private async transport() {
    if (this.transporter) return this.transporter;
    const nodemailer = await import('nodemailer');
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
    if (!SMTP_HOST) throw new Error('MAIL_TRANSPORT=smtp but SMTP_HOST is not set');

    this.transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT ?? 587),
      secure: Number(SMTP_PORT ?? 587) === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined,
    });
    return this.transporter;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    assertSendable(message.to);
    const transporter = await this.transport();
    const info = await transporter.sendMail({
      from: mailFrom(),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    this.log.log(`sent to ${message.to} — ${message.subject}`);
    return { transport: 'smtp', messageId: info.messageId };
  }
}

export function mailerProvider() {
  return {
    provide: MailerPort,
    useClass: process.env.MAIL_TRANSPORT === 'smtp' ? SmtpMailer : ConsoleMailer,
  };
}
