import nodemailer, { type Transporter } from 'nodemailer';
import { env, isMailConfigured, isProduction } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Built lazily and cached per process, so a warm Netlify container reuses the SMTP
 * connection pool instead of renegotiating TLS on every send.
 */
let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 587 uses STARTTLS, which nodemailer negotiates when secure is false.
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER as string, pass: env.SMTP_PASS as string },
    // A hung SMTP handshake must not consume the whole function timeout.
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 8_000,
    pool: true,
    maxConnections: 1,
  });
  return transporter;
}

/**
 * Whether a message can actually be delivered.
 *
 * Exported so callers can decline work whose only output is an email — minting a password
 * reset token nobody will receive, for instance — rather than discovering it downstream.
 */
export function canSendMail(): boolean {
  return isMailConfigured;
}

/**
 * Sends mail, or logs it when SMTP is not configured.
 *
 * Logging rather than throwing is deliberate: it keeps local development and the test
 * suite working without credentials, and a missing SMTP config should not turn a
 * password-reset request into a 500 that reveals the account exists.
 */
export async function sendMail(mail: Mail): Promise<{ sent: boolean }> {
  if (!isMailConfigured) {
    if (isProduction) {
      logger.error({ subject: mail.subject }, 'SMTP is not configured — email not sent');
    } else {
      // The body carries the reset link, which is exactly what a developer needs.
      logger.info(`\n--- email (SMTP not configured) ---\nto: ${mail.to}\nsubject: ${mail.subject}\n\n${mail.text}\n---\n`);
    }
    return { sent: false };
  }

  try {
    await getTransporter().sendMail({
      from: env.MAIL_FROM ?? env.SMTP_USER,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    // The recipient is not logged: it identifies a person.
    logger.info({ subject: mail.subject }, 'email sent');
    return { sent: true };
  } catch (error) {
    logger.error({ err: error, subject: mail.subject }, 'failed to send email');
    return { sent: false };
  }
}

/** Verifies credentials without sending anything. Used by the mail:test script. */
export async function verifyMailConnection(): Promise<void> {
  if (!isMailConfigured) throw new Error('SMTP is not configured — set SMTP_HOST, SMTP_USER and SMTP_PASS');
  await getTransporter().verify();
}
