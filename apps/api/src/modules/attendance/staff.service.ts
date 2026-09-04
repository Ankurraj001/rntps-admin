import {
  isSunday,
  toDateKey,
  type SaveStaffRosterPayload,
  type StaffMonthlyResponse,
  type StaffMonthlyRow,
  type StaffRosterResponse,
} from '@rntps/shared';
import { AppError } from '../../lib/AppError.js';
import { dateKeysInMonth, monthBounds } from '../../lib/dateRange.js';
import { getSettings } from '../../lib/ids.js';
import { StaffAttendance, staffAttendanceId, type StaffAttendanceDoc } from '../../models/StaffAttendance.js';
import { User, type UserDoc } from '../../models/User.js';
import {
  addToTotals,
  emptyTotals,
  finaliseTotals,
  holidayFor,
  holidayMapFor,
} from './attendance.service.js';

type RosterTeacher = Pick<UserDoc, '_id' | 'name'>;

/**
 * Who appears on the teacher roster.
 *
 * Only role TEACHER: admins reach every part of the system and are not the staff whose
 * attendance the school is tracking. Alphabetical, matching the Users page. The existing
 * `{ role: 1, isActive: 1 }` index on User covers this exactly.
 */
async function activeTeachers(): Promise<RosterTeacher[]> {
  return User.find({ role: 'TEACHER', isActive: true })
    .select('name')
    .sort({ name: 1 })
    .lean<RosterTeacher[]>();
}

export async function getStaffRoster(dateKey: string): Promise<StaffRosterResponse> {
  const settings = await getSettings();
  const [teachers, existing] = await Promise.all([
    activeTeachers(),
    StaffAttendance.find({ dateKey }).lean<StaffAttendanceDoc[]>(),
  ]);

  const marks = new Map(existing.map((record) => [record.userId, record]));
  const sunday = isSunday(dateKey);
  const holiday = holidayFor(dateKey, settings.holidays);

  // The most recently marked record stands in for "who submitted this roster".
  const latest = existing.reduce<StaffAttendanceDoc | null>(
    (newest, record) => (!newest || record.markedAt > newest.markedAt ? record : newest),
    null,
  );

  return {
    dateKey,
    holiday,
    isSunday: sunday,
    isFuture: dateKey > toDateKey(),
    submittedAt: latest?.markedAt.toISOString() ?? null,
    submittedBy: latest?.markedBy ?? null,
    entries: teachers.map((teacher) => {
      const mark = marks.get(String(teacher._id));
      return {
        userId: String(teacher._id),
        name: teacher.name,
        // A Sunday reads HOLIDAY whatever is stored, so a mark saved before the rule
        // existed cannot drag a percentage down.
        status: sunday ? ('HOLIDAY' as const) : (mark?.status ?? null),
        remarks: sunday ? '' : (mark?.remarks ?? ''),
      };
    }),
  };
}

export async function saveStaffRoster(
  payload: SaveStaffRosterPayload,
  markedBy: string,
): Promise<{ saved: number; dateKey: string }> {
  if (payload.dateKey > toDateKey()) {
    throw AppError.badRequest('Attendance cannot be marked for a future date');
  }
  // Refuse rather than accept marks that every reader would then ignore.
  if (isSunday(payload.dateKey)) {
    throw AppError.badRequest('Sunday is a holiday — attendance is not marked');
  }

  const roster = await activeTeachers();
  const allowed = new Set(roster.map((teacher) => String(teacher._id)));
  const stray = payload.marks.filter((mark) => !allowed.has(mark.userId));
  if (stray.length > 0) {
    // Catches a student id, a deactivated teacher, and a teacher promoted to admin since
    // the page loaded — the last being a real path, not a hypothetical.
    throw AppError.badRequest(`These users are not on the teacher roll: ${stray.map((m) => m.userId).join(', ')}`);
  }

  const markedAt = new Date();
  const operations = payload.marks.map((mark) => ({
    updateOne: {
      filter: { _id: staffAttendanceId(mark.userId, payload.dateKey) },
      update: {
        $set: {
          userId: mark.userId,
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

  await StaffAttendance.bulkWrite(operations, { ordered: false });
  return { saved: operations.length, dateKey: payload.dateKey };
}

export async function getStaffMonthly(month: string): Promise<StaffMonthlyResponse> {
  const { from, to } = monthBounds(month);
  const settings = await getSettings();

  const [teachers, records] = await Promise.all([
    activeTeachers(),
    StaffAttendance.find({ dateKey: { $gte: from, $lte: to } }).lean<StaffAttendanceDoc[]>(),
  ]);

  const byTeacher = new Map<string, StaffAttendanceDoc[]>();
  for (const record of records) {
    const list = byTeacher.get(record.userId);
    if (list) list.push(record);
    else byTeacher.set(record.userId, [record]);
  }

  const allDateKeys = dateKeysInMonth(month);
  const holidays = holidayMapFor(allDateKeys, settings.holidays);

  const rows: StaffMonthlyRow[] = teachers.map((teacher) => {
    const totals = emptyTotals();
    const days: Record<string, string> = {};

    for (const dateKey of allDateKeys) {
      if (isSunday(dateKey)) {
        days[dateKey] = 'HOLIDAY';
        addToTotals(totals, 'HOLIDAY');
      }
    }
    for (const record of byTeacher.get(String(teacher._id)) ?? []) {
      // A stray Sunday mark is discarded rather than counted, exactly as for a student.
      if (isSunday(record.dateKey)) continue;
      days[record.dateKey] = record.status;
      addToTotals(totals, record.status);
    }

    return {
      userId: String(teacher._id),
      name: teacher.name,
      days,
      totals: finaliseTotals(totals),
    };
  });

  return { month, dateKeys: allDateKeys, holidays, rows };
}
