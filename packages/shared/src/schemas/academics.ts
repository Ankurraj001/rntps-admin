import { z } from 'zod';
import {
  CLASS_CODES,
  EXAM_CODES,
  GRADED_SUBJECT_CODES,
  GRADE_MAX_LENGTH,
  MAX_SUBJECT_MARK,
  subjectsForClass,
  type ClassCode,
  type ExamCode,
  type GuardianRelation,
  type SubjectCode,
} from '../constants.js';
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
 * Null is a real value, not a missing one: it means "not sat / not recorded yet", which
 * is what the gradebook shows as a dash. It is distinct from 0, which is a real mark.
 *
 * This is no longer a *request* shape. A percentage is derived from subject marks by
 * `examTotal()` and written by the server, so there is no field anywhere a client can put
 * one in — a fabricated mark is structurally impossible rather than merely unvalidated.
 * The two-decimal cap stays because it still describes what may be stored, and the
 * derivation rounds to two decimals to satisfy it.
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
 * One subject's marks on one paper.
 *
 * Whole numbers only. A mark is a count of marks on an answer sheet, not a proportion, so
 * it takes the `.int()` rule every rupee amount takes — and takes it the same way, by
 * *rejecting* 17.5 rather than flooring it to 17. The derived percentage is the fractional
 * number here; the thing the teacher reads off the paper is not.
 *
 * `max` is per exam, not global: a unit test is out of 20 a subject and the half-yearly
 * and final are out of 80. Passing it in rather than checking it in a `superRefine` on the
 * whole card is what makes the error land on `subjectMarks.UT1.ENGLISH` — the exact input
 * to highlight — with no hand-built paths.
 *
 * Defaults to null rather than being optional so the parsed shape is total: every subject
 * of every exam is present as `number | null`, which keeps react-hook-form's `Path<>`,
 * `defaultValues` and `emptySubjectMarks()` all agreeing with each other.
 */
function subjectMarkField(max: number) {
  return z
    .number()
    .int('Enter a whole number')
    .min(0, 'A mark cannot be negative')
    .max(max, `This paper is out of ${max}`)
    .nullable()
    .default(null);
}

/**
 * All eight subjects, written out longhand for the same reason `examScoresSchema` is:
 * statically typed keys on both sides of the wire.
 *
 * Every class gets every key. Which subjects a class actually sits is decided by
 * `subjectsForClass()` against the class on the student record — never against anything in
 * the request — so it cannot be a property of this schema. See `saveExamResultSchema`.
 */
function subjectMarksSchema(max: number) {
  const mark = subjectMarkField(max);
  return z.object({
    ENGLISH: mark,
    HINDI: mark,
    MATHS: mark,
    EVS: mark,
    SCIENCE: mark,
    GK: mark,
    COMPUTER: mark,
    SST: mark,
  });
}

export const examSubjectMarksSchema = z.object({
  UT1: subjectMarksSchema(MAX_SUBJECT_MARK.UT1).default({}),
  UT2: subjectMarksSchema(MAX_SUBJECT_MARK.UT2).default({}),
  HALF_YEARLY: subjectMarksSchema(MAX_SUBJECT_MARK.HALF_YEARLY).default({}),
  UT3: subjectMarksSchema(MAX_SUBJECT_MARK.UT3).default({}),
  UT4: subjectMarksSchema(MAX_SUBJECT_MARK.UT4).default({}),
  FINAL: subjectMarksSchema(MAX_SUBJECT_MARK.FINAL).default({}),
});

/**
 * One graded subject on one paper.
 *
 * A grade is free text, not a number and not an enum: the school writes "A+", "B" or a
 * short word, and pinning that to a fixed list here would mean a schema change the first
 * time they want a new one. Trimmed, capped, and blank collapses to null so an emptied box
 * reads as "not graded" rather than as an empty grade.
 *
 * Upper-cased for the same reason `studentId` is: the field renders uppercase either way,
 * so without this two teachers typing "a" and "A" would store different grades that look
 * identical on every screen.
 *
 * Grades are stored apart from marks rather than alongside them because `examTotal()`
 * walks the marked subjects alone — keeping the two in separate objects is what makes it
 * impossible for a grade to reach the arithmetic at all.
 */
const gradeField = z
  .string()
  .trim()
  .toUpperCase()
  .max(GRADE_MAX_LENGTH, `Use at most ${GRADE_MAX_LENGTH} characters`)
  .nullable()
  .default(null)
  .transform((value) => (value === '' ? null : value));

/** All three graded subjects, longhand for the same reason the marked ones are. */
const subjectGradesSchema = z.object({
  DRAWING: gradeField,
  DISCIPLINE: gradeField,
  NEATNESS: gradeField,
});

export const examSubjectGradesSchema = z.object({
  UT1: subjectGradesSchema.default({}),
  UT2: subjectGradesSchema.default({}),
  HALF_YEARLY: subjectGradesSchema.default({}),
  UT3: subjectGradesSchema.default({}),
  UT4: subjectGradesSchema.default({}),
  FINAL: subjectGradesSchema.default({}),
});

/**
 * The whole card is saved at once, which is why there is no per-exam endpoint: the modal
 * edits every paper together and one document holds them all, so a save is a single write.
 *
 * There is deliberately no classCode here, and it now carries twice the weight it used to.
 * The class a mark belongs to is read from the student record (or from the stored snapshot
 * for a closed session), never from the request — otherwise a teacher could reach another
 * class by naming it in the body, which is exactly what requireClassAccess exists to
 * prevent elsewhere. That same class decides *which subjects are legal*, so the subject-set
 * check has to live in the service, after the student has been loaded, rather than here.
 *
 * Nor is there a percentage. It is derived from these marks server-side.
 */
export const saveExamResultSchema = z.object({
  studentId: z.string().trim().toUpperCase().min(1),
  academicYear: z.string().regex(ACADEMIC_YEAR_PATTERN, 'Use the form 2026-27'),
  subjectMarks: examSubjectMarksSchema,
  // Defaulted, so a caller with nothing to grade — a script, or the marks half of the
  // form alone — need not send the key. Marks stay required, because a save with no marks
  // key at all is far more likely to be a mistake than an intention to clear the card.
  subjectGrades: examSubjectGradesSchema.default({}),
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

export const reportCardParamsSchema = z.object({
  academicYear: z.string().regex(ACADEMIC_YEAR_PATTERN, 'Use the form 2026-27'),
});

/** Omitted means the whole session; a code narrows the card to that one paper. */
export const reportCardQuerySchema = z.object({
  exam: z.enum(EXAM_CODES).optional(),
});

export type ExamScores = z.output<typeof examScoresSchema>;
export type SubjectMarks = z.output<ReturnType<typeof subjectMarksSchema>>;
export type ExamSubjectMarks = z.output<typeof examSubjectMarksSchema>;
export type SubjectGrades = z.output<typeof subjectGradesSchema>;
export type ExamSubjectGrades = z.output<typeof examSubjectGradesSchema>;
export type SaveExamResultPayload = z.output<typeof saveExamResultSchema>;
export type ListAcademicsQuery = z.output<typeof listAcademicsQuerySchema>;

/** What a paper came to: marks scored, marks it was out of, and the percentage. */
export interface ExamTotal {
  obtained: number;
  max: number;
  percent: number;
}

/**
 * Adds up one paper.
 *
 * **A percentage counts only the subjects that were marked.** Two of a class's six papers
 * graded gives 34 out of 40, not 34 out of 120. That is the "blank is not zero" rule the
 * gradebook has always applied, carried one level down: a paper nobody has marked yet must
 * not drag a child's percentage toward zero while the rest of the pile is still unmarked.
 *
 * **Returns null, not a zero total, when nothing has been entered.** Callers lean on that
 * to tell "not sat" from "scored nothing", and `saveExamResult` uses it to decide whether
 * an exam is subject-based at all — a `{obtained: 0, max: 0}` object would be truthy and
 * would quietly break both. It is a contract, not an implementation detail.
 *
 * Subjects outside the class's list are ignored rather than counted, so a mark left behind
 * by a subject the class no longer sits cannot inflate a denominator.
 *
 * Rounded to two decimals, the same way `attendancePercentage()` rounds to one. The
 * integer intermediate keeps the result exactly representable, so the stored value still
 * satisfies `percentField`'s two-decimal check.
 */
export function examTotal(
  marks: SubjectMarks | undefined,
  classCode: ClassCode | string,
  exam: ExamCode,
): ExamTotal | null {
  if (!marks) return null;

  const perSubject = MAX_SUBJECT_MARK[exam];
  let obtained = 0;
  let max = 0;

  for (const subject of subjectsForClass(classCode)) {
    const mark = marks[subject];
    if (mark === null || mark === undefined) continue;
    obtained += mark;
    max += perSubject;
  }

  if (max === 0) return null;
  return { obtained, max, percent: Math.round((obtained / max) * 10_000) / 100 };
}

/**
 * True when a paper has at least one of the class's subjects marked on it.
 *
 * Restricted to the class's subject list on purpose: a leftover mark for a subject the
 * class no longer sits contributes nothing to the total, so letting it count here would
 * strand the exam as "subject-based" with a percentage of null forever.
 */
export function hasAnySubjectMark(
  marks: SubjectMarks | undefined,
  classCode: ClassCode | string,
): boolean {
  if (!marks) return false;
  return subjectsForClass(classCode).some(
    (subject) => marks[subject] !== null && marks[subject] !== undefined,
  );
}

/** The marks and grades of one session — the parts of a card that vary per paper. */
export interface ExamCardContent {
  classCode: string;
  subjectMarks: ExamSubjectMarks;
  subjectGrades: ExamSubjectGrades;
  scores: ExamScores;
}

/**
 * Whether a paper has anything on it at all — a mark, a grade, or a percentage carried
 * over from before subject-wise entry.
 *
 * One definition, because three places ask it and they must agree: the report card's paper
 * picker (which offers only papers worth printing), the WhatsApp builder (which skips
 * empty papers) and the API (which refuses to send a card with nothing on it). If the
 * picker offered a paper the builder then skipped, the message would arrive blank.
 */
export function hasPaperContent(card: ExamCardContent, exam: ExamCode): boolean {
  if (examTotal(card.subjectMarks[exam], card.classCode, exam) !== null) return true;
  if (card.scores[exam] !== null) return true;
  return GRADED_SUBJECT_CODES.some((subject) => card.subjectGrades[exam][subject] !== null);
}

/** Blank scores, used wherever a student has no record for a session yet. */
export function emptyScores(): ExamScores {
  return { UT1: null, UT2: null, HALF_YEARLY: null, UT3: null, UT4: null, FINAL: null };
}

function blankSubjects(): SubjectMarks {
  return {
    ENGLISH: null,
    HINDI: null,
    MATHS: null,
    EVS: null,
    SCIENCE: null,
    GK: null,
    COMPUTER: null,
    SST: null,
  };
}

/** A blank card, for a student with no marks on record for a session. */
export function emptySubjectMarks(): ExamSubjectMarks {
  return {
    UT1: blankSubjects(),
    UT2: blankSubjects(),
    HALF_YEARLY: blankSubjects(),
    UT3: blankSubjects(),
    UT4: blankSubjects(),
    FINAL: blankSubjects(),
  };
}

function blankGrades(): SubjectGrades {
  return { DRAWING: null, DISCIPLINE: null, NEATNESS: null };
}

/** A blank set of grades, for a student with none on record for a session. */
export function emptySubjectGrades(): ExamSubjectGrades {
  return {
    UT1: blankGrades(),
    UT2: blankGrades(),
    HALF_YEARLY: blankGrades(),
    UT3: blankGrades(),
    UT4: blankGrades(),
    FINAL: blankGrades(),
  };
}

/**
 * The card as this class sits it: marks for subjects it does not are blanked.
 *
 * Used to seed the edit form. React-hook-form submits its `defaultValues` whether or not a
 * field was ever rendered, so a stale mark for a subject the class has since stopped
 * sitting would be posted back invisibly and rejected by the service — an error on an
 * input that is not on screen. Projecting the defaults first means the form can only send
 * what the class is actually marked on.
 */
export function subjectMarksForClass(
  marks: ExamSubjectMarks | undefined,
  classCode: ClassCode | string,
): ExamSubjectMarks {
  const allowed = new Set<SubjectCode>(subjectsForClass(classCode));
  const card = emptySubjectMarks();
  if (!marks) return card;

  for (const exam of EXAM_CODES) {
    for (const subject of allowed) {
      card[exam][subject] = marks[exam]?.[subject] ?? null;
    }
  }
  return card;
}

/**
 * One row of the gradebook.
 *
 * classCode and rollNo are what the student had *for that session*, not what they have
 * today — after a rollover the live record has moved up a class and lost its roll number,
 * so a closed session reads them back from the snapshot on the marks document. classCode
 * therefore also decides which subjects the edit dialog offers, which is what keeps the
 * form in step with what the service will accept.
 */
export interface AcademicRow {
  studentId: string;
  fullName: string;
  classCode: string;
  rollNo: number | null;
  academicYear: string;
  /** Percentages. Derived from subjectMarks, except on records predating subject-wise entry. */
  scores: ExamScores;
  subjectMarks: ExamSubjectMarks;
  /** Drawing, discipline and neatness — reported, never counted. */
  subjectGrades: ExamSubjectGrades;
  /** Named on the printed card. Null when the student has no guardian on record. */
  guardian: CardGuardian | null;
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
  subjectMarks: ExamSubjectMarks;
  subjectGrades: ExamSubjectGrades;
  updatedAt: string | null;
}

export interface StudentAcademicsResponse {
  studentId: string;
  /** The current name — a report card is handed to a parent, who reads a name, not an ID. */
  fullName: string;
  guardian: CardGuardian | null;
  years: StudentExamYear[];
}

/**
 * The parent named on a report card: the father where there is one, else whoever else is
 * on record. The relation travels with the name so the card can label the row honestly.
 */
export interface CardGuardian {
  name: string;
  relation: GuardianRelation;
}

/** A wa.me link carrying one student's report card, addressed to the reachable guardian. */
export interface ReportCardWaLinkDto {
  guardianName: string;
  guardianPhone: string;
  waLink: string;
  /** True when the subject breakdown had to be dropped to fit the URL. */
  compact: boolean;
}

/** Populates the session dropdown: every session with marks, plus the one in progress. */
export interface AcademicYearsResponse {
  years: string[];
  activeAcademicYear: string;
}
