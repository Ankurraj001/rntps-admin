import { CLASS_CODES, type ClassCode, type ExamScores } from '@rntps/shared';
import { Schema, model } from 'mongoose';

export interface ExamResultDoc {
  /**
   * `{studentId}:{academicYear}`, e.g. "RNTPS-26-001:2026-27".
   *
   * Keying on the pair makes a second marks card for the same student and session
   * structurally impossible — no unique index and no application check — and makes
   * correcting marks a plain idempotent upsert, exactly as attendance does for a day.
   */
  _id: string;
  studentId: string;
  academicYear: string;
  /**
   * What the student was when they sat these papers.
   *
   * Snapshots, for the same reason invoices carry them: the year rollover promotes the
   * student in place — classCode moves up one and rollNo is cleared for reassignment — so
   * reading the live record for a closed session would file last year's marks under this
   * year's class and show no roll number at all. The name is snapshotted too so an
   * archived row is readable without a join.
   */
  studentNameSnapshot: string;
  classCodeSnapshot: ClassCode;
  rollNoSnapshot: number | null;
  /** Percentages, 0-100 with at most two decimals. Null means not recorded, not zero. */
  scores: ExamScores;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A mark is a percentage, so unlike every amount in this system it is not an integer.
 * The two-decimal cap is enforced at the zod boundary rather than here, where a rejection
 * can carry a message that names the field.
 */
const percent = { type: Number, default: null, min: 0, max: 100 };

const scoresSchema = new Schema<ExamScores>(
  {
    UT1: percent,
    UT2: percent,
    HALF_YEARLY: percent,
    UT3: percent,
    UT4: percent,
    FINAL: percent,
  },
  { _id: false },
);

const examResultSchema = new Schema<ExamResultDoc>(
  {
    _id: { type: String, required: true },
    studentId: { type: String, required: true },
    academicYear: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    studentNameSnapshot: { type: String, required: true, trim: true },
    classCodeSnapshot: { type: String, enum: CLASS_CODES, required: true },
    rollNoSnapshot: { type: Number, default: null },
    scores: { type: scoresSchema, required: true },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, _id: false },
);

// The gradebook: one session, optionally one class.
examResultSchema.index({ academicYear: 1, classCodeSnapshot: 1 });
// One student's history, newest session first.
examResultSchema.index({ studentId: 1, academicYear: -1 });

export const ExamResult = model<ExamResultDoc>('ExamResult', examResultSchema);

export function examResultId(studentId: string, academicYear: string): string {
  return `${studentId}:${academicYear}`;
}
