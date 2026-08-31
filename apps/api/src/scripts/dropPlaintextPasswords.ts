import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../config/logger.js';

/**
 * One-off migration: remove the readable `plaintextPassword` copy from every user.
 *
 * The field and the endpoint that read it are gone from the code, but dropping a field
 * from a Mongoose schema does not touch data already in MongoDB — the values sit there
 * indefinitely, still readable by anything holding the connection string. This unsets
 * them.
 *
 * It runs through the raw driver rather than the User model on purpose: the model no
 * longer declares the field, so Mongoose would strip the very values this needs to read.
 *
 * Idempotent — documents are selected by the *presence* of the field, so a second run
 * finds nothing.
 *
 * **`$unset` is not secure erasure.** The old value can survive in the oplog, in Atlas
 * backups and snapshots, and in unreclaimed WiredTiger pages. If this reports any
 * non-null values, treat those passwords as compromised and pass `--force-rotation` to
 * require a fresh password at next sign-in and revoke existing sessions.
 *
 * Run with `npm run migrate:drop-plaintext --workspace @rntps/api`.
 * Pass `--dry-run` to report without writing, `--force-rotation` to also rotate.
 */

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE_ROTATION = process.argv.includes('--force-rotation');

function db() {
  const conn = mongoose.connection.db;
  if (!conn) throw new Error('not connected');
  return conn;
}

async function main(): Promise<void> {
  await connectDatabase();
  const users = db().collection('users');

  // Counted separately: a document can carry the field as an explicit null (written while
  // the flag was off), which exposes nothing. Only a string value is a leaked password,
  // and only that justifies forcing the affected users to pick a new one.
  const present = await users.countDocuments({ plaintextPassword: { $exists: true } });
  const leakedIds = (
    await users
      .find({ plaintextPassword: { $type: 'string' } }, { projection: { _id: 1 } })
      .toArray()
  ).map((doc) => doc._id);
  const leaked = leakedIds.length;

  let unset = 0;
  let rotated = 0;

  if (!DRY_RUN) {
    if (present > 0) {
      const result = await users.updateMany(
        { plaintextPassword: { $exists: true } },
        { $unset: { plaintextPassword: '' } },
      );
      unset = result.modifiedCount;
    }

    if (FORCE_ROTATION && leaked > 0) {
      const result = await users.updateMany(
        { _id: { $in: leakedIds } },
        {
          $set: {
            mustChangePassword: true,
            // Ending every session is the other half of rotation: a leaked password is
            // worthless if the sessions it could have opened are already dead.
            refreshTokens: [],
            passwordResetTokenHash: null,
            passwordResetExpiresAt: null,
          },
        },
      );
      rotated = result.modifiedCount;
    }
  }

  logger.info(
    { dryRun: DRY_RUN, forceRotation: FORCE_ROTATION, present, leaked, unset, rotated },
    DRY_RUN ? 'dry run complete — nothing was written' : 'plaintextPassword removed',
  );

  if (leaked > 0 && !FORCE_ROTATION) {
    logger.warn(
      { leaked },
      'these accounts had a readable password stored — $unset does not scrub backups or the ' +
        'oplog, so treat them as compromised and re-run with --force-rotation',
    );
  } else if (leaked === 0) {
    logger.info('no readable password was ever stored — nothing to rotate');
  }
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'migration failed');
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
