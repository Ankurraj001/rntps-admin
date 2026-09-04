import {
  ATTENDANCE_STATUSES,
  SUNDAY_HOLIDAY_LABEL,
  attendancePercentage,
  countsAsWorkingDay,
  isSunday,
  toDateKey,
  type AttendanceDefaulter,
  type AttendanceStatus,
  type AttendanceTotals,
  type ClassCode,
  type MonthlyResponse,
  type MonthlyRow,
  type RosterResponse,
  type SaveRosterPayload,
} from '@rntps/shared';
import { AppError } from '../../lib/AppError.js';
import { dateKeysInMonth, monthBounds } from '../../lib/dateRange.js';
import { getSettings } from '../../lib/ids.js';
import { Attendance, attendanceId, type AttendanceDoc } from '../../models/Attendance.js';
import { Student, type StudentDoc } from '../../models/Student.js';

type RosterStudent = Pick<StudentDoc, '_id' | 'fullName' | 'rollNo'>;

/** Roll number first where present, then name — the order a paper register uses. */
function byRollThenName(a: RosterStudent, b: RosterStudent): number {
  if (a.rollNo !== null && b.rollNo !== null) return a.rollNo - b.rollNo;
  if (a.rollNo !== null) return -1;
  if (b.rollNo !== null) return 1;
  return a.fullName.localeCompare(b.fullName);
}

async function activeStudentsIn(classCode: ClassCode): Promise<RosterStudent[]> {
  const students = await Student.find({ classCode, status: 'ACTIVE' })
    .select('fullName rollNo')
    .lean<RosterStudent[]>();
  return students.sort(byRollThenName);
}

export async function getRoster(classCode: ClassCode, dateKey: string): Promise<RosterResponse> {
  const settings = await getSettings();
  const [students, existing] = await Promise.all([
    activeStudentsIn(classCode),
    Attendance.find({ classCode, dateKey }).lean<AttendanceDoc[]>(),
  ]);

  const marks = new Map(existing.map((record) => [record.studentId, record]));
  const sunday = isSunday(dateKey);
  const holiday = holidayFor(dateKey, settings.holidays);

  // The most recently marked record stands in for "who submitted this roster".
  const latest = existing.reduce<AttendanceDoc | null>(
    (newest, record) => (!newest || record.markedAt > newest.markedAt ? record : newest),
    null,
  );

  return {
    classCode,
    dateKey,
    holiday,
    isSunday: sunday,
    isFuture: dateKey > toDateKey(),
    submittedAt: latest?.markedAt.toISOString() ?? null,
    submittedBy: latest?.markedBy ?? null,
    entries: students.map((student) => {
      const mark = marks.get(student._id);
      return {
        studentId: student._id,
        fullName: student.fullName,
        rollNo: student.rollNo,
        // On a Sunday the stored value is irrelevant — the day is a holiday for everyone.
        status: sunday ? ('HOLIDAY' as const) : (mark?.status ?? null),
        remarks: sunday ? '' : (mark?.remarks ?? ''),
      };
    }),
  };
}

/**
 * Saves a class's roster for a day.
 *
 * One bulkWrite of keyed upserts: re-submitting simply overwrites, so correcting a day
 * is safe and needs no "already submitted" special case.
 */
export async function saveRoster(
  payload: SaveRosterPayload,
  markedBy: string,
): Promise<{ saved: number; dateKey: string }> {
  if (payload.dateKey > toDateKey()) {
    throw AppError.badRequest('Attendance cannot be marked for a future date');
  }
  // Refused rather than accepted-and-ignored. Sundays read as a holiday whatever is
  // stored, so saving marks here would look like it worked and silently mean nothing.
  if (isSunday(payload.dateKey)) {
    throw AppError.badRequest('Sunday is a holiday — attendance is not marked');
  }

  const roll = await activeStudentsIn(payload.classCode);
  const allowed = new Set(roll.map((student) => student._id));

  // A student in the payload who is not on this class's roll is a bug or a tampered
  // request; either way it must not silently write attendance to another class.
  const stray = payload.marks.filter((mark) => !allowed.has(mark.studentId));
  if (stray.length > 0) {
    throw AppError.badRequest(
      `These students are not on the ${payload.classCode} roll: ${stray.map((s) => s.studentId).join(', ')}`,
    );
  }

  const markedAt = new Date();
  const operations = payload.marks.map((mark) => ({
    updateOne: {
      filter: { _id: attendanceId(mark.studentId, payload.dateKey) },
      update: {
        $set: {
          studentId: mark.studentId,
          classCode: payload.classCode,
          dateKey: payload.dateKey,
          status: mark.status,
          remarks: mark.remarks,
          markedBy,
          markedAt,
        },
      },
      upsert: true,
    },
  }));

  await Attendance.bulkWrite(operations, { ordered: false });
  return { saved: operations.length, dateKey: payload.dateKey };
}

export function emptyTotals(): AttendanceTotals {
  return { present: 0, absent: 0, holiday: 0, workingDays: 0, percentage: 0 };
}

export function addToTotals(totals: AttendanceTotals, status: AttendanceStatus): void {
  switch (status) {
    case 'PRESENT':
      totals.present += 1;
      break;
    case 'ABSENT':
      totals.absent += 1;
      break;
    case 'HOLIDAY':
      totals.holiday += 1;
      break;
  }
  if (countsAsWorkingDay(status)) totals.workingDays += 1;
}

/**
 * The holiday covering one day, if any.
 *
 * A Sunday is a holiday without anyone declaring it, and wins over a declared one. Derived
 * rather than stored, so the rule holds for every past date as well and there is nothing to
 * backfill. Shared with the teacher roster, which follows the same calendar.
 */
export function holidayFor(
  dateKey: string,
  declared: { dateKey: string; label: string }[],
): { dateKey: string; label: string } | null {
  if (isSunday(dateKey)) return { dateKey, label: SUNDAY_HOLIDAY_LABEL };
  return declared.find((holiday) => holiday.dateKey === dateKey) ?? null;
}

/**
 * dateKey -> holiday label for a month: every Sunday, then any declared school holiday.
 *
 * Sundays are derived rather than stored, so the rule reaches every past date with no
 * backfill. Declared holidays are applied second so a named holiday that lands on a Sunday
 * shows its own label. Shared with the teacher grid, which follows the same calendar.
 */
export function holidayMapFor(
  dateKeys: string[],
  declared: { dateKey: string; label: string }[],
): Record<string, string> {
  const holidays: Record<string, string> = {};
  for (const dateKey of dateKeys) {
    if (isSunday(dateKey)) holidays[dateKey] = SUNDAY_HOLIDAY_LABEL;
  }
  const inMonth = new Set(dateKeys);
  for (const holiday of declared) {
    if (inMonth.has(holiday.dateKey)) holidays[holiday.dateKey] = holiday.label;
  }
  return holidays;
}

export function finaliseTotals(totals: AttendanceTotals): AttendanceTotals {
  totals.percentage = attendancePercentage(totals.present, totals.workingDays);
  return totals;
}

export async function getMonthly(classCode: ClassCode, month: string): Promise<MonthlyResponse> {
  const { from, to } = monthBounds(month);
  const settings = await getSettings();

  const [students, records] = await Promise.all([
    activeStudentsIn(classCode),
    Attendance.find({ classCode, dateKey: { $gte: from, $lte: to } }).lean<AttendanceDoc[]>(),
  ]);

  const byStudent = new Map<string, AttendanceDoc[]>();
  for (const record of records) {
    const list = byStudent.get(record.studentId);
    if (list) list.push(record);
    else byStudent.set(record.studentId, [record]);
  }

  const allDateKeys = dateKeysInMonth(month);
  const holidays = holidayMapFor(allDateKeys, settings.holidays);

  const rows: MonthlyRow[] = students.map((student) => {
    const totals = emptyTotals();
    const days: Record<string, string> = {};

    // Every Sunday in the month reads as a holiday whether or not anything was recorded,
    // so an old stray mark cannot quietly count toward the percentage.
    for (const dateKey of allDateKeys) {
      if (isSunday(dateKey)) {
        days[dateKey] = 'HOLIDAY';
        addToTotals(totals, 'HOLIDAY');
      }
    }

    for (const record of byStudent.get(student._id) ?? []) {
      if (isSunday(record.dateKey)) continue;
      days[record.dateKey] = record.status;
      addToTotals(totals, record.status);
    }

    return {
      studentId: student._id,
      fullName: student.fullName,
      rollNo: student.rollNo,
      days,
      totals: finaliseTotals(totals),
    };
  });

  return { classCode, month, dateKeys: allDateKeys, holidays, rows };
}

export async function getStudentAttendance(
  studentId: string,
  range: { from?: string; to?: string } = {},
): Promise<{ records: { dateKey: string; status: string; remarks: string }[]; totals: AttendanceTotals }> {
  const filter: Record<string, unknown> = { studentId: studentId.toUpperCase() };
  if (range.from || range.to) {
    filter.dateKey = {
      ...(range.from ? { $gte: range.from } : {}),
      ...(range.to ? { $lte: range.to } : {}),
    };
  }

  const stored = await Attendance.find(filter).sort({ dateKey: -1 }).lean<AttendanceDoc[]>();
  // A Sunday is a holiday regardless of what was recorded, so a stray old mark cannot
  // count toward the percentage here either.
  const records = stored.filter((record) => !isSunday(record.dateKey));

  const totals = emptyTotals();
  for (const record of records) addToTotals(totals, record.status);

  return {
    records: records.map((r) => ({ dateKey: r.dateKey, status: r.status, remarks: r.remarks })),
    totals: finaliseTotals(totals),
  };
}

/**
 * Students below an attendance threshold for a month. Schools act on this — it is the
 * report that drives a call home.
 */
export async function getDefaulters(
  month: string,
  threshold: number,
  classCode?: ClassCode,
): Promise<{ month: string; threshold: number; items: AttendanceDefaulter[] }> {
  const { from, to } = monthBounds(month);

  const studentFilter: Record<string, unknown> = { status: 'ACTIVE' };
  if (classCode) studentFilter.classCode = classCode;

  const students = await Student.find(studentFilter)
    .select('fullName classCode')
    .lean<Pick<StudentDoc, '_id' | 'fullName' | 'classCode'>[]>();

  const records = await Attendance.find({
    studentId: { $in: students.map((s) => s._id) },
    dateKey: { $gte: from, $lte: to },
  }).lean<AttendanceDoc[]>();

  const totalsByStudent = new Map<string, AttendanceTotals>();
  for (const record of records) {
    // Sundays are holidays, so they never count for or against anyone here.
    if (isSunday(record.dateKey)) continue;
    let totals = totalsByStudent.get(record.studentId);
    if (!totals) {
      totals = emptyTotals();
      totalsByStudent.set(record.studentId, totals);
    }
    addToTotals(totals, record.status);
  }

  const items: AttendanceDefaulter[] = [];
  for (const student of students) {
    const totals = totalsByStudent.get(student._id);
    // No records at all means nothing was marked, not 0% attendance — reporting that as
    // a defaulter would bury the real ones in noise.
    if (!totals || totals.workingDays === 0) continue;

    finaliseTotals(totals);
    if (totals.percentage < threshold) {
      items.push({
        studentId: student._id,
        fullName: student.fullName,
        classCode: student.classCode,
        totals,
      });
    }
  }

  items.sort((a, b) => a.totals.percentage - b.totals.percentage);
  return { month, threshold, items };
}

/**
 * Which of today's classes still have no attendance — the dashboard nudge that stops a
 * class quietly going unmarked.
 */
export async function getUnmarkedClasses(dateKey: string = toDateKey()): Promise<ClassCode[]> {
  // Nothing is unmarked on a Sunday — there is nothing to mark.
  if (isSunday(dateKey)) return [];

  const [classesWithStudents, marked] = await Promise.all([
    Student.distinct('classCode', { status: 'ACTIVE' }) as Promise<ClassCode[]>,
    Attendance.distinct('classCode', { dateKey }) as Promise<ClassCode[]>,
  ]);

  const done = new Set(marked);
  return classesWithStudents.filter((code) => !done.has(code));
}

export const ATTENDANCE_STATUS_VALUES = ATTENDANCE_STATUSES;
