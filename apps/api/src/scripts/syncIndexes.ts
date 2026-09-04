import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../config/logger.js';
import { Attendance } from '../models/Attendance.js';
import { AuditLog } from '../models/AuditLog.js';
import { Expense } from '../models/Expense.js';
import { FeeStructure } from '../models/FeeStructure.js';
import { Invoice } from '../models/Invoice.js';
import { Notification } from '../models/Notification.js';
import { Settings } from '../models/Settings.js';
import { Student } from '../models/Student.js';
import { User } from '../models/User.js';

const MODELS = [Student, Settings, User, AuditLog, Attendance, FeeStructure, Invoice, Notification, Expense];

/**
 * Builds the indexes declared in the schemas. This must run as a deploy step because
 * `connectDatabase` sets `autoIndex: false` in production — index builds racing on
 * every instance start is worse than an explicit, once-per-deploy sync.
 *
 * syncIndexes() also DROPS indexes that no longer appear in a schema, which is what
 * makes it idempotent. Safe to re-run.
 */
async function main(): Promise<void> {
  await connectDatabase();

  for (const model of MODELS) {
    const dropped = await model.syncIndexes();
    const indexes = await model.collection.indexes();
    logger.info(
      {
        collection: model.collection.collectionName,
        dropped,
        indexes: indexes.map((i) => i.name),
      },
      `synced ${model.collection.collectionName}`,
    );
  }

  logger.info('index sync complete');
}

main()
  .catch((error) => {
    logger.fatal({ err: error }, 'index sync failed');
    process.exitCode = 1;
  })
  .finally(() => void disconnectDatabase());
