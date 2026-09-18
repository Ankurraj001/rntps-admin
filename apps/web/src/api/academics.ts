import type {
  AcademicRow,
  AcademicYearsResponse,
  Paginated,
  ExamCode,
  ReportCardWaLinkDto,
  SaveExamResultPayload,
  StudentAcademicsResponse,
} from '@rntps/shared';
import { api, qs } from '@/lib/api';

// A type alias rather than an interface: only aliases get the implicit index
// signature that qs() needs.
export type AcademicsListParams = {
  page?: number;
  limit?: number;
  q?: string;
  classCode?: string;
  academicYear?: string;
  sort?: string;
  order?: 'asc' | 'desc';
};

export const academicsApi = {
  list: (params: AcademicsListParams) => api.get<Paginated<AcademicRow>>(`/academics${qs(params)}`),
  years: () => api.get<AcademicYearsResponse>('/academics/years'),
  student: (studentId: string) => api.get<StudentAcademicsResponse>(`/academics/student/${studentId}`),
  // Typed straight off the schema the API validates against, so the two cannot drift.
  saveMarks: (payload: SaveExamResultPayload) => api.put<AcademicRow>('/academics/marks', payload),
  /** The report card as a WhatsApp message — guardian, template and fitting all decided server-side. */
  reportCardWaLink: (studentId: string, academicYear: string, exam?: ExamCode) =>
    api.get<ReportCardWaLinkDto>(
      `/academics/report-card/${encodeURIComponent(studentId)}/${encodeURIComponent(academicYear)}/whatsapp-link${qs({ exam })}`,
    ),
};

/** Query keys are centralised so mutations can invalidate precisely. */
export const academicKeys = {
  all: ['academics'] as const,
  list: (params: AcademicsListParams) => ['academics', 'list', params] as const,
  years: ['academics', 'years'] as const,
  student: (studentId: string) => ['academics', 'student', studentId] as const,
};
