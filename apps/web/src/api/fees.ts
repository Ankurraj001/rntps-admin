import type {
  FamilyBalanceDto,
  FeeHead,
  FeeSlipDto,
  FeeStructureDto,
  InvoiceDto,
  InvoiceRunPreview,
  InvoiceRunResult,
  Paginated,
  PaymentMode,
  RecordStudentPaymentResult,
} from '@rntps/shared';
import { api, qs } from '@/lib/api';

export type InvoiceListParams = {
  page?: number;
  limit?: number;
  status?: string;
  classCode?: string;
  period?: string;
  studentId?: string;
  overdueOnly?: string;
  q?: string;
};

export const feesApi = {
  structures: (academicYear?: string) =>
    api.get<{ items: FeeStructureDto[] }>(`/fees/structures${qs({ academicYear })}`),
  saveStructure: (classCode: string, academicYear: string, heads: FeeHead[]) =>
    api.put<FeeStructureDto>(`/fees/structures/${classCode}/${academicYear}`, { heads }),
  cloneStructures: (fromAcademicYear: string, toAcademicYear: string) =>
    api.post<{ copied: number; skipped: number }>('/fees/structures/clone', {
      fromAcademicYear,
      toAcademicYear,
    }),

  previewRun: (period: string, classCodes?: string[]) =>
    api.post<InvoiceRunPreview>('/fees/runs/preview', { period, ...(classCodes?.length ? { classCodes } : {}) }),
  commitRun: (period: string, classCodes?: string[]) =>
    api.post<InvoiceRunResult>('/fees/runs/commit', { period, ...(classCodes?.length ? { classCodes } : {}) }),

  invoices: (params: InvoiceListParams) => api.get<Paginated<InvoiceDto>>(`/fees/invoices${qs(params)}`),
  invoice: (id: string) => api.get<InvoiceDto>(`/fees/invoices/${encodeURIComponent(id)}`),
  slip: (id: string) => api.get<FeeSlipDto>(`/fees/invoices/${encodeURIComponent(id)}/slip`),
  recordPayment: (
    id: string,
    payload: { amountRupees: number; mode: PaymentMode; reference?: string; paidAt: string; notes?: string },
  ) => api.post<InvoiceDto>(`/fees/invoices/${encodeURIComponent(id)}/payments`, payload),
  reversePayment: (id: string, receiptNo: string, reason: string) =>
    api.post<InvoiceDto>(`/fees/invoices/${encodeURIComponent(id)}/payments/${receiptNo}/reverse`, { reason }),
  voidInvoice: (id: string, reason: string) =>
    api.post<InvoiceDto>(`/fees/invoices/${encodeURIComponent(id)}/void`, { reason }),
  studentInvoices: (studentId: string) =>
    api.get<{ items: InvoiceDto[] }>(`/fees/students/${studentId}/invoices`),
  /** Pays off as much of a student's total outstanding as one amount covers, oldest
   *  invoice first — as opposed to `recordPayment`, which pays one specific invoice. */
  recordStudentPayment: (
    studentId: string,
    payload: { amountRupees: number; mode: PaymentMode; reference?: string; paidAt: string; notes?: string },
  ) => api.post<RecordStudentPaymentResult>(`/fees/students/${studentId}/payments`, payload),
  familyBalance: (familyId: string) =>
    api.get<FamilyBalanceDto>(`/fees/families/${encodeURIComponent(familyId)}/balance`),
};

export const feeKeys = {
  all: ['fees'] as const,
  structures: (year?: string) => ['fees', 'structures', year ?? 'active'] as const,
  invoices: (params: InvoiceListParams) => ['fees', 'invoices', params] as const,
  invoice: (id: string) => ['fees', 'invoice', id] as const,
  slip: (id: string) => ['fees', 'slip', id] as const,
  studentInvoices: (studentId: string) => ['fees', 'student', studentId] as const,
  familyBalance: (familyId: string) => ['fees', 'family', familyId] as const,
};
