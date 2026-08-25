import { z } from 'zod';
import { ATTENDANCE_STATUSES, CLASS_CODES } from '../constants.js';
import { DATE_KEY_PATTERN, PERIOD_PATTERN, isValidDateKey } from '../date.js';

const dateKeyField = z.string().refine(isValidDateKey, 'Enter a valid date');

export const rosterQuerySchema = z.object({
  classCode: z.enum(CLASS_CODES),
  dateKey: dateKeyField,
});

export const markSchema = z.object({
  studentId: z.string().trim().toUpperCase().min(1),
  status: z.enum(ATTENDANCE_STATUSES),
  remarks: z.string().trim().max(200).default(''),
});

export const saveRosterSchema = z.object({
  classCode: z.enum(CLASS_CODES),
  dateKey: dateKeyField,
  marks: z.array(markSchema).min(1, 'Nothing to save').max(200),
});

export const monthlyQuerySchema = z.object({
  classCode: z.enum(CLASS_CODES),
  month: z.string().regex(PERIOD_PATTERN, 'Use the form 2026-08'),
});

export const attendanceSummaryQuerySchema = z.object({
  month: z.string().regex(PERIOD_PATTERN, 'Use the form 2026-08'),
  classCode: z.enum(CLASS_CODES).optional(),
  /** Percentage below which a student is reported as a defaulter. */
  threshold: z.coerce.number().min(0).max(100).default(75),
});

export const studentAttendanceQuerySchema = z.object({
  from: z.string().regex(DATE_KEY_PATTERN).optional(),
  to: z.string().regex(DATE_KEY_PATTERN).optional(),
});

export type SaveRosterPayload = z.output<typeof saveRosterSchema>;
export type RosterQuery = z.output<typeof rosterQuerySchema>;
export type MonthlyQuery = z.output<typeof monthlyQuerySchema>;
export type AttendanceSummaryQuery = z.output<typeof attendanceSummaryQuerySchema>;

export interface RosterEntry {
  studentId: string;
  fullName: string;
  rollNo: number | null;
  status: (typeof ATTENDANCE_STATUSES)[number] | null;
  remarks: string;
}

export interface RosterResponse {
  classCode: string;
  dateKey: string;
  /**
   * Set for a school holiday or any Sunday. Sundays are not stored anywhere — they are
   * derived, so the rule applies to past dates too and no backfill is ever needed.
   */
  holiday: { dateKey: string; label: string } | null;
  /** A Sunday cannot be marked at all; the roster is read-only. */
  isSunday: boolean;
  isFuture: boolean;
  submittedAt: string | null;
  submittedBy: string | null;
  entries: RosterEntry[];
}

export interface AttendanceTotals {
  present: number;
  absent: number;
  holiday: number;
  workingDays: number;
  percentage: number;
}

export interface MonthlyRow {
  studentId: string;
  fullName: string;
  rollNo: number | null;
  /** dateKey -> status, sparse: unmarked days are simply absent from the map. */
  days: Record<string, string>;
  totals: AttendanceTotals;
}

export interface MonthlyResponse {
  classCode: string;
  month: string;
  dateKeys: string[];
  holidays: Record<string, string>;
  rows: MonthlyRow[];
}

export interface AttendanceDefaulter {
  studentId: string;
  fullName: string;
  classCode: string;
  totals: AttendanceTotals;
}

/** Percentage of working days a student was present, rounded to one decimal. */
export function attendancePercentage(present: number, workingDays: number): number {
  if (workingDays === 0) return 0;
  return Math.round((present / workingDays) * 1000) / 10;
}
