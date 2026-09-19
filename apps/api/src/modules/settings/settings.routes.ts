import {
  DEFAULT_REPORT_SCOPE,
  updateSettingsSchema,
  type SchoolInfoDto,
  type SettingsDto,
} from '@rntps/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { getSettings } from '../../lib/ids.js';
import { SETTINGS_ID, Settings, type SettingsDoc } from '../../models/Settings.js';
import { AppError } from '../../lib/AppError.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';

function toDto(doc: SettingsDoc): SettingsDto {
  return {
    schoolName: doc.schoolName,
    schoolAddress: doc.schoolAddress,
    schoolPhone: doc.schoolPhone,
    activeAcademicYear: doc.activeAcademicYear,
    studentIdPrefix: doc.studentIdPrefix,
    feeDueDayOfMonth: doc.feeDueDayOfMonth,
    // Missing on a settings document predating the setting; the model default cannot
    // reach one that already exists, so the fallback lives here instead.
    defaultReportScope: doc.defaultReportScope ?? DEFAULT_REPORT_SCOPE,
    holidays: doc.holidays.map((h) => ({ ...h })),
    templates: doc.templates.map((t) => ({ ...t })),
    counters: { ...doc.counters },
  };
}

export const settingsRoutes = Router();

/**
 * Admin-only in both directions.
 *
 * Reading was previously open to any signed-in user so the dashboard header could show
 * the school name — but the same payload exposes the student ID prefix and the school's
 * student and receipt counters, which a teacher has no reason to see. The dashboard
 * endpoint now carries those two fields instead.
 */
/**
 * The letterhead, for any signed-in user.
 *
 * Registered *above* the admin gate below, so a request for it never reaches that gate.
 *
 * A teacher hands out their own class's report cards, and a card carries the school's
 * name and address at the top of it — but the payload `GET /` returns also carries the
 * student ID prefix and the counters, which is the whole reason reading it is admin-only.
 * So this relaxes the response rather than the permission: there is no filtering to get
 * wrong, because the fields a teacher may not see are not in the shape at all.
 */
settingsRoutes.get(
  '/school',
  requireAuth(),
  asyncHandler(async (_req, res) => {
    const doc = await getSettings();
    const info: SchoolInfoDto = {
      schoolName: doc.schoolName,
      schoolAddress: doc.schoolAddress,
      schoolPhone: doc.schoolPhone,
      activeAcademicYear: doc.activeAcademicYear,
      defaultReportScope: doc.defaultReportScope ?? DEFAULT_REPORT_SCOPE,
    };
    res.json(info);
  }),
);

settingsRoutes.use(requireAuth(), requireRole('ADMIN'));

settingsRoutes.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(toDto(await getSettings()));
  }),
);

settingsRoutes.patch(
  '/',
  validate(updateSettingsSchema),
  asyncHandler(async (req, res) => {
    // Counters are deliberately not writable here — they only move via atomic $inc.
    const updated = await Settings.findByIdAndUpdate(
      SETTINGS_ID,
      { $set: req.body },
      { new: true, runValidators: true },
    ).lean<SettingsDoc>();
    if (!updated) throw new AppError(500, 'Settings have not been initialised', 'NO_SETTINGS');
    res.json(toDto(updated));
  }),
);
