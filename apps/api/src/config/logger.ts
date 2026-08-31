import pino from 'pino';
import { env, isProduction } from './env.js';

/**
 * Student names and guardian phone numbers are children's personal data, so they never
 * reach the logs — records are identified by studentId only.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.passwordHash',
      '*.newPassword',
      '*.currentPassword',
      '*.temporaryPassword',
      '*.token',
      '*.passwordResetTokenHash',
      '*.phone',
      '*.guardians',
      '*.fullName',
    ],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
});
