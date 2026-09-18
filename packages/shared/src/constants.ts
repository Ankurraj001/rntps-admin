/** The school's fixed class list. There are no sections. */
export const CLASS_CODES = [
  'NURSERY',
  'LKG',
  'UKG',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
] as const;

export type ClassCode = (typeof CLASS_CODES)[number];

/** Display label for a class code, e.g. "5" -> "Class 5". */
export function classLabel(code: ClassCode | string): string {
  switch (code) {
    case 'NURSERY':
      return 'Nursery';
    case 'LKG':
      return 'LKG';
    case 'UKG':
      return 'UKG';
    default:
      return `Class ${code}`;
  }
}

/**
 * The teacher roster, as selected in the attendance dropdown.
 *
 * Deliberately NOT a member of CLASS_CODES. Teachers are not a class, and that list is
 * load-bearing well beyond attendance: `nextClassCode` below is index-based over it, so an
 * extra member would promote class 8 into this instead of graduating it to alumni, and every
 * `z.enum(CLASS_CODES)` — student records, fee structures, invoice runs — would start
 * accepting it.
 */
export const TEACHERS_SCOPE = 'TEACHERS' as const;

/**
 * Label for whatever the attendance dropdown is on: a class, or the teacher roster.
 *
 * `classLabel` falls through to `Class ${code}` for anything it does not recognise, which
 * would render the teacher roster as "Class TEACHERS".
 */
export function attendanceScopeLabel(scope: string): string {
  return scope === TEACHERS_SCOPE ? 'Teachers' : classLabel(scope);
}

/**
 * Ordered promotion map used at year rollover. Class 8 is the terminal class —
 * those students become alumni rather than moving up.
 */
export function nextClassCode(code: ClassCode): ClassCode | null {
  const index = CLASS_CODES.indexOf(code);
  if (index === -1 || index === CLASS_CODES.length - 1) return null;
  return CLASS_CODES[index + 1] ?? null;
}

export const STUDENT_STATUSES = ['ACTIVE', 'INACTIVE', 'TC_ISSUED', 'ALUMNI'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;
export type Gender = (typeof GENDERS)[number];

export const GUARDIAN_RELATIONS = ['FATHER', 'MOTHER', 'GUARDIAN'] as const;
export type GuardianRelation = (typeof GUARDIAN_RELATIONS)[number];

/**
 * How a guardian is named on a document handed to a family, e.g. a report card.
 *
 * The relation is carried rather than assumed: a report card traditionally says "Father's
 * Name", but a child whose record has only a mother or a guardian must not have that row
 * mislabelled on the card they take home.
 */
/** Just the relation, for a line that already reads as a label, e.g. "Father: Rajesh". */
export const GUARDIAN_LABELS: Record<GuardianRelation, string> = {
  FATHER: 'Father',
  MOTHER: 'Mother',
  GUARDIAN: 'Guardian',
};

export const GUARDIAN_NAME_LABELS: Record<GuardianRelation, string> = {
  FATHER: "Father's Name",
  MOTHER: "Mother's Name",
  GUARDIAN: "Guardian's Name",
};

export const CONCESSION_TYPES = ['NONE', 'PERCENT', 'FLAT'] as const;
export type ConcessionType = (typeof CONCESSION_TYPES)[number];

export const USER_ROLES = ['ADMIN', 'TEACHER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Three states, deliberately. A child was either in school or not; a holiday is not a
 * school day at all. Finer grades — late, on leave — asked the teacher marking 30 names
 * to make a judgement call every morning, and nothing downstream treated them
 * differently from present or absent anyway.
 */
export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'HOLIDAY'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_LABELS: Record<AttendanceStatus, string> = {
  PRESENT: 'Present',
  ABSENT: 'Absent',
  HOLIDAY: 'Holiday',
};

/** Single letter used in the dense monthly grid. */
export const ATTENDANCE_SHORT: Record<AttendanceStatus, string> = {
  PRESENT: 'P',
  ABSENT: 'A',
  HOLIDAY: 'H',
};

/** Counts toward the attendance percentage numerator. */
export function countsAsPresent(status: AttendanceStatus): boolean {
  return status === 'PRESENT';
}

/** Holidays are excluded from the denominator — they are not working days. */
export function countsAsWorkingDay(status: AttendanceStatus): boolean {
  return status !== 'HOLIDAY';
}

export const INVOICE_STATUSES = ['DUE', 'PARTIAL', 'PAID', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * How an invoice came to exist.
 *
 * MONTHLY invoices come from the fee-structure run and are keyed `{studentId}:{period}`,
 * which is what makes billing a class twice for one month structurally impossible.
 * ADHOC invoices are raised by hand for one student — an opening balance, an exam fee, a
 * fine — and carry their own key, so a student can have several in the same month.
 *
 * The distinction is load-bearing: the monthly run asks "has this student been invoiced
 * for this period?" and must count only MONTHLY invoices. Counting an ad-hoc fine would
 * make the run skip that student and silently never bill their tuition.
 */
export const INVOICE_KINDS = ['MONTHLY', 'ADHOC'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const PAYMENT_MODES = ['CASH', 'UPI', 'CHEQUE', 'BANK'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CHEQUE: 'Cheque',
  BANK: 'Bank transfer',
};

/** Which students a fee head applies to. */
export const FEE_HEAD_SCOPES = ['ALL', 'TRANSPORT_OPTED'] as const;
export type FeeHeadScope = (typeof FEE_HEAD_SCOPES)[number];

/**
 * The school's fixed exam list, in the order they are sat and the order the gradebook
 * shows them. Unit tests bracket the two big papers: UT-1 and UT-2 before the half-yearly,
 * UT-3 and UT-4 before the final.
 *
 * Array order is load-bearing twice over — it is the column order on the Academics page,
 * and `EXAM_CODES` is what `z.enum()` accepts, so a code removed here stops validating
 * anywhere a mark is saved.
 */
export const EXAM_CODES = ['UT1', 'UT2', 'HALF_YEARLY', 'UT3', 'UT4', 'FINAL'] as const;
export type ExamCode = (typeof EXAM_CODES)[number];

export const EXAM_LABELS: Record<ExamCode, string> = {
  UT1: 'UT-1',
  UT2: 'UT-2',
  HALF_YEARLY: 'Half-Yearly',
  UT3: 'UT-3',
  UT4: 'UT-4',
  FINAL: 'Final',
};

/**
 * The subjects a class is **marked** on, in the order they appear on the mark sheet.
 * Graded subjects are a separate list — see `GRADED_SUBJECT_CODES` below.
 *
 * `SST` is the code and `S.St` only the label, which looks like a typo until you try the
 * obvious thing: a dot in the code would be rejected outright. `rejectMongoOperators`
 * refuses any request key containing `.` or `$` at any depth, and react-hook-form reads a
 * dot as a path separator, so `subjectMarks.UT1.S.St` is unroutable on both sides of the
 * wire. Same code/label split `EXAM_CODES` and `EXAM_LABELS` already use.
 */
export const SUBJECT_CODES = [
  'ENGLISH',
  'HINDI',
  'MATHS',
  'EVS',
  'SCIENCE',
  'GK',
  'COMPUTER',
  'SST',
] as const;
export type SubjectCode = (typeof SUBJECT_CODES)[number];

/**
 * The subjects carrying a grade rather than a mark, and the reason there are two lists.
 *
 * Drawing, discipline and neatness are reported as a letter — there is no paper out of 20
 * to add up, and averaging a child's neatness into their percentage would be nonsense. So
 * they are deliberately *not* members of `SUBJECT_CODES`: `examTotal()` walks the marked
 * list alone, which makes "a grade cannot move the percentage" structural rather than a
 * rule someone has to remember.
 *
 * Every class is graded on all three, so unlike `SUBJECTS_BY_CLASS` there is nothing to
 * look up per class.
 */
export const GRADED_SUBJECT_CODES = ['DRAWING', 'DISCIPLINE', 'NEATNESS'] as const;
export type GradedSubjectCode = (typeof GRADED_SUBJECT_CODES)[number];

/** How long a grade may be. Room for "A+" or a short word, not a remark. */
export const GRADE_MAX_LENGTH = 10;

export const SUBJECT_LABELS: Record<SubjectCode | GradedSubjectCode, string> = {
  ENGLISH: 'English',
  HINDI: 'Hindi',
  MATHS: 'Maths',
  EVS: 'EVS',
  SCIENCE: 'Science',
  GK: 'GK',
  COMPUTER: 'Computer',
  SST: 'S.St',
  DRAWING: 'Drawing',
  DISCIPLINE: 'Discipline',
  NEATNESS: 'Neatness',
};

/**
 * Which subjects each class is marked on — the ones a percentage is derived from. Array
 * order is the field order in the edit dialog and the row order on a report card.
 *
 * Treat this as append-only for a class that already has marks on record. A percentage is
 * derived from the subjects a paper was marked on, so dropping a subject from a class
 * silently changes what every *closed* session recomputes to — the stored percentage would
 * still include it while the recomputed one would not.
 */
export const SUBJECTS_BY_CLASS: Record<ClassCode, readonly SubjectCode[]> = {
  NURSERY: ['ENGLISH', 'HINDI', 'MATHS'],
  LKG: ['ENGLISH', 'HINDI', 'MATHS'],
  UKG: ['ENGLISH', 'HINDI', 'MATHS', 'GK'],
  '1': ['ENGLISH', 'HINDI', 'MATHS', 'EVS', 'GK', 'COMPUTER'],
  '2': ['ENGLISH', 'HINDI', 'MATHS', 'EVS', 'GK', 'COMPUTER'],
  '3': ['ENGLISH', 'HINDI', 'MATHS', 'EVS', 'GK', 'COMPUTER'],
  '4': ['ENGLISH', 'HINDI', 'MATHS', 'EVS', 'GK', 'COMPUTER'],
  '5': ['ENGLISH', 'HINDI', 'MATHS', 'EVS', 'GK', 'COMPUTER'],
  '6': ['ENGLISH', 'HINDI', 'MATHS', 'SCIENCE', 'GK', 'COMPUTER', 'SST'],
  '7': ['ENGLISH', 'HINDI', 'MATHS', 'SCIENCE', 'GK', 'COMPUTER', 'SST'],
  '8': ['ENGLISH', 'HINDI', 'MATHS', 'SCIENCE', 'GK', 'COMPUTER', 'SST'],
};

/**
 * The subjects a class sits, or none for a code that is not a class.
 *
 * Takes a loose string for the same reason `classLabel` does: callers hold a `classCode`
 * off a stored snapshot, which is typed as a plain string once it has been through Mongo.
 */
export function subjectsForClass(code: ClassCode | string): readonly SubjectCode[] {
  return SUBJECTS_BY_CLASS[code as ClassCode] ?? [];
}

/**
 * What **one subject's** paper is out of, per exam — not what the exam is out of.
 *
 * A unit test is 20 marks a subject and the two big papers are 80, so a class-6 final is
 * out of 560 across its seven subjects. Named for the subject deliberately: reading this
 * as the exam total and dividing by 80 is the one arithmetic error this table invites.
 */
export const MAX_SUBJECT_MARK: Record<ExamCode, number> = {
  UT1: 20,
  UT2: 20,
  HALF_YEARLY: 80,
  UT3: 20,
  UT4: 20,
  FINAL: 80,
};
