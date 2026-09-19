import {
  EXAM_CODES,
  SUBJECT_LABELS,
  classLabel,
  GRADED_SUBJECT_CODES,
  buildCompactReportCardMessage,
  buildReportCardMessage,
  buildWaLink,
  emptyScores,
  emptySubjectGrades,
  emptySubjectMarks,
  examTotal,
  hasAnySubjectMark,
  subjectsForClass,
  type AcademicRow,
  type AcademicYearsResponse,
  type ClassCode,
  type ExamScores,
  type ExamSubjectGrades,
  type ExamSubjectMarks,
  type ExamCode,
  type ListAcademicsQuery,
  type ReportCardScope,
  type ReportCardWaLinkDto,
  type Paginated,
  type SaveExamResultPayload,
  type StudentAcademicsResponse,
  type StudentExamYear,
  type SubjectCode,
} from '@rntps/shared';
import { hasPaperContent, waUrlFits } from '@rntps/shared';
import { AppError } from '../../lib/AppError.js';
import { cardGuardianOf, pickReachableGuardian } from '../../lib/guardian.js';
import { getSettings } from '../../lib/ids.js';
import { ExamResult, examResultId, type ExamResultDoc } from '../../models/ExamResult.js';
import { Student, type StudentDoc } from '../../models/Student.js';

type RosterStudent = Pick<StudentDoc, '_id' | 'fullName' | 'classCode' | 'rollNo' | 'guardians'>;

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
 * The same flattening for subject marks, plus one thing toScores does not have to do:
 * a record written before subject-wise entry has no `subjectMarks` at all, and a `.lean()`
 * read does not apply the model's defaults, so it arrives as undefined rather than blank.
 */
function toSubjectMarks(marks: ExamSubjectMarks | undefined): ExamSubjectMarks {
  const blank = emptySubjectMarks();
  if (!marks) return blank;

  for (const exam of EXAM_CODES) {
    const paper = marks[exam];
    if (!paper) continue;
    for (const subject of Object.keys(blank[exam]) as SubjectCode[]) {
      blank[exam][subject] = paper[subject] ?? null;
    }
  }
  return blank;
}

/**
 * The same again for grades. Every class is graded on all three subjects, so unlike marks
 * there is no per-class list to project against.
 */
function toSubjectGrades(grades: ExamSubjectGrades | undefined): ExamSubjectGrades {
  const blank = emptySubjectGrades();
  if (!grades) return blank;

  for (const exam of EXAM_CODES) {
    const paper = grades[exam];
    if (!paper) continue;
    for (const subject of GRADED_SUBJECT_CODES) {
      blank[exam][subject] = paper[subject] ?? null;
    }
  }
  return blank;
}

/**
 * The student's class now, when it disagrees with the card's — and only when that
 * disagreement means something is wrong rather than something moved on.
 */
function mismatchedClass(
  isOpenSession: boolean,
  snapshot: ClassCode,
  live: ClassCode | undefined,
): string | null {
  if (!isOpenSession || !live || live === snapshot) return null;
  return live;
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
 * Students whose card for this session is filed under a class the caller is not looking at.
 *
 * Only the ids, because that is the whole question: *which* class it sits in is that
 * class's page to answer. It exists so the roster half of the union below can leave those
 * students out. They may well be on this class's roll — a child moved in November is
 * exactly that — but their marks are not, and a blank row here would offer a teacher a
 * card that `saveExamResult` will refuse, because the class that governs the save comes
 * from the snapshot rather than the roll.
 *
 * Nothing to ask when the caller is an admin looking at every class at once: no card can
 * be filed somewhere that is not already on the page.
 */
async function cardsFiledElsewhere(academicYear: string, scope?: string[]): Promise<Set<string>> {
  if (!scope) return new Set();
  const ids = await ExamResult.distinct('studentId', {
    academicYear,
    classCodeSnapshot: { $nin: scope },
  });
  return new Set(ids as string[]);
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
 * hundred lean documents. The attendance roster joins the same way. Which *class* the page
 * covers is not decided in memory, though — see below.
 */
export async function listAcademics(
  query: ListAcademicsQuery,
  allowedClasses?: string[],
): Promise<Paginated<AcademicRow>> {
  const settings = await getSettings();
  const academicYear = query.academicYear ?? settings.activeAcademicYear;

  /*
    Which classes this page may show: the one asked for, or — when none was — a teacher's
    own. Undefined is an admin looking at every class, which needs no filter at all.

    A classCode reaching here is one this caller may see either way: the route refuses a
    teacher who names a class they are not assigned to, rather than quietly emptying the
    page. So narrowing to it cannot widen anything.

    This is pushed into the two queries below rather than applied to the rows afterwards,
    which is where it used to live. Filtering in memory meant opening one class read every
    marks document in the school for the session and then discarded most of them — and
    left the second key of `{academicYear, classCodeSnapshot}` never once exercised by the
    query that index was added for.
  */
  const scope = query.classCode ? [query.classCode] : allowedClasses;

  const [records, filedElsewhere] = await Promise.all([
    ExamResult.find({
      academicYear,
      ...(scope ? { classCodeSnapshot: { $in: scope } } : {}),
    }).lean<ExamResultDoc[]>(),
    cardsFiledElsewhere(academicYear, scope),
  ]);

  /*
    Sequential rather than parallel, because this query needs the ids above.

    The union has to include students who are *not* on this session's roll but do have a
    record for it — the promoted and the departed — or a card printed for a closed session
    would have no guardian to name on it. The snapshots on the record carry the class and
    roll, but a guardian was never snapshotted and is read live. That second branch is why
    the class filter on the first one is safe: a student whose card is on this page is
    fetched by their card, whatever class they have since moved to.

    One session is a few hundred lean documents in a single school, so the extra round trip
    costs nothing worth restructuring for.
  */
  const students = await Student.find({
    $or: [
      { academicYear, status: 'ACTIVE', ...(scope ? { classCode: { $in: scope } } : {}) },
      { _id: { $in: records.map((r) => r.studentId) } },
    ],
  })
    .select('fullName classCode rollNo guardians')
    .lean<RosterStudent[]>();

  const studentById = new Map(students.map((s) => [s._id, s]));
  const withCard = new Set(records.map((r) => r.studentId));
  // Only the session in progress can be out of step. In a closed one the live class
  // differing from the snapshot is not a mistake, it is what the snapshot is for.
  const isOpenSession = academicYear === settings.activeAcademicYear;

  const byStudent = new Map<string, AcademicRow>();

  for (const student of students) {
    // A student with a card is described by their card, in the loop below — building a
    // blank row here first and overwriting it a moment later was two full sets of marks
    // and grades allocated per student to keep one. And a student whose card is filed
    // under another class belongs on that class's page, not on this one.
    if (withCard.has(student._id) || filedElsewhere.has(student._id)) continue;

    byStudent.set(student._id, {
      studentId: student._id,
      fullName: student.fullName,
      classCode: student.classCode,
      rollNo: student.rollNo,
      academicYear,
      scores: emptyScores(),
      subjectMarks: emptySubjectMarks(),
      subjectGrades: emptySubjectGrades(),
      guardian: cardGuardianOf(student.guardians),
      currentClassCode: null,
      hasRecord: false,
      updatedAt: null,
    });
  }

  for (const record of records) {
    const live = studentById.get(record.studentId);
    byStudent.set(record.studentId, {
      studentId: record.studentId,
      // A student still on the roll may have been renamed since; show the current name.
      fullName: live?.fullName ?? record.studentNameSnapshot,
      // The class and roll are the session's, so the snapshot wins over the live record.
      classCode: record.classCodeSnapshot,
      rollNo: record.rollNoSnapshot,
      academicYear,
      scores: toScores(record.scores),
      subjectMarks: toSubjectMarks(record.subjectMarks),
      subjectGrades: toSubjectGrades(record.subjectGrades),
      guardian: cardGuardianOf(live?.guardians),
      currentClassCode: mismatchedClass(isOpenSession, record.classCodeSnapshot, live?.classCode),
      hasRecord: true,
      updatedAt: record.updatedAt?.toISOString() ?? null,
    });
  }

  let rows = [...byStudent.values()];

  // Name and ID search stays here: it has to match the snapshot on an archived row as
  // readily as the live record on a current one, which is a property of the composed row
  // rather than of either collection.
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
  const student = await Student.findById(id)
    .select('_id fullName guardians')
    .lean<Pick<StudentDoc, '_id' | 'fullName' | 'guardians'>>();
  if (!student) throw AppError.notFound(`No student found with ID ${studentId}`);

  const records = await ExamResult.find({ studentId: id })
    .sort({ academicYear: -1 })
    .lean<ExamResultDoc[]>();

  const years: StudentExamYear[] = records.map((record) => ({
    academicYear: record.academicYear,
    classCode: record.classCodeSnapshot,
    rollNo: record.rollNoSnapshot,
    scores: toScores(record.scores),
    subjectMarks: toSubjectMarks(record.subjectMarks),
    subjectGrades: toSubjectGrades(record.subjectGrades),
    updatedAt: record.updatedAt?.toISOString() ?? null,
  }));

  return {
    studentId: id,
    fullName: student.fullName,
    guardian: cardGuardianOf(student.guardians),
    years,
  };
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
 * Rejects marks for subjects the class is not taught.
 *
 * Every save carries all eight subjects — the schema defaults the ones the form did not
 * render to null — so only a *non-null* mark for an out-of-list subject is an error.
 * Checking for presence instead would 400 every single save.
 *
 * Reported in the `{field, message}` shape `validate()` produces, so the edit dialog
 * highlights the offending input through the same mapper it uses for a zod error rather
 * than needing a special case for this one rule.
 */
function assertSubjectsMatchClass(subjectMarks: ExamSubjectMarks, classCode: ClassCode): void {
  const taught = new Set<SubjectCode>(subjectsForClass(classCode));
  const details: { field: string; message: string }[] = [];

  for (const exam of EXAM_CODES) {
    const paper = subjectMarks[exam];
    for (const [subject, mark] of Object.entries(paper) as [SubjectCode, number | null][]) {
      if (mark === null || taught.has(subject)) continue;
      details.push({
        field: `subjectMarks.${exam}.${subject}`,
        message: `${SUBJECT_LABELS[subject]} is not taught in ${classLabel(classCode)}`,
      });
    }
  }

  if (details.length > 0) {
    throw AppError.badRequest('Please correct the highlighted fields', details);
  }
}

/**
 * Works out the percentage for each paper.
 *
 * One rule: **once an exam has subject marks, its percentage is derived from subject marks
 * from then on; until then it keeps whatever percentage was already stored.**
 *
 * The second half is only there for records written before subject-wise entry, which hold
 * a percentage and nothing else. Without it, saving UT-2 on such a card would blank every
 * other paper on it, because there are no subject marks to re-derive them from.
 *
 * The first half is what stops that fallback becoming a trap. An exam whose stored marks
 * have all just been deleted is *still* subject-based, so it derives to null — the
 * clearing sticks. Were the rule written on the stored percentage alone, those two cases
 * would be indistinguishable and a mark could never be taken back off a card.
 */
function deriveScores(
  subjectMarks: ExamSubjectMarks,
  existing: ExamResultDoc | null,
  classCode: ClassCode,
): ExamScores {
  const scores = emptyScores();

  for (const exam of EXAM_CODES) {
    const subjectBased =
      hasAnySubjectMark(subjectMarks[exam], classCode) ||
      hasAnySubjectMark(existing?.subjectMarks?.[exam], classCode);

    scores[exam] = subjectBased
      ? (examTotal(subjectMarks[exam], classCode, exam)?.percent ?? null)
      : (existing?.scores?.[exam] ?? null);
  }

  return scores;
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
 *
 * That same class decides which subjects may be marked, and the percentages are derived
 * here rather than accepted from the caller — see `deriveScores` below.
 */
export async function saveExamResult(
  payload: SaveExamResultPayload,
  actor: Actor,
): Promise<AcademicRow> {
  // Settings joins the same round trip as the other two rather than preceding them: no
  // part of either query depends on it, so awaiting it first only bought a second wait.
  const [settings, student, existing] = await Promise.all([
    getSettings(),
    Student.findById(payload.studentId)
      .select('fullName classCode rollNo guardians')
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

  assertSubjectsMatchClass(payload.subjectMarks, classCode);
  const scores = deriveScores(payload.subjectMarks, existing, classCode);

  const rollNo = existing ? existing.rollNoSnapshot : student.rollNo;

  await ExamResult.updateOne(
    { _id: examResultId(payload.studentId, payload.academicYear) },
    {
      // A whole-object $set rather than a merge, so deleting a mark deletes it.
      $set: {
        subjectMarks: payload.subjectMarks,
        subjectGrades: payload.subjectGrades,
        scores,
        updatedBy: actor.id,
      },
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
    scores,
    subjectMarks: payload.subjectMarks,
    subjectGrades: payload.subjectGrades,
    guardian: cardGuardianOf(student.guardians),
    currentClassCode: mismatchedClass(
      payload.academicYear === settings.activeAcademicYear,
      classCode,
      student.classCode,
    ),
    hasRecord: true,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * A wa.me link carrying one student's report card for one session.
 *
 * The same shape as the invoice equivalent in `notifications.service`: the guardian, the
 * template and the length fitting are all decided server-side, so the browser only opens
 * the URL it is handed.
 *
 * Confined by class the way saving marks is, not left open the way reading a student's
 * history is. Reading a record is an internal act; sending a parent a message is not, and
 * a teacher should only be able to do it for the classes they teach. The class comes from
 * the stored snapshot, never from the request.
 */
export async function buildReportCardWaLink(
  studentId: string,
  academicYear: string,
  actor: Actor,
  exam?: ExamCode,
): Promise<ReportCardWaLinkDto> {
  const id = studentId.toUpperCase();

  const [settings, student, record] = await Promise.all([
    getSettings(),
    Student.findById(id).select('fullName guardians').lean<Pick<StudentDoc, '_id' | 'fullName' | 'guardians'>>(),
    ExamResult.findById(examResultId(id, academicYear)).lean<ExamResultDoc>(),
  ]);

  if (!student) throw AppError.notFound(`No student found with ID ${studentId}`);
  if (!record) {
    throw AppError.badRequest(`No marks are on record for ${student.fullName} in ${academicYear}`);
  }

  if (actor.role !== 'ADMIN' && !actor.classes.includes(record.classCodeSnapshot)) {
    throw AppError.forbidden(`You are not assigned to ${record.classCodeSnapshot}`);
  }

  const guardian = pickReachableGuardian(student.guardians);

  const input = {
    schoolName: settings.schoolName,
    schoolAddress: settings.schoolAddress,
    // The current name, like the gradebook: a child renamed since still gets their card.
    fullName: student.fullName,
    // Named on the message exactly as on the printed card.
    guardian: cardGuardianOf(student.guardians),
    classCode: record.classCodeSnapshot,
    rollNo: record.rollNoSnapshot,
    academicYear,
    subjectMarks: toSubjectMarks(record.subjectMarks),
    subjectGrades: toSubjectGrades(record.subjectGrades),
    scores: toScores(record.scores),
  };

  // A class-8 card with every paper and every subject overflows the URL once encoded, so
  // the breakdown is dropped rather than the tail of the message — which is where the
  // final exam sits.
  const scope: ReportCardScope = exam ?? null;
  if (scope !== null && !hasPaperContent(input, scope)) {
    throw AppError.badRequest(`Nothing is recorded for ${scope} in ${academicYear}`);
  }

  const full = buildReportCardMessage(input, scope);
  const compact = !waUrlFits(guardian.phone, full);
  const message = compact ? buildCompactReportCardMessage(input, scope) : full;

  return {
    guardianName: guardian.name,
    guardianPhone: guardian.phone,
    waLink: buildWaLink(guardian.phone, message),
    compact,
  };
}

/** Where a card is filed today, for the audit line the move is about to make stale. */
export async function getCardClass(
  studentId: string,
  academicYear: string,
): Promise<{ classCode: string; rollNo: number | null; scores: ExamScores } | undefined> {
  const record = await ExamResult.findById(examResultId(studentId.toUpperCase(), academicYear))
    .lean<ExamResultDoc>();
  if (!record) return undefined;
  return {
    classCode: record.classCodeSnapshot,
    rollNo: record.rollNoSnapshot,
    scores: toScores(record.scores),
  };
}

/**
 * Refiles a marks card under the class the student is actually in.
 *
 * The class snapshot is written once and never rewritten, which is right for a rollover —
 * without it, April would re-label every past year's marks with this year's class. It is
 * wrong for a correction: a child moved from class 1 to class 6 in November was *filed*
 * wrong, and their card goes on offering class-1 subjects and locking out the class-6
 * teacher until someone says so. The code cannot tell the two apart, so an admin does.
 *
 * Restricted to the session in progress. A closed year is history and stays frozen; the
 * only reason to move a card is that the student is still sitting papers in a new class.
 *
 * Marks are not deleted. A subject the new class does not sit simply stops being walked by
 * `examTotal()`, so it stops counting and stops showing — and moving the card back brings
 * it straight back. What *is* rewritten is the stored percentages, because the gradebook
 * renders those while the report card recomputes from the marks: leave them and the table
 * and the printed card would quietly disagree about the same child.
 */
export async function moveCardToCurrentClass(
  studentId: string,
  academicYear: string,
  actorId: string,
): Promise<AcademicRow> {
  const id = studentId.toUpperCase();

  // One round trip, for the reason given in `saveExamResult`.
  const [settings, student, record] = await Promise.all([
    getSettings(),
    Student.findById(id).select('fullName classCode rollNo guardians').lean<RosterStudent>(),
    ExamResult.findById(examResultId(id, academicYear)).lean<ExamResultDoc>(),
  ]);

  if (!student) throw AppError.notFound(`No student found with ID ${studentId}`);
  if (!record) {
    throw AppError.badRequest(`No marks are on record for ${student.fullName} in ${academicYear}`);
  }
  if (academicYear !== settings.activeAcademicYear) {
    throw AppError.badRequest(
      `Only the session in progress (${settings.activeAcademicYear}) can be refiled. ` +
        `${academicYear} is closed, and its marks belong to the class they were sat in.`,
    );
  }
  if (record.classCodeSnapshot === student.classCode) {
    throw AppError.badRequest(
      `This card is already filed under ${classLabel(student.classCode)}.`,
    );
  }

  const subjectMarks = toSubjectMarks(record.subjectMarks);
  // Recomputed against the new class, and *persisted* — including the nulls. A paper
  // marked only in a dropped subject derives to null here; leaving its old percentage
  // would make the next ordinary save treat it as a record predating subject-wise entry
  // and carry the stale figure forward with nothing on screen to back it.
  const scores = emptyScores();
  for (const exam of EXAM_CODES) {
    scores[exam] = examTotal(subjectMarks[exam], student.classCode, exam)?.percent ?? null;
  }

  await ExamResult.updateOne(
    { _id: examResultId(id, academicYear) },
    {
      $set: {
        classCodeSnapshot: student.classCode,
        rollNoSnapshot: student.rollNo,
        scores,
        updatedBy: actorId,
      },
    },
  );

  return {
    studentId: id,
    fullName: student.fullName,
    classCode: student.classCode,
    rollNo: student.rollNo,
    academicYear,
    scores,
    subjectMarks,
    subjectGrades: toSubjectGrades(record.subjectGrades),
    guardian: cardGuardianOf(student.guardians),
    currentClassCode: null,
    hasRecord: true,
    updatedAt: new Date().toISOString(),
  };
}
