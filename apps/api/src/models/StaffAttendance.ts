import { ATTENDANCE_STATUSES, type AttendanceStatus } from '@rntps/shared';
import { Schema, model } from 'mongoose';

/**
 * A teacher's attendance for one day.
 *
 * Its own collection rather than a row in `attendances` with a synthetic class code. The
 * dashboard counts *every* attendance document for today with no class filter
 * (`reports.service.ts`), so staff rows sharing that collection would silently blend into
 * the school-wide "present today" figure. Separating them makes "student figures do not
 * move" true by construction rather than by remembering to filter in every reader.
 *
 * There is no `classCode`: a teacher does not belong to a class.
 */
export interface StaffAttendanceDoc {
  /**
   * `{userId}:{dateKey}`, e.g. "68b0…f21:2026-08-25".
   *
   * Same reasoning as `Attendance`: keying on the pair makes double-marking structurally
   * impossible, and re-submitting a corrected roster is a plain idempotent upsert.
   */
  _id: string;
  /** A `User._id` as a hex string. Only users with role TEACHER are ever marked. */
  userId: string;
  /** IST calendar day. Never a Date: comparing Dates across zones misplaces a day. */
  dateKey: string;
  status: AttendanceStatus;
  remarks: string;
  markedBy: string;
  markedAt: Date;
}

const staffAttendanceSchema = new Schema<StaffAttendanceDoc>(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true },
    dateKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: ATTENDANCE_STATUSES, required: true },
    remarks: { type: String, default: '', maxlength: 200 },
    markedBy: { type: String, required: true },
    markedAt: { type: Date, required: true },
  },
  { versionKey: false, _id: false, timestamps: false },
);

// The roster for one day, and the monthly grid's date range. Both reads key on dateKey
// alone; grouping by teacher happens in memory afterwards. A {userId, dateKey} index would
// have no reader until there is a per-teacher history view, so it is left out.
staffAttendanceSchema.index({ dateKey: 1 });

export const StaffAttendance = model<StaffAttendanceDoc>('StaffAttendance', staffAttendanceSchema);

export function staffAttendanceId(userId: string, dateKey: string): string {
  return `${userId}:${dateKey}`;
}
