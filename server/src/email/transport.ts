import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Config } from '../config';
import type { Logger } from '../logger';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  send(message: OutgoingEmail): Promise<{ messageId: string | null }>;
}

/** Split `Name <email@x.com>` into parts (SendGrid wants them separately). */
export function parseAddress(from: string): { name?: string; email: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!match) return { email: from.trim() };
  const name = match[1]?.replace(/^"|"$/g, '').trim();
  return name ? { name, email: match[2]!.trim() } : { email: match[2]!.trim() };
}

async function describeFailure(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return `HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`;
}

export function createMailer(
  config: Config,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): Mailer {
  const { email } = config;
  switch (email.transport) {
    case 'console':
      return {
        async send(message) {
          logger.info(
            `[email] To: ${message.to}\n  Subject: ${message.subject}\n${message.text
              .split('\n')
              .map((l) => `  | ${l}`)
              .join('\n')}`,
          );
          return { messageId: `console-${randomUUID()}` };
        },
      };

    case 'smtp': {
      const transporter = nodemailer.createTransport(email.smtpUrl!);
      return {
        async send(message) {
          const info = await transporter.sendMail({ from: email.from, ...message });
          return { messageId: info.messageId ?? null };
        },
      };
    }

    case 'postmark':
      return {
        async send(message) {
          const res = await fetchImpl('https://api.postmarkapp.com/email', {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'X-Postmark-Server-Token': email.postmarkToken!,
            },
            body: JSON.stringify({
              From: email.from,
              To: message.to,
              Subject: message.subject,
              HtmlBody: message.html,
              TextBody: message.text,
              MessageStream: email.postmarkStream,
              // Link tracking rewrites URLs; keep sign-in and confirm links intact.
              TrackLinks: 'None',
            }),
          });
          if (!res.ok)
            throw new Error(`Postmark rejected the email (${await describeFailure(res)})`);
          const data = (await res.json().catch(() => ({}))) as { MessageID?: string };
          return { messageId: data.MessageID ?? null };
        },
      };

    case 'sendgrid':
      return {
        async send(message) {
          const res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${email.sendgridKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: message.to }] }],
              from: parseAddress(email.from),
              subject: message.subject,
              content: [
                { type: 'text/plain', value: message.text },
                { type: 'text/html', value: message.html },
              ],
              tracking_settings: { click_tracking: { enable: false, enable_text: false } },
            }),
          });
          if (!res.ok)
            throw new Error(`SendGrid rejected the email (${await describeFailure(res)})`);
          return { messageId: res.headers.get('x-message-id') };
        },
      };
  }
}
