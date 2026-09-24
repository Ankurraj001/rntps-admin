import {
  DEFAULT_REPORT_SCOPE,
  EXAM_CODES,
  EXAM_LABELS,
  classLabel,
  type AcademicRow,
  type StudentExamYear,
} from '@rntps/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { useEffect } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { academicKeys, academicsApi, type AcademicsListParams } from '@/api/academics';
import { settingsApi, settingsKeys } from '@/api/settings';
import { ReportCardSheet } from '@/components/academics/ReportCardSheet';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorBlock, LoadingBlock } from '@/components/ui/Feedback';
import { scopeFromParam } from '@/lib/reportScope';

/** A class is a few dozen students; the ceiling the list endpoint allows covers any of them. */
const CLASS_LIMIT = 200;

/**
 * Every card for one class, one session and one scope, on one page — the results-day job.
 *
 * Reads the gradebook list rather than a bespoke endpoint: a row already carries the
 * marks, the grades and the class snapshot, which is everything a card needs. That also
 * means the cards printed here and the one printed for a single student come from exactly
 * the same numbers.
 */
export function ClassReportCardsPage() {
  const { academicYear = '' } = useParams<{ academicYear: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const classCode = searchParams.get('classCode') ?? '';

  const canGoBack = location.key !== 'default';
  const goBack = () => (canGoBack ? navigate(-1) : navigate('/academics'));

  const params: AcademicsListParams = {
    page: 1,
    limit: CLASS_LIMIT,
    classCode: classCode || undefined,
    academicYear,
    sort: 'rollNo',
    order: 'asc',
  };
  const list = useQuery({
    queryKey: academicKeys.list(params),
    queryFn: () => academicsApi.list(params),
  });
  const settings = useQuery({ queryKey: settingsKeys.school, queryFn: settingsApi.school });

  // Read the same way the single-student card reads it, down to the configured default,
  // so one shared link and the other cannot disagree about what a missing `exam` means.
  const scope = scopeFromParam(
    searchParams.get('exam'),
    settings.data?.defaultReportScope ?? DEFAULT_REPORT_SCOPE,
  );
  const columns = scope === null ? [...EXAM_CODES] : [scope];

  // Becomes the default PDF filename when printed to file.
  useEffect(() => {
    const previous = document.title;
    const suffix = scope ? ` ${EXAM_LABELS[scope]}` : '';
    document.title = `Report cards ${classLabel(classCode)} ${academicYear}${suffix}`;
    return () => {
      document.title = previous;
    };
  }, [classCode, academicYear, scope]);

  if (list.isPending || settings.isPending) return <LoadingBlock />;

  /*
    One guard for both halves, for the reason spelled out on the single-card page: a
    settled query with no data is a failure, and testing `!settings.data` as part of the
    *loading* condition reported it as a wait that never ended.
  */
  const failure = list.error ?? settings.error;
  if (failure || !list.data || !settings.data)
    return (
      <div className="p-4 sm:p-6">
        <ErrorBlock
          message={(failure as Error | undefined)?.message ?? 'Could not load these report cards.'}
          onRetry={() => {
            void list.refetch();
            void settings.refetch();
          }}
        />
      </div>
    );

  const school = settings.data;
  // Printed in register order, so the stack comes off the printer the way the teacher
  // hands it out. A student with no card at all is skipped rather than given a blank
  // sheet — and named below, because that is a gap in the marks worth noticing.
  const withCards = list.data.items.filter((row) => row.hasRecord);
  const skipped = list.data.items.filter((row) => !row.hasRecord);

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6 print:p-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button variant="ghost" onClick={goBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back
        </Button>
        <p className="text-sm text-slate-600">
          {classLabel(classCode)} · {academicYear} · {scope ? EXAM_LABELS[scope] : 'Full session'} ·{' '}
          <strong className="text-slate-900">{withCards.length}</strong>{' '}
          {withCards.length === 1 ? 'card' : 'cards'}
        </p>
        <Button onClick={() => window.print()} disabled={withCards.length === 0}>
          <Printer className="h-4 w-4" aria-hidden />
          Print
        </Button>
      </div>

      {skipped.length > 0 && (
        <div className="mb-4 rounded-md bg-amber-50 p-4 text-sm text-amber-800 print:hidden">
          <p className="font-medium">
            {skipped.length} {skipped.length === 1 ? 'student has' : 'students have'} no marks
            recorded and {skipped.length === 1 ? 'was' : 'were'} left out:
          </p>
          <p className="mt-1">{skipped.map((row) => row.fullName).join(', ')}</p>
        </div>
      )}

      {withCards.length === 0 ? (
        <EmptyState
          title="No cards to print"
          description={`No marks are recorded for ${classLabel(classCode)} in ${academicYear}.`}
        />
      ) : (
        <div className="space-y-6 print:space-y-0">
          {withCards.map((row, index) => (
            <div
              key={row.studentId}
              // A page each, except the last — a trailing break prints a blank sheet.
              className={
                index === withCards.length - 1 ? 'print-page' : 'print-page break-after-page'
              }
            >
              <ReportCardSheet
                school={school}
                studentName={row.fullName}
                guardian={row.guardian}
                year={toExamYear(row)}
                columns={columns}
                scope={scope}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A gradebook row is a card's worth of data under different names — the list endpoint and
 * the student history endpoint describe the same document from two angles.
 */
function toExamYear(row: AcademicRow): StudentExamYear {
  return {
    academicYear: row.academicYear,
    classCode: row.classCode,
    rollNo: row.rollNo,
    scores: row.scores,
    subjectMarks: row.subjectMarks,
    subjectGrades: row.subjectGrades,
    updatedAt: row.updatedAt,
  };
}
