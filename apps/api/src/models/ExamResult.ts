import {
  CLASS_CODES,
  type ClassCode,
  type ExamScores,
  type ExamSubjectGrades,
  type ExamSubjectMarks,
  type SubjectGrades,
  type SubjectMarks,
} from '@rntps/shared';
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
  /**
   * Percentages, 0-100 with at most two decimals. Null means not recorded, not zero.
   *
   * Derived from `subjectMarks` and rewritten on every save — the teacher enters marks,
   * never a percentage. It is stored rather than computed on read because the gradebook
   * sorts on it, and because records written before subject-wise entry have nothing else:
   * for those, this is the only mark there is.
   */
  scores: ExamScores;
  /**
   * Marks obtained per subject, per paper, out of `MAX_SUBJECT_MARK[exam]` each.
   *
   * The source of truth. Which subjects are meaningful follows `classCodeSnapshot`, not
   * this document — every subject is present on every exam, and the ones the class does
   * not sit stay null. Absent entirely on records predating subject-wise entry, which is
   * exactly how those are recognised.
   */
  subjectMarks: ExamSubjectMarks;
  /**
   * Drawing, discipline and neatness, per paper — a letter, not a mark.
   *
   * Kept in their own subdocument rather than mixed into `subjectMarks`, so nothing that
   * walks the marked subjects can reach a grade. They never touch `scores`.
   */
  subjectGrades: ExamSubjectGrades;
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

/**
 * Whole marks, so no `max` here — the ceiling is per exam (20 or 80) and is enforced at the
 * zod boundary, where the rejection can name the subject it belongs to.
 *
 * Every subject defaults to null so a `$set` of the whole card writes a uniform shape
 * whatever the payload contained, and so clearing a subject stores the clearing rather
 * than leaving the old mark behind.
 */
const subjectMark = { type: Number, default: null, min: 0 };

const subjectMarksSchema = new Schema<SubjectMarks>(
  {
    ENGLISH: subjectMark,
    HINDI: subjectMark,
    MATHS: subjectMark,
    EVS: subjectMark,
    SCIENCE: subjectMark,
    GK: subjectMark,
    COMPUTER: subjectMark,
    SST: subjectMark,
  },
  { _id: false },
);

const paper = { type: subjectMarksSchema, default: () => ({}) };

const examSubjectMarksSchema = new Schema<ExamSubjectMarks>(
  {
    UT1: paper,
    UT2: paper,
    HALF_YEARLY: paper,
    UT3: paper,
    UT4: paper,
    FINAL: paper,
  },
  { _id: false },
);

/** Trimmed and length-capped at the zod boundary, where the message can name the subject. */
const grade = { type: String, default: null, trim: true };

const subjectGradesSchema = new Schema<SubjectGrades>(
  { DRAWING: grade, DISCIPLINE: grade, NEATNESS: grade },
  { _id: false },
);

const gradedPaper = { type: subjectGradesSchema, default: () => ({}) };

const examSubjectGradesSchema = new Schema<ExamSubjectGrades>(
  {
    UT1: gradedPaper,
    UT2: gradedPaper,
    HALF_YEARLY: gradedPaper,
    UT3: gradedPaper,
    UT4: gradedPaper,
    FINAL: gradedPaper,
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
    // Deliberately not required: a record written before subject-wise entry has none, and
    // a `.lean()` read returning it as undefined is how the service spots one.
    subjectMarks: { type: examSubjectMarksSchema },
    // Absent on records predating subject-wise entry, same as subjectMarks.
    subjectGrades: { type: examSubjectGradesSchema },
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
