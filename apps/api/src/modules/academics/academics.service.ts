import {
  emptyScores,
  type AcademicRow,
  type AcademicYearsResponse,
  type ClassCode,
  type ExamScores,
  type ListAcademicsQuery,
  type Paginated,
  type SaveExamResultPayload,
  type StudentAcademicsResponse,
  type StudentExamYear,
} from '@rntps/shared';
import { AppError } from '../../lib/AppError.js';
import { getSettings } from '../../lib/ids.js';
import { ExamResult, examResultId, type ExamResultDoc } from '../../models/ExamResult.js';
import { Student, type StudentDoc } from '../../models/Student.js';

type RosterStudent = Pick<StudentDoc, '_id' | 'fullName' | 'classCode' | 'rollNo'>;

/** The caller, as far as this module is concerned: a role and the classes they may touch. */
export interface Actor {
  id: string;
  role: string;
  classes: string[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mongoose returns the scores subdocument with its own machinery attached; flatten it. */
function toScores(scores: ExamScores | undefined): ExamScores {
  const blank = emptyScores();
  if (!scores) return blank;
  return {
    UT1: scores.UT1 ?? null,
    UT2: scores.UT2 ?? null,
    HALF_YEARLY: scores.HALF_YEARLY ?? null,
    UT3: scores.UT3 ?? null,
    UT4: scores.UT4 ?? null,
    FINAL: scores.FINAL ?? null,
  };
}

/**
 * Roll number first where present, then name — the order a paper register uses, and the
 * same tie-break the attendance roster applies.
 */
function byRollThenName(a: AcademicRow, b: AcademicRow): number {
  if (a.rollNo !== null && b.rollNo !== null && a.rollNo !== b.rollNo) return a.rollNo - b.rollNo;
  if (a.rollNo !== null && b.rollNo === null) return -1;
  if (a.rollNo === null && b.rollNo !== null) return 1;
  return a.fullName.localeCompare(b.fullName);
}

/**
 * Sorts the gradebook.
 *
 * Unmarked students always sort last, in *both* directions. Treating a missing mark as 0
 * would bury the whole class at the bottom of an ascending sort and put them above the
 * top scorers descending; either way the answer to "who did worst in UT-1" would be
 * students who have not sat it. So the comparison is between recorded marks only, and
 * everything unrecorded falls to the end where it reads as work still to do.
 */
function sortRows(rows: AcademicRow[], sort: ListAcademicsQuery['sort'], order: 'asc' | 'desc'): AcademicRow[] {
  const direction = order === 'desc' ? -1 : 1;

  if (sort === 'fullName') {
    return rows.sort((a, b) => direction * a.fullName.localeCompare(b.fullName));
  }

  if (sort === 'rollNo') {
    // Register order is the natural default, so descending simply reverses it.
    return rows.sort((a, b) => direction * byRollThenName(a, b));
  }

  return rows.sort((a, b) => {
    const left = a.scores[sort];
    const right = b.scores[sort];
    if (left === null && right === null) return byRollThenName(a, b);
    if (left === null) return 1;
    if (right === null) return -1;
    if (left === right) return byRollThenName(a, b);
    return direction * (left - right);
  });
}

/**
 * The gradebook for one session.
 *
 * Rows are the union of two sources, keyed by studentId:
 *
 *   - students enrolled in that session, which supplies everyone who *should* have marks
 *     even if none are recorded yet — that is what makes the page a class list to fill in
 *     rather than a list of what happens to be saved already;
 *   - the marks documents for that session, which supply the scores.
 *
 * One code path covers both the open session and a closed one. During the session the
 * union is effectively the current roll. After a rollover, every student's academicYear
 * has been rewritten to the new session, so the roster half of the union finds nobody and
 * the archive half answers entirely from its snapshots — which is precisely why the
 * snapshots exist.
 *
 * Composed in memory rather than in an aggregation because the two sources cannot be
 * sorted together in the database, and this is a single school: one session is a few
 * hundred lean documents. The attendance roster joins the same way.
 */
export async function listAcademics(
  query: ListAcademicsQuery,
  allowedClasses?: string[],
): Promise<Paginated<AcademicRow>> {
  const settings = await getSettings();
  const academicYear = query.academicYear ?? settings.activeAcademicYear;

  const [students, records] = await Promise.all([
    Student.find({ academicYear, status: 'ACTIVE' })
      .select('fullName classCode rollNo')
      .lean<RosterStudent[]>(),
    ExamResult.find({ academicYear }).lean<ExamResultDoc[]>(),
  ]);

  const byStudent = new Map<string, AcademicRow>();

  for (const student of students) {
    byStudent.set(student._id, {
      studentId: student._id,
      fullName: student.fullName,
      classCode: student.classCode,
      rollNo: student.rollNo,
      academicYear,
      scores: emptyScores(),
      hasRecord: false,
      updatedAt: null,
    });
  }

  for (const record of records) {
    const enrolled = byStudent.get(record.studentId);
    byStudent.set(record.studentId, {
      studentId: record.studentId,
      // A student still on the roll may have been renamed since; show the current name.
      fullName: enrolled?.fullName ?? record.studentNameSnapshot,
      // The class and roll are the session's, so the snapshot wins over the live record.
      classCode: record.classCodeSnapshot,
      rollNo: record.rollNoSnapshot,
      academicYear,
      scores: toScores(record.scores),
      hasRecord: true,
      updatedAt: record.updatedAt?.toISOString() ?? null,
    });
  }

  let rows = [...byStudent.values()];

  // A teacher sees only their own classes, whether or not they named one.
  if (allowedClasses) {
    const allowed = new Set(allowedClasses);
    rows = rows.filter((row) => allowed.has(row.classCode));
  }
  if (query.classCode) {
    rows = rows.filter((row) => row.classCode === query.classCode);
  }
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), 'i');
    rows = rows.filter((row) => pattern.test(row.fullName) || pattern.test(row.studentId));
  }

  const total = rows.length;
  const start = (query.page - 1) * query.limit;
  const items = sortRows(rows, query.sort, query.order).slice(start, start + query.limit);

  return {
    items,
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

/** Every session on record for one student, newest first. */
export async function getStudentAcademics(studentId: string): Promise<StudentAcademicsResponse> {
  const id = studentId.toUpperCase();
  const student = await Student.findById(id).select('_id').lean<Pick<StudentDoc, '_id'>>();
  if (!student) throw AppError.notFound(`No student found with ID ${studentId}`);

  const records = await ExamResult.find({ studentId: id })
    .sort({ academicYear: -1 })
    .lean<ExamResultDoc[]>();

  const years: StudentExamYear[] = records.map((record) => ({
    academicYear: record.academicYear,
    classCode: record.classCodeSnapshot,
    rollNo: record.rollNoSnapshot,
    scores: toScores(record.scores),
    updatedAt: record.updatedAt?.toISOString() ?? null,
  }));

  return { studentId: id, years };
}

/**
 * Sessions the year dropdown should offer: everything with marks on record, plus the one
 * in progress so a fresh install has something to select.
 */
export async function listAcademicYears(): Promise<AcademicYearsResponse> {
  const settings = await getSettings();
  const stored = await ExamResult.distinct('academicYear');
  const years = [...new Set([...(stored as string[]), settings.activeAcademicYear])].sort().reverse();
  return { years, activeAcademicYear: settings.activeAcademicYear };
}

/**
 * Saves one student's marks for one session.
 *
 * A single keyed upsert, so re-saving a corrected card simply overwrites and there is no
 * "already entered" special case — the same mechanism the attendance roster uses.
 *
 * Two rules worth stating:
 *
 * The class that governs access comes from the stored snapshot if there is one and from
 * the student record otherwise — never from the request. A classCode in the body would be
 * a way for a teacher to claim a class they are not assigned to, which is the exact
 * bypass requireClassAccess exists to close on every other route.
 *
 * A *new* card can only be opened for the session in progress. There is no sound class
 * snapshot for a session the student was not in — the live record has already moved on —
 * so rather than guessing one and filing the marks under the wrong class, it is refused.
 * An existing card stays correctable in any session, which is what makes a genuine
 * mistake in a closed year fixable.
 */
export async function saveExamResult(
  payload: SaveExamResultPayload,
  actor: Actor,
): Promise<AcademicRow> {
  const settings = await getSettings();

  const [student, existing] = await Promise.all([
    Student.findById(payload.studentId)
      .select('fullName classCode rollNo')
      .lean<RosterStudent>(),
    ExamResult.findById(examResultId(payload.studentId, payload.academicYear)).lean<ExamResultDoc>(),
  ]);

  if (!student) throw AppError.notFound(`No student found with ID ${payload.studentId}`);

  if (!existing && payload.academicYear !== settings.activeAcademicYear) {
    throw AppError.badRequest(
      `Marks can only be entered for the session in progress (${settings.activeAcademicYear}). ` +
        `${payload.academicYear} has no record for this student to correct.`,
    );
  }

  const classCode: ClassCode = existing?.classCodeSnapshot ?? student.classCode;
  if (actor.role !== 'ADMIN' && !actor.classes.includes(classCode)) {
    throw AppError.forbidden(`You are not assigned to ${classCode}`);
  }

  const rollNo = existing ? existing.rollNoSnapshot : student.rollNo;

  await ExamResult.updateOne(
    { _id: examResultId(payload.studentId, payload.academicYear) },
    {
      $set: { scores: payload.scores, updatedBy: actor.id },
      // Written once. A later correction must not rewrite the class a student sat in.
      $setOnInsert: {
        studentId: payload.studentId,
        academicYear: payload.academicYear,
        studentNameSnapshot: student.fullName,
        classCodeSnapshot: classCode,
        rollNoSnapshot: student.rollNo,
      },
    },
    { upsert: true },
  );

  return {
    studentId: payload.studentId,
    fullName: student.fullName,
    classCode,
    rollNo,
    academicYear: payload.academicYear,
    scores: payload.scores,
    hasRecord: true,
    updatedAt: new Date().toISOString(),
  };
}
