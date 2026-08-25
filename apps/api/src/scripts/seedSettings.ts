import { academicYearFor } from '@rntps/shared';
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
    templates: [
      {
        key: 'FEE_DUE',
        name: 'Fee reminder',
        body: [
          'Dear {{guardianName}},',
          'Fee due at {{schoolName}} for {{period}}:',
          '{{studentLines}}',
          'Total: {{familyTotal}}',
          'Kindly pay by {{dueDate}}.',
        ].join('\n'),
        isActive: true,
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
