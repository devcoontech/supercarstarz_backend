import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../core/config.js';
import { getSecret, getSettings } from '../core/settings.js';

export type Attachment = { filename: string; content: string; contentType: string };
/** An image shown inside the HTML body (referenced as <img src="cid:...">), not offered as a download. */
export type InlineImage = { cid: string; filename: string; content: Buffer; contentType: string };
/** `text` is always sent (plain-text clients, previews, tests); `html` is the branded version when there is one. */
export type Mail = { to: string; subject: string; text: string; html?: string; attachments?: Attachment[]; inline?: InlineImage[] };
export type SendResult = { sent: boolean; reason?: string };
export interface Mailer {
  send(mail: Mail): Promise<SendResult>;
}

/*
 * Outgoing email. The connection is configured in Admin > Settings > Email (host, port, security, user, password,
 * from address); the SMTP_URL environment variable is only a fallback. Any SMTP provider works (Brevo, Amazon SES,
 * Mailgun, Postmark, Resend, Google Workspace, your own server...).
 */

type Resolved =
  | { kind: 'settings'; host: string; port: number; secure: boolean; user: string; pass: string; from: string }
  | { kind: 'url'; url: string; from: string };

const fromHeader = (name: string, address: string) => (address ? (name ? `"${name.replace(/"/g, '')}" <${address}>` : address) : config.mailFrom);

export async function resolveSmtp(): Promise<Resolved | null> {
  const s = await getSettings();
  if (s['email.host'].trim()) {
    return {
      kind: 'settings', host: s['email.host'].trim(), port: s['email.port'], secure: s['email.secure'],
      user: s['email.user'].trim(), pass: await getSecret('email.password'), from: fromHeader(s['email.fromName'], s['email.fromAddress'].trim()),
    };
  }
  if (config.smtpUrl) return { kind: 'url', url: config.smtpUrl, from: config.mailFrom };
  return null;
}

let cached: { key: string; transport: Transporter } | null = null;
function transportFor(r: Resolved): Transporter {
  const key = JSON.stringify(r);
  if (cached?.key === key) return cached.transport;
  cached?.transport.close();
  const transport = r.kind === 'url'
    ? nodemailer.createTransport(r.url)
    : nodemailer.createTransport({
        host: r.host, port: r.port, secure: r.secure, auth: r.user ? { user: r.user, pass: r.pass } : undefined,
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      });
  cached = { key, transport };
  return transport;
}

/** Errors are shown to staff, so keep them readable and never include the password. */
const cleanError = (e: unknown) => String((e as Error)?.message ?? e).replace(/pass(word)?[=:]\S+/gi, 'password=***').slice(0, 300);

let override: Mailer | null = null;
/** For tests: capture outgoing mail instead of sending it. */
export const setMailer = (m: Mailer | null) => {
  override = m;
};

export async function sendMail(m: Mail): Promise<SendResult> {
  if (override) return override.send(m);
  const r = await resolveSmtp();
  if (!r) {
    // No provider: never report success. In development the message is printed so codes can still be used.
    if (config.env !== 'production') console.log(`[mail not sent: no email provider configured] to=${m.to} subject="${m.subject}"\n${m.text}`);
    return { sent: false, reason: 'no_mail_provider_configured' };
  }
  try {
    await transportFor(r).sendMail({
      from: r.from, to: m.to, subject: m.subject, text: m.text, html: m.html,
      attachments: [...(m.attachments ?? []), ...(m.html ? (m.inline ?? []).map((i) => ({ ...i, contentDisposition: 'inline' as const })) : [])],
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: cleanError(e) };
  }
}

/** Opens a connection and authenticates without sending anything. Used by the "Test connection" button. */
export async function verifySmtp(): Promise<SendResult> {
  const r = await resolveSmtp();
  if (!r) return { sent: false, reason: 'no_mail_provider_configured' };
  try {
    await transportFor(r).verify();
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: cleanError(e) };
  }
}

/** Same call shape the rest of the code already uses. */
export const getMailer = (): Mailer => ({ send: sendMail });
