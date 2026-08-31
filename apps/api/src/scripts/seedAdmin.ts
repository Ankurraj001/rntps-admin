import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { emailSchema } from '@rntps/shared';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../config/logger.js';
import { generateTemporaryPassword, hashPassword } from '../lib/password.js';
import { User } from '../models/User.js';

/**
 * Creates the first admin so there is a way into the system.
 *
 * The password is generated and printed once rather than accepted as an argument —
 * a password passed on the command line ends up in shell history.
 *
 * Usage: npm run seed:admin -- "Name" name@school.example
 */
async function main(): Promise<void> {
  await connectDatabase();

  const [nameArg, emailArg] = process.argv.slice(2);

  const rl = createInterface({ input: stdin, output: stdout });
  const name = nameArg ?? (await rl.question('Admin full name: '));
  const rawEmail = emailArg ?? (await rl.question('Admin email: '));
  rl.close();

  const parsedEmail = emailSchema.safeParse(rawEmail);
  if (!parsedEmail.success) {
    throw new Error(parsedEmail.error.issues[0]?.message ?? 'Invalid email');
  }
  const email = parsedEmail.data;

  if (!name || name.trim().length < 2) throw new Error('Name is required');

  const existing = await User.findOne({ email }).lean();
  if (existing) {
    logger.info({ email }, 'an account with that email already exists, nothing to do');
    return;
  }

  const temporaryPassword = generateTemporaryPassword();
  await User.create({
    name: name.trim(),
    email,
    passwordHash: await hashPassword(temporaryPassword),
    role: 'ADMIN',
    assignedClasses: [],
    isActive: true,
    mustChangePassword: true,
    createdBy: 'seed',
  });

  // Written to stdout rather than the logger, which redacts credential-shaped fields.
  stdout.write(
    [
      '',
      '  Admin account created.',
      '',
      `    Email:              ${email}`,
      `    Temporary password: ${temporaryPassword}`,
      '',
      '  This is shown once. You will be asked to change it at first sign-in.',
      '',
    ].join('\n'),
  );
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'seed admin failed');
    process.exitCode = 1;
  })
  .finally(() => void disconnectDatabase());
