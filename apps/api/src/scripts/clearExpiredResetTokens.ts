import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../config/logger.js';

/**
 * Housekeeping: nulls out password-reset tokens that have already expired.
 *
 * Expiry is enforced in code, so a leftover row is not exploitable — this keeps the
 * partial index small and means a stale hash is not sitting in the database, or in a
 * backup of it, longer than it has to.
 *
 * **Deliberately a script and not a TTL index.** A TTL index on `passwordResetExpiresAt`
 * would delete the entire user document when the reset expired, which is emphatically not
 * what anyone wants. Mongo TTL removes documents, not fields.
 *
 * Run with `npm run tokens:clear-expired --workspace @rntps/api`. `--dry-run` reports the
 * count without writing. Safe to run repeatedly, and safe to run while serving traffic.
 */

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  await connectDatabase();

  const db = mongoose.connection.db;
  if (!db) throw new Error('not connected');
  const users = db.collection('users');

  const filter = { passwordResetExpiresAt: { $ne: null, $lt: new Date() } };
  const expired = await users.countDocuments(filter);

  let cleared = 0;
  if (!DRY_RUN && expired > 0) {
    const result = await users.updateMany(filter, {
      $set: {
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        passwordResetPurpose: null,
      },
    });
    cleared = result.modifiedCount;
  }

  logger.info(
    { dryRun: DRY_RUN, expired, cleared },
    DRY_RUN ? 'dry run complete — nothing was written' : 'expired reset tokens cleared',
  );
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'clearing expired reset tokens failed');
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
