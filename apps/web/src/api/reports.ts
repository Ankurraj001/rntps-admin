import type { AttendanceDefaulter } from '@rntps/shared';
import { api, qs } from '@/lib/api';

export interface DuesRow {
  studentId: string;
  studentName: string;
  classCode: string;
  familyId: string;
  invoiceCount: number;
  oldestDueDate: string;
  totalRupees: number;
  paidRupees: number;
  balanceRupees: number;
  bucket: 'not-due' | '0-30' | '31-60' | '60+';
}

export interface DuesReport {
  generatedAt: string;
  rows: DuesRow[];
  totals: {
    students: number;
    balanceRupees: number;
    aging: Record<'not-due' | '0-30' | '31-60' | '60+', number>;
  };
}

export interface CollectionRow {
  receiptNo: string;
  paidAt: string;
  studentId: string;
  studentName: string;
  classCode: string;
  period: string;
  mode: string;
  reference: string;
  amountRupees: number;
  isReversed: boolean;
  reversalReason: string;
  reversedAt: string | null;
}

export interface CollectionReport {
  from: string;
  to: string;
  rows: CollectionRow[];
  totals: {
    count: number;
    amountRupees: number;
    byMode: Record<string, number>;
    reversedCount: number;
    reversedRupees: number;
  };
}

export interface DashboardSummary {
  school: { name: string; academicYear: string };
  activeStudents: number;
  studentsByClass: { classCode: string; count: number }[];
  today: {
    dateKey: string;
    marked: number;
    present: number;
    percentage: number;
    unmarkedClasses: string[];
    /** Set when the school is closed today — a Sunday or a declared school holiday. */
    holiday: { dateKey: string; label: string } | null;
  };
  month: { period: string; collectedRupees: number; invoicedRupees: number };
  outstanding: {
    balanceRupees: number;
    students: number;
    aging: Record<'not-due' | '0-30' | '31-60' | '60+', number>;
  };
  studentsWithoutWhatsapp: number;
}

export const reportsApi = {
  dashboard: () => api.get<DashboardSummary>('/reports/dashboard'),
  dues: (params: { classCode?: string; period?: string; transportOnly?: string }) =>
    api.get<DuesReport>(`/reports/dues${qs(params)}`),
  collection: (from: string, to: string, transportOnly?: string) =>
    api.get<CollectionReport>(`/reports/collection${qs({ from, to, transportOnly })}`),
  defaulters: (month: string, threshold: number, classCode?: string) =>
    api.get<{ month: string; threshold: number; items: AttendanceDefaulter[] }>(
      `/attendance/defaulters${qs({ month, threshold, classCode })}`,
    ),
};

export const reportKeys = {
  dashboard: ['reports', 'dashboard'] as const,
  dues: (params: object) => ['reports', 'dues', params] as const,
  collection: (from: string, to: string, transportOnly?: string) =>
    ['reports', 'collection', from, to, transportOnly ?? 'all'] as const,
  defaulters: (month: string, threshold: number, classCode?: string) =>
    ['reports', 'defaulters', month, threshold, classCode ?? 'all'] as const,
};
