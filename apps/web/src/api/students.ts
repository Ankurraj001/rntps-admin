import type {
  RolloverStatusDto,
  StudentChargeDto,
  CreateStudentInput,
  Paginated,
  SiblingDto,
  StudentDto,
  Address,
  Guardian,
} from '@rntps/shared';
import { api, qs } from '@/lib/api';

// A type alias rather than an interface: only aliases get the implicit index
// signature that qs() needs.
export type StudentListParams = {
  page?: number;
  limit?: number;
  q?: string;
  classCode?: string;
  status?: string;
  sort?: string;
  order?: 'asc' | 'desc';
};

export interface StudentStats {
  byClass: { classCode: string; count: number }[];
  totalActive: number;
  missingWhatsapp: SiblingDto[];
}

export interface FamilyDefaults {
  familyId: string;
  guardians: Guardian[];
  address: Address;
  siblings: SiblingDto[];
}

export interface PromotionResult {
  dryRun: boolean;
  promoted: { studentId: string; fullName: string; from: string; to: string }[];
  graduated: { studentId: string; fullName: string }[];
  skipped: { studentId: string; reason: string }[];
}

export const studentsApi = {
  list: (params: StudentListParams) => api.get<Paginated<StudentDto>>(`/students${qs(params)}`),
  get: (studentId: string) => api.get<StudentDto>(`/students/${studentId}`),
  create: (payload: CreateStudentInput) => api.post<StudentDto>('/students', payload),
  update: (studentId: string, payload: Partial<CreateStudentInput>) =>
    api.patch<StudentDto>(`/students/${studentId}`, payload),
  setStatus: (studentId: string, status: string, reason: string) =>
    api.post<StudentDto>(`/students/${studentId}/status`, { status, reason }),
  siblings: (studentId: string) => api.get<{ items: SiblingDto[] }>(`/students/${studentId}/siblings`),
  familyDefaults: (studentId: string) => api.get<FamilyDefaults>(`/students/${studentId}/family-defaults`),
  searchSibling: (q: string) => api.get<{ items: SiblingDto[] }>(`/students/search-sibling${qs({ q })}`),
  stats: () => api.get<StudentStats>('/students/stats'),
  promote: (payload: {
    fromAcademicYear: string;
    toAcademicYear: string;
    classCodes?: string[];
    dryRun: boolean;
  }) => api.post<PromotionResult>('/students/promote', payload),
  rolloverStatus: () => api.get<RolloverStatusDto>('/students/rollover-status'),
  charges: (studentId: string) => api.get<{ items: StudentChargeDto[] }>(`/students/${studentId}/charges`),
  addCharge: (studentId: string, payload: { name: string; amountRupees: number }) =>
    api.post<{ items: StudentChargeDto[] }>(`/students/${studentId}/charges`, payload),
  removeCharge: (studentId: string, chargeId: string) =>
    api.del<{ items: StudentChargeDto[] }>(`/students/${studentId}/charges/${chargeId}`),
};

/** Query keys are centralised so mutations can invalidate precisely. */
export const studentKeys = {
  charges: (studentId: string) => ['students', studentId, 'charges'] as const,
  all: ['students'] as const,
  list: (params: StudentListParams) => ['students', 'list', params] as const,
  detail: (studentId: string) => ['students', 'detail', studentId] as const,
  siblings: (studentId: string) => ['students', 'siblings', studentId] as const,
  stats: ['students', 'stats'] as const,
  rollover: ['students', 'rollover'] as const,
};
