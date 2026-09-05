import { z } from 'zod';
import { CLASS_CODES, EXAM_CODES } from '../constants.js';
import { ACADEMIC_YEAR_PATTERN } from '../date.js';
import { paginationSchema } from './common.js';

/**
 * A mark is a percentage, and a percentage is not money.
 *
 * The whole-rupee rule that governs every other number in this system is scoped to
 * amounts — `concessionSchema` already carves the same exception out in the other
 * direction ("a percentage may be fractional, because 12.5% is a real thing a school
 * offers"), and `attendancePercentage()` returns a fractional number too. So a mark is
 * stored as a plain number rather than integer hundredths.
 *
 * Two decimals is the cap, and a third is *rejected rather than rounded* — the same
 * reject-don't-round rule `.int()` applies to a fractional rupee. Rounding 87.555 to
 * 87.56 silently disagrees with whatever the teacher read off the answer sheet, and the
 * disagreement is invisible once it is stored. `toFixed(2)` round-trips exactly here
 * because the value always arrives from a two-decimal input, not from arithmetic.
 *
 * Null is a real value, not a missing one: it means "not sat / not recorded yet", which
 * is what the gradebook shows as a dash. It is distinct from 0, which is a real mark.
 */
const percentField = z
  .number()
  .min(0, 'A mark cannot be negative')
  .max(100, 'A mark cannot exceed 100%')
  .refine((value) => Number(value.toFixed(2)) === value, 'Use at most two decimal places')
  .nullable();

/**
 * Written out rather than derived from EXAM_CODES so the six keys are statically typed
 * on both sides of the wire; the array still drives the column order in the UI.
 */
export const examScoresSchema = z.object({
  UT1: percentField.default(null),
  UT2: percentField.default(null),
  HALF_YEARLY: percentField.default(null),
  UT3: percentField.default(null),
  UT4: percentField.default(null),
  FINAL: percentField.default(null),
});

/**
 * The whole card is saved at once, which is why there is no per-exam endpoint: the modal
 * edits six fields together and one document holds all six, so a save is a single write.
 *
 * There is deliberately no classCode here. The class a mark belongs to is read from the
 * student record (or from the stored snapshot for a closed session), never from the
 * request — otherwise a teacher could reach another class by naming it in the body, which
 * is exactly what requireClassAccess exists to prevent elsewhere.
 */
export const saveExamResultSchema = z.object({
  studentId: z.string().trim().toUpperCase().min(1),
  academicYear: z.string().regex(ACADEMIC_YEAR_PATTERN, 'Use the form 2026-27'),
  scores: examScoresSchema,
});

export const listAcademicsQuerySchema = paginationSchema.extend({
  /** Matches against full name or studentId, like the students list. */
  q: z.string().trim().max(80).optional(),
  classCode: z.enum(CLASS_CODES).optional(),
  /** Omitted means the active session. */
  academicYear: z.string().regex(ACADEMIC_YEAR_PATTERN, 'Use the form 2026-27').optional(),
  sort: z.enum([...EXAM_CODES, 'fullName', 'rollNo']).default('rollNo'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export const studentAcademicsParamsSchema = z.object({
  studentId: z.string().trim().toUpperCase().min(1),
});

export type ExamScores = z.output<typeof examScoresSchema>;
export type SaveExamResultPayload = z.output<typeof saveExamResultSchema>;
export type ListAcademicsQuery = z.output<typeof listAcademicsQuerySchema>;

/**
 * One row of the gradebook.
 *
 * classCode and rollNo are what the student had *for that session*, not what they have
 * today — after a rollover the live record has moved up a class and lost its roll number,
 * so a closed session reads them back from the snapshot on the marks document.
 */
export interface AcademicRow {
  studentId: string;
  fullName: string;
  classCode: string;
  rollNo: number | null;
  academicYear: string;
  scores: ExamScores;
  /** False until marks have been saved at least once — the row exists, the record does not. */
  hasRecord: boolean;
  updatedAt: string | null;
}

/** One session's card on the student's Academics tab. */
export interface StudentExamYear {
  academicYear: string;
  classCode: string;
  rollNo: number | null;
  scores: ExamScores;
  updatedAt: string | null;
}

export interface StudentAcademicsResponse {
  studentId: string;
  years: StudentExamYear[];
}

/** Populates the session dropdown: every session with marks, plus the one in progress. */
export interface AcademicYearsResponse {
  years: string[];
  activeAcademicYear: string;
}

/** Blank scores, used wherever a student has no record for a session yet. */
export function emptyScores(): ExamScores {
  return { UT1: null, UT2: null, HALF_YEARLY: null, UT3: null, UT4: null, FINAL: null };
}
