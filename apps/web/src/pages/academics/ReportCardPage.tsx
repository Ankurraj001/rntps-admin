import {
  EXAM_CODES,
  EXAM_LABELS,
  papersWithContent,
  type ExamCode,
} from '@rntps/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { useEffect } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { academicKeys, academicsApi } from '@/api/academics';
import { settingsApi, settingsKeys } from '@/api/settings';
import { ReportCardSheet } from '@/components/academics/ReportCardSheet';
import { WhatsAppReportCardButton } from '@/components/academics/WhatsAppReportCardButton';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { ErrorBlock, LoadingBlock } from '@/components/ui/Feedback';

/**
 * The results card handed to a parent, for one session.
 *
 * Reads from the student's own history rather than a bespoke endpoint, so a card printed
 * for a closed session shows the class and roll number the child had *then* — the same
 * snapshots the gradebook reads back after a rollover.
 */
export function ReportCardPage() {
  const { studentId = '', academicYear = '' } = useParams<{
    studentId: string;
    academicYear: string;
  }>();
  const navigate = useNavigate();
  const location = useLocation();
  /*
    Scope lives in the URL rather than in component state so the printed page and a
    shared link are always the same card. Absent means the whole session, which makes the
    plain URL the full card it already was.
  */
  const [searchParams, setSearchParams] = useSearchParams();
  const examParam = searchParams.get('exam');
  const scope: ExamCode | null = EXAM_CODES.includes(examParam as ExamCode)
    ? (examParam as ExamCode)
    : null;

  // Reached from the gradebook and from a student's record, so a fixed destination would
  // be wrong from one of them. 'default' means the app was loaded here — a printed card's
  // URL typed in directly — where stepping back would leave the app.
  const canGoBack = location.key !== 'default';
  const goBack = () => (canGoBack ? navigate(-1) : navigate('/academics'));

  const history = useQuery({
    queryKey: academicKeys.student(studentId),
    queryFn: () => academicsApi.student(studentId),
  });
  const settings = useQuery({ queryKey: settingsKeys.all, queryFn: settingsApi.get });

  // Becomes the default PDF filename when printed to file.
  useEffect(() => {
    const previous = document.title;
    const suffix = scope ? ` ${EXAM_LABELS[scope]}` : '';
    document.title = `Report card ${studentId} ${academicYear}${suffix}`;
    return () => {
      document.title = previous;
    };
  }, [studentId, academicYear, scope]);

  if (history.isPending || settings.isPending || !settings.data) return <LoadingBlock />;
  if (history.error)
    return (
      <div className="p-4 sm:p-6">
        <ErrorBlock message={(history.error as Error).message} />
      </div>
    );

  const school = settings.data;
  const year = history.data.years.find((entry) => entry.academicYear === academicYear);

  if (!year) {
    return (
      <div className="p-4 sm:p-6">
        <ErrorBlock message={`No marks are on record for ${studentId} in ${academicYear}.`} />
      </div>
    );
  }

  // Every paper is listed and printable, marked or not — a card showing UT-3 as dashes is
  // a truthful statement that it has not been sat, and the alternative is a dropdown whose
  // contents change as the year goes on.
  const columns = scope === null ? [...EXAM_CODES] : [scope];
  // Sending is the exception: a blank card is worth printing for the file but not worth a
  // parent's phone buzzing, so the button is dead until the paper has something on it.
  const marked = papersWithContent(year);
  const nothingToSend = scope === null ? marked.length === 0 : !marked.includes(scope);

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button variant="ghost" onClick={goBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="report-scope" className="text-sm text-slate-600">
            Show
          </label>
          <Select
            id="report-scope"
            className="w-44"
            value={scope ?? ''}
            onChange={(event) => {
              const next = event.target.value;
              // `replace` so flicking through papers does not bury the page you arrived
              // from under six history entries.
              setSearchParams(next ? { exam: next } : {}, { replace: true });
            }}
          >
            <option value="">Full session</option>
            {EXAM_CODES.map((code) => (
              <option key={code} value={code}>
                {EXAM_LABELS[code]}
              </option>
            ))}
          </Select>
          <WhatsAppReportCardButton
            studentId={studentId}
            academicYear={academicYear}
            disabled={nothingToSend}
            {...(scope ? { exam: scope } : {})}
          />
          <Button onClick={() => window.print()}>
            <Printer className="h-4 w-4" aria-hidden />
            Print
          </Button>
        </div>
      </div>
      <ReportCardSheet
        school={school}
        studentName={history.data.fullName}
        guardian={history.data.guardian}
        year={year}
        columns={columns}
        scope={scope}
      />
    </div>
  );
}
