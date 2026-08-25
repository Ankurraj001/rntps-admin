import { stdout } from 'node:process';
import { env, isMailConfigured } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sendMail, verifyMailConnection } from '../lib/mailer.js';

/**
 * Checks the SMTP settings before anyone depends on them, since a password-reset flow
 * that silently fails to send is worse than one that is obviously switched off.
 *
 * Usage: npm run mail:test -- you@example.com
 */
async function main(): Promise<void> {
  const [to] = process.argv.slice(2);
  if (!to) throw new Error('Usage: npm run mail:test -- you@example.com');

  stdout.write(`\n  SMTP configured : ${isMailConfigured ? 'yes' : 'NO'}\n`);
  stdout.write(`  host            : ${env.SMTP_HOST ?? '(unset)'}:${env.SMTP_PORT}\n`);
  stdout.write(`  user            : ${env.SMTP_USER ?? '(unset)'}\n`);
  stdout.write(`  from            : ${env.MAIL_FROM ?? env.SMTP_USER ?? '(unset)'}\n`);
  stdout.write(`  app base url    : ${env.APP_BASE_URL}\n\n`);

  await verifyMailConnection();
  stdout.write('  Credentials accepted by the server.\n');

  const result = await sendMail({
    to,
    subject: 'RNTPS Admin — SMTP test',
    text: 'If you are reading this, password-reset emails will work.',
    html: '<p>If you are reading this, password-reset emails will work.</p>',
  });

  stdout.write(result.sent ? `  Test email sent to ${to}.\n\n` : '  Send failed — see the log above.\n\n');
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'mail test failed');
  process.exitCode = 1;
});
