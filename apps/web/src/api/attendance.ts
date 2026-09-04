import type {
  AttendanceDefaulter,
  AttendanceStatus,
  AttendanceTotals,
  MonthlyResponse,
  RosterResponse,
  StaffMonthlyResponse,
  StaffRosterResponse,
} from '@rntps/shared';
import { api, qs } from '@/lib/api';

export interface StudentAttendance {
  records: { dateKey: string; status: string; remarks: string }[];
  totals: AttendanceTotals;
}

export const attendanceApi = {
  roster: (classCode: string, dateKey: string) =>
    api.get<RosterResponse>(`/attendance/roster${qs({ classCode, dateKey })}`),
  saveRoster: (payload: {
    classCode: string;
    dateKey: string;
    marks: { studentId: string; status: AttendanceStatus; remarks?: string }[];
  }) => api.put<{ saved: number; dateKey: string }>('/attendance/roster', payload),
  monthly: (classCode: string, month: string) =>
    api.get<MonthlyResponse>(`/attendance/monthly${qs({ classCode, month })}`),
  defaulters: (month: string, threshold: number, classCode?: string) =>
    api.get<{ month: string; threshold: number; items: AttendanceDefaulter[] }>(
      `/attendance/defaulters${qs({ month, threshold, classCode })}`,
    ),
  staffRoster: (dateKey: string) =>
    api.get<StaffRosterResponse>(`/attendance/staff/roster${qs({ dateKey })}`),
  saveStaffRoster: (payload: {
    dateKey: string;
    marks: { userId: string; status: AttendanceStatus; remarks?: string }[];
  }) => api.put<{ saved: number; dateKey: string }>('/attendance/staff/roster', payload),
  staffMonthly: (month: string) =>
    api.get<StaffMonthlyResponse>(`/attendance/staff/monthly${qs({ month })}`),
  unmarked: () => api.get<{ classes: string[] }>('/attendance/unmarked'),
  forStudent: (studentId: string) => api.get<StudentAttendance>(`/attendance/student/${studentId}`),
};

export const attendanceKeys = {
  all: ['attendance'] as const,
  roster: (classCode: string, dateKey: string) => ['attendance', 'roster', classCode, dateKey] as const,
  monthly: (classCode: string, month: string) => ['attendance', 'monthly', classCode, month] as const,
  defaulters: (month: string, threshold: number, classCode?: string) =>
    ['attendance', 'defaulters', month, threshold, classCode ?? 'all'] as const,
  // Under the 'attendance' prefix on purpose: the pages already invalidate
  // attendanceKeys.all after a save, so these need no extra invalidation.
  staffRoster: (dateKey: string) => ['attendance', 'staff', 'roster', dateKey] as const,
  staffMonthly: (month: string) => ['attendance', 'staff', 'monthly', month] as const,
  unmarked: ['attendance', 'unmarked'] as const,
  student: (studentId: string) => ['attendance', 'student', studentId] as const,
};
