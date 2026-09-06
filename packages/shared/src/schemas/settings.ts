import { z } from 'zod';
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
  holidays: z.array(holidaySchema).max(MAX_HOLIDAYS).optional(),
  templates: z.array(messageTemplateSchema).max(20).optional(),
});

export type UpdateSettingsPayload = z.output<typeof updateSettingsSchema>;
export type Holiday = z.output<typeof holidaySchema>;

export interface SettingsDto {
  schoolName: string;
  schoolAddress: string;
  schoolPhone: string;
  activeAcademicYear: string;
  studentIdPrefix: string;
  feeDueDayOfMonth: number;
  holidays: { dateKey: string; label: string }[];
  templates: { key: string; name: string; body: string; isActive: boolean }[];
  counters: { student: number; receipt: number; family: number };
}
