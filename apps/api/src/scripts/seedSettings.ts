import { FEE_DEMAND_TEMPLATE_KEY, academicYearFor } from '@rntps/shared';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../config/logger.js';
import { SETTINGS_ID, Settings } from '../models/Settings.js';

/**
 * Creates the singleton settings document. Safe to re-run: an existing document is
 * left untouched so counters are never reset (which would hand out duplicate IDs).
 */
async function main(): Promise<void> {
  await connectDatabase();

  const existing = await Settings.findById(SETTINGS_ID).lean();
  if (existing) {
    logger.info({ activeAcademicYear: existing.activeAcademicYear }, 'settings already exist, nothing to do');
    return;
  }

  await Settings.create({
    _id: SETTINGS_ID,
    schoolName: 'RNTPS',
    activeAcademicYear: academicYearFor(),
    studentIdPrefix: 'RNTPS',
    feeDueDayOfMonth: 10,
    counters: { student: 0, receipt: 0, family: 0 },
    holidays: [],
    // Seeded inactive on purpose. The service falls back to its own default when no
    // active template is found, so the shipped wording stays in one place and this row is
    // only here to be switched on and edited when a school wants its own.
    templates: [
      {
        key: FEE_DEMAND_TEMPLATE_KEY,
        name: 'Monthly fee demand',
        body: [
          '*{{schoolName}}*',
          '{{schoolAddress}}',
          '',
          '*MONTHLY FEE · {{periodLabel}}*',
          '{{slip}}',
          '_{{note}}_',
        ].join('\n'),
        isActive: false,
      },
    ],
  });

  logger.info('settings seeded');
}

main()
  .catch((error) => {
    logger.fatal({ err: error }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(() => void disconnectDatabase());
