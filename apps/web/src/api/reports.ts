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
}

export interface CollectionReport {
  from: string;
  to: string;
  rows: CollectionRow[];
  totals: { count: number; amountRupees: number; byMode: Record<string, number> };
}

export interface DashboardSummary {
  school: { name: string; academicYear: string };
  activeStudents: number;
  studentsByClass: { classCode: string; count: number }[];
  today: { dateKey: string; marked: number; present: number; percentage: number; unmarkedClasses: string[] };
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
  dues: (params: { classCode?: string; period?: string }) =>
    api.get<DuesReport>(`/reports/dues${qs(params)}`),
  collection: (from: string, to: string) =>
    api.get<CollectionReport>(`/reports/collection${qs({ from, to })}`),
  defaulters: (month: string, threshold: number, classCode?: string) =>
    api.get<{ month: string; threshold: number; items: AttendanceDefaulter[] }>(
      `/attendance/defaulters${qs({ month, threshold, classCode })}`,
    ),
};

/**
 * Downloads a CSV.
 *
 * A plain <a href> cannot be used: the access token lives in memory, so a browser-issued
 * navigation would arrive without an Authorization header and get a 401. This fetches
 * with the header attached and hands the browser a blob instead.
 */
export async function downloadCsv(
  path: string,
  params: Record<string, string | number | undefined>,
  filename: string,
): Promise<void> {
  const blob = await api.getBlob(`${path}${qs({ ...params, format: 'csv' })}`);
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const reportKeys = {
  dashboard: ['reports', 'dashboard'] as const,
  dues: (params: object) => ['reports', 'dues', params] as const,
  collection: (from: string, to: string) => ['reports', 'collection', from, to] as const,
  defaulters: (month: string, threshold: number, classCode?: string) =>
    ['reports', 'defaulters', month, threshold, classCode ?? 'all'] as const,
};
