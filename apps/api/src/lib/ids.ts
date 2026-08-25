import { academicYearShort } from '@rntps/shared';
import { SETTINGS_ID, Settings, type SettingsDoc } from '../models/Settings.js';
import { AppError } from './AppError.js';

type CounterName = keyof SettingsDoc['counters'];

/**
 * Sequences come from an atomic $inc on the settings document. They are never derived
 * from a document count — concurrent onboarding would hand out the same number twice.
 */
async function nextSequence(counter: CounterName): Promise<{ seq: number; settings: SettingsDoc }> {
  const settings = await Settings.findOneAndUpdate(
    { _id: SETTINGS_ID },
    { $inc: { [`counters.${counter}`]: 1 } },
    { returnDocument: 'after' },
  ).lean<SettingsDoc>();

  if (!settings) {
    throw new AppError(500, 'Settings have not been initialised. Run `npm run seed:settings`.', 'NO_SETTINGS');
  }
  return { seq: settings.counters[counter], settings };
}

/** e.g. "RNTPS-26-001" */
export async function generateStudentId(): Promise<string> {
  const { seq, settings } = await nextSequence('student');
  const yy = academicYearShort(settings.activeAcademicYear);
  return `${settings.studentIdPrefix}-${yy}-${String(seq).padStart(3, '0')}`;
}

/** e.g. "FAM-26-001" */
export async function generateFamilyId(): Promise<string> {
  const { seq, settings } = await nextSequence('family');
  const yy = academicYearShort(settings.activeAcademicYear);
  return `FAM-${yy}-${String(seq).padStart(3, '0')}`;
}

/**
 * e.g. "RCPT-26-0042". Receipts are handed to parents and reconciled by hand, so the
 * sequence must be gap-free per year — which is why it comes from the atomic counter
 * rather than a document count.
 */
export async function nextReceiptNo(): Promise<string> {
  const { seq, settings } = await nextSequence('receipt');
  const yy = academicYearShort(settings.activeAcademicYear);
  return `RCPT-${yy}-${String(seq).padStart(4, '0')}`;
}

export async function getSettings(): Promise<SettingsDoc> {
  const settings = await Settings.findById(SETTINGS_ID).lean<SettingsDoc>();
  if (!settings) {
    throw new AppError(500, 'Settings have not been initialised. Run `npm run seed:settings`.', 'NO_SETTINGS');
  }
  return settings;
}
