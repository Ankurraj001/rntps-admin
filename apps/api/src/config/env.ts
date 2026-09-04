import 'dotenv/config';
import { z } from 'zod';

/**
 * Config is validated at boot so a misconfigured deployment fails loudly on start
 * rather than at the first request that happens to need the missing value.
 */
const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * Signing key for access tokens. Rotating it invalidates every access token, which
   * is the intended emergency lever; refresh tokens live in the database and survive.
   */
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters — generate one with `openssl rand -base64 48`'),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),

  /** Failed logins before the account locks. Shared across serverless containers. */
  MAX_FAILED_LOGINS: z.coerce.number().int().min(3).max(20).default(5),
  ACCOUNT_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  /**
   * Public origin of the app, used to build password-reset links. It must be the address
   * a user's browser can actually reach, which is why it cannot be inferred from the
   * request on a serverless platform sitting behind a rewrite.
   */
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),

  /**
   * Resend is the preferred transport: one credential, and its API reports a per-send
   * result, so a failed delivery is something the caller can act on rather than guess at.
   */
  RESEND_API_KEY: z.string().optional(),

  /**
   * SMTP is the fallback — Gmail, Brevo, or Resend's own smtp.resend.com. With neither this
   * nor RESEND_API_KEY set, password-reset emails are logged instead of sent, so local
   * development works without credentials and the app still boots in production with the
   * feature simply unavailable.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  /**
   * Defaults to Resend's shared sender, so a developer holding only an API key can send
   * without owning a domain. That address delivers ONLY to the address the Resend account
   * was registered with — every other recipient is refused with a 403 — so production must
   * override it. Enforced below.
   */
  MAIL_FROM: z.string().default('RNTPS Admin <onboarding@resend.dev>'),

  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),

  /** Invitations are handed out ahead of time, so they outlive a self-service reset. */
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),

  /**
   * Who receives the 7pm IST daily collection report. Comma-separated for more than one,
   * like CORS_ORIGINS above — the office and the accountant usually both want it, and a
   * second address should not require a code change.
   *
   * Empty means the job still runs on schedule and declines to send, which is what a fresh
   * checkout should do: nobody has chosen an address yet, and that is not a misconfiguration.
   *
   * No real default and no `.email()`, both on purpose. An address written here would be
   * matched by Netlify's secrets scanner against the build output and fail the deploy. And
   * a validation refinement would turn a typo in a *reporting* address into a boot failure
   * that takes the entire API down — far past what this feature is worth.
   */
  DAILY_REPORT_TO: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((address) => address.trim())
        .filter(Boolean),
    ),
});

/**
 * Checks that only matter once real users are involved. Both failures are silent in
 * production otherwise: the app boots, and the first password reset is the thing that
 * breaks.
 */
const envSchema = baseEnvSchema.superRefine((config, ctx) => {
  if (config.NODE_ENV !== 'production') return;

  // Netlify does not set APP_BASE_URL for us, so an unset value ships localhost links to
  // real inboxes — reachable by nobody.
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(config.APP_BASE_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['APP_BASE_URL'],
      message: 'must be the public origin in production, not localhost — reset links would be unreachable',
    });
  }

  // Resend refuses every recipient but the account owner from resend.dev, so leaving the
  // default in place means the first real reset dies with a 403 nobody sees.
  const canSend =
    Boolean(config.RESEND_API_KEY) ||
    Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS);
  if (canSend && /resend\.dev>?\s*$/i.test(config.MAIL_FROM)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAIL_FROM'],
      message:
        'onboarding@resend.dev only delivers to your own Resend account address — set an address on a verified domain',
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Deliberately console, not the logger: the logger itself depends on this config.
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** True when a transport has enough settings to attempt a send. */
export const isResendConfigured = Boolean(env.RESEND_API_KEY);
export const isSmtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
export const isMailConfigured = isResendConfigured || isSmtpConfigured;
