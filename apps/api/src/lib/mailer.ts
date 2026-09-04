import nodemailer, { type Transporter } from 'nodemailer';
import {
  env,
  isMailConfigured,
  isProduction,
  isResendConfigured,
  isSmtpConfigured,
} from '../config/env.js';
import { logger } from '../config/logger.js';

export interface Mail {
  /**
   * One address, or several on the same email. Both transports take a list as it stands —
   * nodemailer and Resend each accept a string or an array — so this needs no branching.
   * Everyone named here appears in the To header and can see the others, which is the
   * point for an internal report and would be wrong for anything addressed to a parent.
   */
  to: string | string[];
  subject: string;
  text: string;
  html: string;
  /**
   * Makes a send safe to retry. A Netlify function that times out mid-send may be invoked
   * again with the same work; without this the user receives two reset links, and the
   * second one silently invalidates the first. Resend honours it for 24 hours.
   */
  idempotencyKey?: string;
}

export interface SendResult {
  sent: boolean;
  /** Present when a configured transport actively refused or failed the send. */
  error?: string;
}

const RESEND_ENDPOINT = 'https://api.resend.com';

/** A hung transport must not consume the whole function timeout. */
const TIMEOUT_MS = 8_000;

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
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
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
 *
 * Note this proves credentials are *present*, not that delivery works. Callers that care
 * about the difference should act on the SendResult.
 */
export function canSendMail(): boolean {
  return isMailConfigured;
}

/** True when MAIL_FROM is Resend's shared sender, which reaches only the account owner. */
function usingResendSharedSender(): boolean {
  const domain = senderDomain(env.MAIL_FROM);
  return domain !== null && /(^|\.)resend\.dev$/.test(domain);
}

/**
 * Whether mail can reach an *arbitrary* recipient, as opposed to any recipient at all.
 *
 * The distinction matters for one specific trap: with a valid key but MAIL_FROM left as
 * Resend's shared sender, sending works — for exactly one address, the Resend account
 * owner — and 403s for everyone else. Offering self-service reset in that state would put
 * "check your email" in front of staff who can never receive one.
 *
 * Deliberately offline. Asking Resend to confirm the domain would need a full-access API
 * key, and a send-only key is both the better practice and what this check must tolerate;
 * it would also put a network call on a public, unauthenticated endpoint. A domain that is
 * configured but not actually verified is caught by the send itself, which reports failure
 * and withdraws the token.
 */
export function canReachAnyRecipient(): boolean {
  if (!isMailConfigured) return false;
  if (isResendConfigured && usingResendSharedSender()) return false;
  return true;
}

/**
 * Whether `canReachAnyRecipient()` is the whole story, or a handshake is still needed.
 *
 * For SMTP it is not the whole story: credentials can be fully present and still rejected.
 * Brevo, for instance, issues a login of the form `xxxxxx@smtp-brevo.com` that is neither
 * the account email nor the relay host, and getting it wrong yields `535 Authentication
 * failed` at send time — with nothing observable beforehand. Only the server can say.
 *
 * Resend needs no probe: its single disqualifier is the shared sender, checked offline
 * above, and a send-only key — the kind you should be using — cannot query anything anyway.
 */
export function mailNeedsLiveCheck(): boolean {
  return isSmtpConfigured && !isResendConfigured;
}

/**
 * Sends mail, or logs it when no transport is configured.
 *
 * Resend is preferred over SMTP because it reports per-send failures in a form the caller
 * can act on; `sendPasswordResetLink` uses that to withdraw a token whose email never went
 * out. Never throws: a mail outage must not turn a password-reset request into a 500, and
 * differentiating that response would reveal whether the account exists.
 */
export async function sendMail(mail: Mail): Promise<SendResult> {
  if (isResendConfigured) return sendViaResend(mail);
  if (isSmtpConfigured) return sendViaSmtp(mail);

  if (isProduction) {
    logger.error({ subject: mail.subject }, 'no mail transport configured — email not sent');
  } else {
    // The body carries the reset link, which is exactly what a developer needs.
    const to = Array.isArray(mail.to) ? mail.to.join(', ') : mail.to;
    logger.info(
      `\n--- email (no mail transport configured) ---\nto: ${to}\nsubject: ${mail.subject}\n\n${mail.text}\n---\n`,
    );
  }
  return { sent: false, error: 'no mail transport configured' };
}

async function sendViaResend(mail: Mail): Promise<SendResult> {
  try {
    const response = await fetch(`${RESEND_ENDPOINT}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY as string}`,
        'Content-Type': 'application/json',
        ...(mail.idempotencyKey ? { 'Idempotency-Key': mail.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // Resend answers 403 here when MAIL_FROM is still onboarding@resend.dev and the
      // recipient is not the account owner, which is the most likely misconfiguration.
      const error = await describeResendError(response);
      logger.error(
        { status: response.status, error, subject: mail.subject },
        'Resend refused the send',
      );
      return { sent: false, error };
    }

    // The recipient is not logged: it identifies a person.
    logger.info({ subject: mail.subject }, 'email sent via Resend');
    return { sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, subject: mail.subject }, 'failed to reach Resend');
    return { sent: false, error: message };
  }
}

/** Resend returns `{ name, message }` on error; fall back to the status if it does not. */
async function describeResendError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; name?: string };
    return body.message ?? body.name ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function sendViaSmtp(mail: Mail): Promise<SendResult> {
  try {
    await getTransporter().sendMail({
      from: env.MAIL_FROM,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    logger.info({ subject: mail.subject }, 'email sent via SMTP');
    return { sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, subject: mail.subject }, 'failed to send email');
    return { sent: false, error: message };
  }
}

/** The domain part of a `Name <user@host>` or bare `user@host` address, lowercased. */
export function senderDomain(mailFrom: string): string | null {
  const address = /<([^>]+)>\s*$/.exec(mailFrom)?.[1] ?? mailFrom;
  const domain = address.trim().split('@')[1]?.trim().toLowerCase();
  return domain && domain.length > 0 ? domain : null;
}

interface ResendDomain {
  name: string;
  status: string;
}

/**
 * Verifies that mail can reach an arbitrary recipient — not merely that credentials parse.
 *
 * For Resend that means two things, and the second is the one that bites: a working key is
 * not enough, because Resend refuses any recipient but the account owner unless the `from`
 * address sits on a domain you have verified. Checking only the key would let
 * `/auth/config` advertise self-service reset on a server that can email exactly one
 * person, which is the "check your email" lie this whole flow exists to avoid.
 *
 * Used by the mail:test script and by isPasswordResetByEmailAvailable().
 */
export async function verifyMailConnection(): Promise<void> {
  if (isResendConfigured) {
    const from = senderDomain(env.MAIL_FROM);
    if (!from) throw new Error(`MAIL_FROM is not a usable address: ${env.MAIL_FROM}`);

    if (usingResendSharedSender()) {
      throw new Error(
        "MAIL_FROM is still Resend's shared sender, which only delivers to your own Resend " +
          'account address. Verify a domain at https://resend.com/domains and set MAIL_FROM to ' +
          'an address on it.',
      );
    }

    const response = await fetch(`${RESEND_ENDPOINT}/domains`, {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY as string}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await describeResendError(response);
      // A sending-only key cannot list domains. That is the key you *should* be using, so
      // this is the end of what can be checked without sending — not a failure.
      if (/restricted/i.test(detail)) return;
      throw new Error(`Resend rejected the API key: ${detail}`);
    }

    const body = (await response.json()) as { data?: ResendDomain[] };
    const domains = body.data ?? [];
    const match = domains.find((domain) => domain.name.toLowerCase() === from);

    if (!match) {
      const known = domains.map((domain) => domain.name).join(', ') || 'none';
      throw new Error(`${from} is not a domain on this Resend account (it has: ${known})`);
    }
    if (match.status !== 'verified') {
      throw new Error(
        `${from} is on the account but not verified yet — status is "${match.status}"`,
      );
    }
    return;
  }

  if (isSmtpConfigured) {
    await getTransporter().verify();
    return;
  }

  throw new Error(
    'No mail transport configured — set RESEND_API_KEY, or SMTP_HOST, SMTP_USER and SMTP_PASS',
  );
}
