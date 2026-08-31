import { stdout } from 'node:process';
import { env, isMailConfigured, isResendConfigured } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sendMail, verifyMailConnection } from '../lib/mailer.js';

/**
 * Checks the mail settings before anyone depends on them, since a password-reset flow
 * that silently fails to send is worse than one that is obviously switched off.
 *
 * Usage: npm run mail:test -- you@example.com
 */
async function main(): Promise<void> {
  const [to] = process.argv.slice(2);
  if (!to) throw new Error('Usage: npm run mail:test -- you@example.com');

  stdout.write(`\n  mail configured : ${isMailConfigured ? 'yes' : 'NO'}\n`);
  stdout.write(`  transport       : ${isResendConfigured ? 'Resend (HTTP API)' : 'SMTP'}\n`);
  if (!isResendConfigured) {
    stdout.write(`  host            : ${env.SMTP_HOST ?? '(unset)'}:${env.SMTP_PORT}\n`);
    stdout.write(`  user            : ${env.SMTP_USER ?? '(unset)'}\n`);
  }
  stdout.write(`  from            : ${env.MAIL_FROM}\n`);
  stdout.write(`  app base url    : ${env.APP_BASE_URL}\n\n`);

  if (/resend\.dev/i.test(env.MAIL_FROM)) {
    stdout.write(
      "  NOTE: MAIL_FROM is still Resend's shared sender, which only delivers to the\n" +
        '        address your Resend account was registered with. Any other recipient is\n' +
        '        refused with a 403. Set MAIL_FROM to an address on a verified domain.\n\n',
    );
  }

  // A failed check is reported and then stepped past rather than aborting, because the
  // send is the only real proof. The common case is MAIL_FROM still being Resend's shared
  // sender: that cannot reach staff, but it *can* reach your own account address, and
  // finding out which is exactly what this script is for.
  try {
    await verifyMailConnection();
    stdout.write('  Configuration looks deliverable to any recipient.\n\n');
  } catch (error) {
    stdout.write(`  Check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    stdout.write('  Trying the send anyway — it may still reach your own address.\n\n');
  }

  const result = await sendMail({
    to,
    subject: 'RNTPS Admin — mail test',
    text: 'If you are reading this, password-reset emails reach this address.',
    html: '<p>If you are reading this, password-reset emails reach this address.</p>',
  });

  stdout.write(
    result.sent
      ? `  Test email sent to ${to}.\n\n`
      : `  Send failed: ${result.error ?? 'see the log above'}\n\n`,
  );
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'mail test failed');
  process.exitCode = 1;
});
