import 'dotenv/config';
import { z } from 'zod';

/**
 * Config is validated at boot so a misconfigured deployment fails loudly on start
 * rather than at the first request that happens to need the missing value.
 */
const envSchema = z.object({
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
   * SMTP is optional. Left unset, password-reset emails are logged instead of sent, so
   * local development works without credentials and the app still boots in production
   * with the feature simply unavailable.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().optional(),

  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),

  /**
   * Keeps a readable copy of each password alongside the hash, so an admin can look one
   * up and tell a teacher what it is.
   *
   * Defaults to false. Enabling it means a leak of the database — or of the connection
   * string — hands over every staff password in usable form, and staff reuse passwords
   * elsewhere. Authentication still uses the hash; this field is only ever read, never
   * verified against.
   */
  STORE_PLAINTEXT_PASSWORDS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
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

/** True when enough SMTP settings are present to actually send mail. */
export const isMailConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
