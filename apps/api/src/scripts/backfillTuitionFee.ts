import { CLASS_CODES } from '@rntps/shared';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../config/logger.js';
import { getSettings } from '../lib/ids.js';
import { FeeStructure, feeStructureId } from '../models/FeeStructure.js';

/**
 * One-off backfill: every class should have a Tuition Fee head, defaulting to ₹500.
 *
 * Additive only — it never rewrites an existing head, including one already named TUITION
 * at ₹0 or some other amount an admin chose deliberately. It only:
 *
 * 1. Adds a ₹500 TUITION head to any FeeStructure (any class, any academic year) that has
 *    none, via `$push`, which cannot touch the rest of that document's `heads` array.
 * 2. Creates a brand-new, Tuition-only FeeStructure for any class that has no structure at
 *    all for the active academic year.
 *
 * Idempotent: a second run finds nothing left to do in either step, so it is safe to retry
 * after a partial failure.
 *
 * Run with `npm run backfill:tuition --workspace @rntps/api`. Pass `--dry-run` to see the
 * counts without writing anything, or `--academic-year=2026-27` to target a year other than
 * the currently active one for step 2 (step 1 always covers every year).
 */

const DRY_RUN = process.argv.includes('--dry-run');

function academicYearArg(): string | undefined {
  const flag = process.argv.find((arg) => arg.startsWith('--academic-year='));
  return flag?.split('=')[1];
}

export async function runBackfill(
  options: { academicYear?: string; dryRun?: boolean } = {},
): Promise<{ addedToExisting: number; createdNew: string[] }> {
  const dryRun = options.dryRun ?? false;
  const academicYear = options.academicYear ?? (await getSettings()).activeAcademicYear;

  // Step A: any structure, in any academic year, that has no TUITION head at all.
  //
  // `{ 'heads.code': { $ne: 'TUITION' } }` would be wrong here: on an array field it
  // matches a document if *any* element differs from 'TUITION', not if *no* element
  // matches it — it would still fire for a structure that already has TUITION alongside
  // other heads (e.g. TRANSPORT), and push a second TUITION head onto it. `$elemMatch`
  // inside `$not` is the correct "no element matches" query.
  const missingHeadFilter = { heads: { $not: { $elemMatch: { code: 'TUITION' } } } };
  const addedToExisting = dryRun
    ? await FeeStructure.countDocuments(missingHeadFilter)
    : (
        await FeeStructure.updateMany(missingHeadFilter, {
          $push: { heads: { code: 'TUITION', name: 'Tuition Fee', amountRupees: 500, appliesTo: 'ALL' } },
        })
      ).modifiedCount;

  // Step B: classes with no structure at all for the active (or requested) year get a
  // Tuition-only one, so they can be invoiced rather than staying "Not set" forever.
  const existingClassCodes = new Set(
    (await FeeStructure.find({ academicYear }).select('classCode').lean<{ classCode: string }[]>()).map(
      (doc) => doc.classCode,
    ),
  );
  const missingClasses = CLASS_CODES.filter((code) => !existingClassCodes.has(code));

  if (!dryRun) {
    for (const classCode of missingClasses) {
      await FeeStructure.create({
        _id: feeStructureId(classCode, academicYear),
        classCode,
        academicYear,
        heads: [{ code: 'TUITION', name: 'Tuition Fee', amountRupees: 500, appliesTo: 'ALL' }],
      });
    }
  }

  return { addedToExisting, createdNew: missingClasses };
}

async function main(): Promise<void> {
  await connectDatabase();
  const result = await runBackfill({ academicYear: academicYearArg(), dryRun: DRY_RUN });
  logger.info(
    { dryRun: DRY_RUN, ...result },
    DRY_RUN ? 'dry run complete — nothing was written' : 'tuition fee backfill complete',
  );
}

// Guarded, unlike the other one-off scripts in this folder, because this one is also
// imported directly by its own test (`runBackfill`) — without the guard, importing this
// module for that would also kick off a real `main()` against whatever database is
// configured.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main()
    .catch((error) => {
      logger.error({ err: error }, 'backfill failed');
      process.exitCode = 1;
    })
    .finally(() => disconnectDatabase());
}
