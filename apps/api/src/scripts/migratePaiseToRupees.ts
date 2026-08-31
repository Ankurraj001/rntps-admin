import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../config/logger.js';

/**
 * One-off migration: money moves from integer paise to integer rupees.
 *
 * Every amount is divided by 100 and the field is renamed (`amountPaise` ->
 * `amountRupees`, and so on). It runs through the raw driver rather than the Mongoose
 * models on purpose — the models no longer declare the old field names, so they would
 * strip the very values this needs to read.
 *
 * Two properties make it safe to run against live data:
 *
 * 1. **Idempotent.** Each document is selected by the *presence of the old field*, so a
 *    second run finds nothing and divides nothing. Re-running after a partial failure
 *    picks up exactly where it stopped.
 * 2. **Loud about remainders.** A paise value that is not a whole number of rupees
 *    (say 125_050, i.e. ₹1,250.50) cannot survive the move intact. It rounds to the
 *    nearest rupee and every such document is listed in the summary, so the school can
 *    check the handful affected rather than discovering a silent ₹0.50 drift later.
 *
 * Run with `npm run migrate:rupees --workspace @rntps/api`. Pass `--dry-run` to see the
 * report without writing anything.
 */

const DRY_RUN = process.argv.includes('--dry-run');

/** Rounds paise to whole rupees, recording anything that did not divide evenly. */
class Converter {
  readonly remainders: { collection: string; id: string; field: string; paise: number }[] = [];

  convert(paise: unknown, collection: string, id: unknown, field: string): number {
    if (typeof paise !== 'number' || !Number.isFinite(paise)) return 0;
    if (paise % 100 !== 0) {
      this.remainders.push({ collection, id: String(id), field, paise });
    }
    return Math.round(paise / 100);
  }
}

const conv = new Converter();

function db() {
  const conn = mongoose.connection.db;
  if (!conn) throw new Error('not connected');
  return conn;
}

async function migrateFeeStructures(): Promise<number> {
  const col = db().collection('feestructures');
  const docs = await col.find({ 'heads.amountPaise': { $exists: true } }).toArray();

  for (const doc of docs) {
    const heads = (doc.heads as Record<string, unknown>[]).map((head) => {
      const { amountPaise, ...rest } = head;
      return {
        ...rest,
        amountRupees: conv.convert(amountPaise, 'feeStructures', doc._id, 'heads.amountPaise'),
      };
    });
    if (!DRY_RUN) await col.updateOne({ _id: doc._id }, { $set: { heads } });
  }
  return docs.length;
}

async function migrateInvoices(): Promise<number> {
  const col = db().collection('invoices');
  const docs = await col.find({ totalPaise: { $exists: true } }).toArray();

  for (const doc of docs) {
    const id = doc._id;
    const lineItems = ((doc.lineItems as Record<string, unknown>[]) ?? []).map((item) => {
      const { amountPaise, ...rest } = item;
      return { ...rest, amountRupees: conv.convert(amountPaise, 'invoices', id, 'lineItems.amountPaise') };
    });
    const payments = ((doc.payments as Record<string, unknown>[]) ?? []).map((payment) => {
      const { amountPaise, ...rest } = payment;
      return { ...rest, amountRupees: conv.convert(amountPaise, 'invoices', id, 'payments.amountPaise') };
    });

    if (DRY_RUN) continue;
    await col.updateOne(
      { _id: id },
      {
        $set: {
          lineItems,
          payments,
          grossRupees: conv.convert(doc.grossPaise, 'invoices', id, 'grossPaise'),
          concessionRupees: conv.convert(doc.concessionPaise, 'invoices', id, 'concessionPaise'),
          totalRupees: conv.convert(doc.totalPaise, 'invoices', id, 'totalPaise'),
          paidRupees: conv.convert(doc.paidPaise, 'invoices', id, 'paidPaise'),
        },
        $unset: { grossPaise: '', concessionPaise: '', totalPaise: '', paidPaise: '' },
      },
    );
  }
  return docs.length;
}

async function migrateStudents(): Promise<number> {
  const col = db().collection('students');
  // The third clause backfills students written before the transport field existed. They
  // read back as undefined rather than null, and `undefined !== null` would make the
  // invoice run treat "no override" as an override of nothing.
  const docs = await col
    .find({
      $or: [
        { transportFareOverridePaise: { $exists: true } },
        { 'concession.type': 'FLAT' },
        { transportFareOverrideRupees: { $exists: false } },
      ],
    })
    .toArray();

  let changed = 0;
  for (const doc of docs) {
    const set: Record<string, unknown> = {};
    const unset: Record<string, string> = {};

    if ('transportFareOverridePaise' in doc) {
      const raw = doc.transportFareOverridePaise;
      // Null means "use the class default" and must stay null, not become 0.
      set.transportFareOverrideRupees =
        raw === null || raw === undefined
          ? null
          : conv.convert(raw, 'students', doc._id, 'transportFareOverridePaise');
      unset.transportFareOverridePaise = '';
    } else if (!('transportFareOverrideRupees' in doc)) {
      set.transportFareOverrideRupees = null;
    }

    // A percentage concession is already unit-free; only a flat one is money.
    const concession = doc.concession as { type?: string; value?: number } | undefined;
    if (concession?.type === 'FLAT' && typeof concession.value === 'number' && concession.value > 0) {
      set['concession.value'] = conv.convert(concession.value, 'students', doc._id, 'concession.value');
    }

    if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) continue;
    changed += 1;
    if (!DRY_RUN) {
      await col.updateOne({ _id: doc._id }, {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      });
    }
  }
  return changed;
}

/**
 * Stamps invoices written before the `kind` field existed as MONTHLY.
 *
 * Reads are already tolerant of a missing `kind`, so this is housekeeping rather than a
 * correctness fix — but leaving half the collection without the field means every future
 * query has to keep remembering that.
 */
async function backfillInvoiceKind(): Promise<number> {
  const col = db().collection('invoices');
  if (DRY_RUN) return col.countDocuments({ kind: { $exists: false } });
  const res = await col.updateMany({ kind: { $exists: false } }, { $set: { kind: 'MONTHLY' } });
  return res.modifiedCount;
}

async function migrateNotifications(): Promise<number> {
  const col = db().collection('notifications');
  const docs = await col.find({ 'items.totalDuePaise': { $exists: true } }).toArray();

  for (const doc of docs) {
    const items = ((doc.items as Record<string, unknown>[]) ?? []).map((item) => {
      const { totalDuePaise, students, ...rest } = item;
      return {
        ...rest,
        students: ((students as Record<string, unknown>[]) ?? []).map((s) => {
          const { duePaise, ...srest } = s;
          return { ...srest, dueRupees: conv.convert(duePaise, 'notifications', doc._id, 'items.students.duePaise') };
        }),
        totalDueRupees: conv.convert(totalDuePaise, 'notifications', doc._id, 'items.totalDuePaise'),
      };
    });

    const snapshot = doc.filterSnapshot as Record<string, unknown> | undefined;
    const set: Record<string, unknown> = { items };
    if (snapshot && 'minDuePaise' in snapshot) {
      const { minDuePaise, ...rest } = snapshot;
      set.filterSnapshot = {
        ...rest,
        minDueRupees: conv.convert(minDuePaise, 'notifications', doc._id, 'filterSnapshot.minDuePaise'),
      };
    }

    if (!DRY_RUN) await col.updateOne({ _id: doc._id }, { $set: set });
  }
  return docs.length;
}

/** Adds the ad-hoc charge counter to a settings document created before it existed. */
async function backfillChargeCounter(): Promise<number> {
  const col = db().collection('settings');
  if (DRY_RUN) return col.countDocuments({ 'counters.charge': { $exists: false } });
  const res = await col.updateMany(
    { 'counters.charge': { $exists: false } },
    { $set: { 'counters.charge': 0 } },
  );
  return res.modifiedCount;
}

/**
 * Folds the retired attendance statuses into the three that remain.
 *
 * LATE becomes PRESENT — the child was in school. LEAVE becomes ABSENT — they were not,
 * and nothing downstream ever treated an approved absence differently. Records left on
 * the old values would simply stop being counted, which is worse than converting them.
 */
async function migrateAttendanceStatuses(): Promise<{ late: number; leave: number }> {
  const col = db().collection('attendances');
  if (DRY_RUN) {
    return {
      late: await col.countDocuments({ status: 'LATE' }),
      leave: await col.countDocuments({ status: 'LEAVE' }),
    };
  }
  const late = await col.updateMany({ status: 'LATE' }, { $set: { status: 'PRESENT' } });
  const leave = await col.updateMany({ status: 'LEAVE' }, { $set: { status: 'ABSENT' } });
  return { late: late.modifiedCount, leave: leave.modifiedCount };
}

/**
 * Clears password-reset tokens that can no longer be used.
 *
 * An expired token is already refused, so this is housekeeping rather than a fix — but a
 * credential-reset hash that serves no purpose is better not kept, and before the app
 * checked whether it could send mail it minted these even with no SMTP configured.
 */

async function main(): Promise<void> {
  await connectDatabase();

  const chargeCounter = await backfillChargeCounter();
  const feeStructures = await migrateFeeStructures();
  const invoices = await migrateInvoices();
  const students = await migrateStudents();
  const notifications = await migrateNotifications();
  const invoiceKinds = await backfillInvoiceKind();
  const attendance = await migrateAttendanceStatuses();
  logger.info(
    { dryRun: DRY_RUN, chargeCounter, feeStructures, invoices, students, notifications, invoiceKinds, attendance },
    DRY_RUN ? 'dry run complete — nothing was written' : 'paise -> rupees migration complete',
  );

  if (conv.remainders.length > 0) {
    logger.warn(
      { count: conv.remainders.length, samples: conv.remainders.slice(0, 20) },
      'these amounts were not a whole number of rupees and were rounded to the nearest rupee — check them',
    );
  } else {
    logger.info('every amount divided evenly into whole rupees — nothing was rounded');
  }
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'migration failed');
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
