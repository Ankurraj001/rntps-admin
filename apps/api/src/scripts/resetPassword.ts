import { stdout } from 'node:process';
import { emailSchema } from '@rntps/shared';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../config/logger.js';
import { generateTemporaryPassword, hashPassword } from '../lib/password.js';
import { plaintextFieldFor } from '../lib/plaintextPassword.js';
import { User } from '../models/User.js';

/**
 * Break-glass password reset, for when nobody can sign in to use the Users page.
 *
 * Without this the only recovery from "every admin lost their password" would be
 * editing the database by hand. Requires shell access to the deployment, which is the
 * intended bar.
 *
 * Usage: npm run reset:password -- someone@school.example
 */
async function main(): Promise<void> {
  const [rawEmail] = process.argv.slice(2);
  if (!rawEmail) throw new Error('Usage: npm run reset:password -- email@school.example');

  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid email');

  await connectDatabase();

  const user = await User.findOne({ email: parsed.data }).select(
    '+passwordHash +refreshTokens +plaintextPassword',
  );
  if (!user) throw new Error(`No account found for ${parsed.data}`);

  const temporaryPassword = generateTemporaryPassword();
  user.passwordHash = await hashPassword(temporaryPassword);
  user.plaintextPassword = plaintextFieldFor(temporaryPassword).plaintextPassword;
  user.mustChangePassword = true;
  user.passwordChangedAt = new Date();
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  // Reactivate, since a deactivated admin cannot be recovered any other way.
  user.isActive = true;

  const now = new Date();
  for (const token of user.refreshTokens) {
    if (token.revokedAt === null) token.revokedAt = now;
  }

  await user.save();

  // stdout rather than the logger, which redacts credential-shaped fields.
  stdout.write(
    [
      '',
      `  Password reset for ${user.email} (${user.role}).`,
      '',
      `    Temporary password: ${temporaryPassword}`,
      '',
      '  Shown once. All existing sessions were signed out.',
      '',
    ].join('\n'),
  );
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'password reset failed');
    process.exitCode = 1;
  })
  .finally(() => void disconnectDatabase());
