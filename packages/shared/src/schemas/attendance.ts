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

/**
 * Teacher attendance.
 *
 * The same three states and the same Sunday/holiday rules as a class roster, but keyed on a
 * user id rather than a studentId and with no classCode at all — teachers do not belong to a
 * class. It is stored in its own collection so school-wide student figures cannot absorb it.
 */
export const staffRosterQuerySchema = z.object({
  dateKey: dateKeyField,
});

export const staffMarkSchema = z.object({
  /**
   * A User `_id` as 24 hex characters.
   *
   * Normalised *down*, unlike `markSchema.studentId`'s `.toUpperCase()`: the stored `_id` is
   * `{userId}:{dateKey}`, so the same teacher-day arriving in two different cases would upsert
   * two documents and destroy the uniqueness the whole `_id` design rests on. The shape is
   * checked here so a non-id is rejected at the edge rather than cast by Mongo.
   */
  userId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{24}$/, 'Not a valid user'),
  status: z.enum(ATTENDANCE_STATUSES),
  remarks: z.string().trim().max(200).default(''),
});

export const saveStaffRosterSchema = z.object({
  dateKey: dateKeyField,
  marks: z.array(staffMarkSchema).min(1, 'Nothing to save').max(100),
});

export const staffMonthlyQuerySchema = z.object({
  month: z.string().regex(PERIOD_PATTERN, 'Use the form 2026-08'),
});

export const studentAttendanceQuerySchema = z.object({
  from: z.string().regex(DATE_KEY_PATTERN).optional(),
  to: z.string().regex(DATE_KEY_PATTERN).optional(),
});

export type SaveRosterPayload = z.output<typeof saveRosterSchema>;
export type SaveStaffRosterPayload = z.output<typeof saveStaffRosterSchema>;
export type StaffMonthlyQuery = z.output<typeof staffMonthlyQuerySchema>;
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

/** A teacher's row on the daily roster. Mirrors RosterEntry, minus the roll number. */
export interface StaffRosterEntry {
  userId: string;
  name: string;
  status: (typeof ATTENDANCE_STATUSES)[number] | null;
  remarks: string;
}

export interface StaffRosterResponse {
  dateKey: string;
  holiday: { dateKey: string; label: string } | null;
  isSunday: boolean;
  isFuture: boolean;
  submittedAt: string | null;
  submittedBy: string | null;
  entries: StaffRosterEntry[];
}

export interface StaffMonthlyRow {
  userId: string;
  name: string;
  /** dateKey -> status, sparse: unmarked days are simply absent from the map. */
  days: Record<string, string>;
  totals: AttendanceTotals;
}

export interface StaffMonthlyResponse {
  month: string;
  dateKeys: string[];
  holidays: Record<string, string>;
  rows: StaffMonthlyRow[];
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
