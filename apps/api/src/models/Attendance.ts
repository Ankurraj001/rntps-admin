import { ATTENDANCE_STATUSES, CLASS_CODES, type AttendanceStatus, type ClassCode } from '@rntps/shared';
import { Schema, model } from 'mongoose';

export interface AttendanceDoc {
  /**
   * `{studentId}:{dateKey}`, e.g. "RNTPS-26-001:2026-08-25".
   *
   * Keying on the pair makes double-marking structurally impossible — no unique index
   * and no application check required — and makes re-submitting a corrected roster a
   * plain idempotent upsert.
   */
  _id: string;
  studentId: string;
  classCode: ClassCode;
  /** IST calendar day. Never a Date: comparing Dates across zones misplaces a day. */
  dateKey: string;
  status: AttendanceStatus;
  remarks: string;
  markedBy: string;
  markedAt: Date;
}

const attendanceSchema = new Schema<AttendanceDoc>(
  {
    _id: { type: String, required: true },
    studentId: { type: String, required: true },
    classCode: { type: String, enum: CLASS_CODES, required: true },
    dateKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: ATTENDANCE_STATUSES, required: true },
    remarks: { type: String, default: '', maxlength: 200 },
    markedBy: { type: String, required: true },
    markedAt: { type: Date, required: true },
  },
  { versionKey: false, _id: false, timestamps: false },
);

// Roster for a class on a day, and the monthly grid.
attendanceSchema.index({ classCode: 1, dateKey: 1 });
// One student's history.
attendanceSchema.index({ studentId: 1, dateKey: 1 });

export const Attendance = model<AttendanceDoc>('Attendance', attendanceSchema);

export function attendanceId(studentId: string, dateKey: string): string {
  return `${studentId}:${dateKey}`;
}
