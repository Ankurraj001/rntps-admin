import { z } from 'zod';
import { REPORT_SCOPE_CODES, type ReportScopeCode } from '../constants.js';
import { ACADEMIC_YEAR_PATTERN, DATE_KEY_PATTERN } from '../date.js';
import { MAX_MESSAGE_LENGTH } from './notifications.js';

/**
 * A day the whole school is closed.
 *
 * School-wide by construction: there is no classCode here, so declaring one closes every
 * class and the teacher register at once rather than each roster being told separately.
 */
export const holidaySchema = z.object({
  dateKey: z.string().regex(DATE_KEY_PATTERN),
  label: z.string().trim().min(2).max(80),
});

/** Stated once so the array cap and the single-holiday endpoint cannot disagree. */
export const MAX_HOLIDAYS = 120;

export const messageTemplateSchema = z.object({
  key: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(80),
  body: z.string().trim().min(10).max(MAX_MESSAGE_LENGTH),
  isActive: z.boolean().default(true),
});

export const updateSettingsSchema = z.object({
  schoolName: z.string().trim().min(2).max(120).optional(),
  schoolAddress: z.string().trim().max(240).optional(),
  schoolPhone: z.string().trim().max(20).optional(),
  activeAcademicYear: z.string().regex(ACADEMIC_YEAR_PATTERN, 'Use the form 2026-27').optional(),
  studentIdPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,8}$/, 'Use 2-8 letters')
    .optional(),
  feeDueDayOfMonth: z.number().int().min(1).max(28).optional(),
  /** Which paper a report card opens on. `ALL` is the whole session. */
  defaultReportScope: z.enum(REPORT_SCOPE_CODES).optional(),
  holidays: z.array(holidaySchema).max(MAX_HOLIDAYS).optional(),
  templates: z.array(messageTemplateSchema).max(20).optional(),
});

export type UpdateSettingsPayload = z.output<typeof updateSettingsSchema>;
export type Holiday = z.output<typeof holidaySchema>;

/**
 * The settings any signed-in user may read: what printing a document needs, and nothing
 * else. The letterhead, plus which paper a report card opens on.
 *
 * A separate shape from `SettingsDto` rather than a subset of it, because the audience is
 * different. Report cards are printed by whoever teaches the class, but the full settings
 * payload also carries the student ID prefix and the school's student and receipt
 * counters, which is precisely why reading it is admin-only. Keeping this a smaller
 * response rather than a filtered one makes "a teacher cannot see the counters"
 * structural instead of a rule the next endpoint has to remember.
 *
 * Writing stays admin-only either way — this is what a teacher may *read* to print with,
 * not something they can change.
 */
export interface SchoolInfoDto {
  schoolName: string;
  schoolAddress: string;
  schoolPhone: string;
  activeAcademicYear: string;
  defaultReportScope: ReportScopeCode;
}

export interface SettingsDto {
  schoolName: string;
  schoolAddress: string;
  schoolPhone: string;
  activeAcademicYear: string;
  studentIdPrefix: string;
  feeDueDayOfMonth: number;
  defaultReportScope: ReportScopeCode;
  holidays: { dateKey: string; label: string }[];
  templates: { key: string; name: string; body: string; isActive: boolean }[];
  counters: { student: number; receipt: number; family: number };
}
