import {
  DEFAULT_REPORT_SCOPE,
  EXAM_CODES,
  EXAM_LABELS,
  FULL_SESSION,
  papersWithContent,
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
import { scopeFromParam, scopeToParam } from '@/lib/reportScope';

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
  // Scope lives in the URL rather than in component state so the printed page and a
  // shared link are always the same card. Resolved below, once settings are in.
  const [searchParams, setSearchParams] = useSearchParams();

  // Reached from the gradebook and from a student's record, so a fixed destination would
  // be wrong from one of them. 'default' means the app was loaded here — a printed card's
  // URL typed in directly — where stepping back would leave the app.
  const canGoBack = location.key !== 'default';
  const goBack = () => (canGoBack ? navigate(-1) : navigate('/academics'));

  const history = useQuery({
    queryKey: academicKeys.student(studentId),
    queryFn: () => academicsApi.student(studentId),
  });
  const settings = useQuery({ queryKey: settingsKeys.school, queryFn: settingsApi.school });

  /*
    A URL that does not name a paper opens on whichever the school has chosen in Settings,
    so the card someone prints most often is the one a bare link gives them.

    The factory default stands in while settings are loading. That window is behind the
    spinner below, so nothing is drawn from it — but `scope` feeds the document title
    effect, which does run, and a value it can use is better than a conditional hook.
  */
  const scope = scopeFromParam(
    searchParams.get('exam'),
    settings.data?.defaultReportScope ?? DEFAULT_REPORT_SCOPE,
  );

  // Becomes the default PDF filename when printed to file.
  useEffect(() => {
    const previous = document.title;
    const suffix = scope ? ` ${EXAM_LABELS[scope]}` : '';
    document.title = `Report card ${studentId} ${academicYear}${suffix}`;
    return () => {
      document.title = previous;
    };
  }, [studentId, academicYear, scope]);

  if (history.isPending || settings.isPending) return <LoadingBlock />;

  /*
    Both halves are needed to draw a card, so both are reported the same way.

    Written as one guard rather than a spinner condition and an error condition, because
    splitting them is what left a teacher staring at a spinner for ever: `!settings.data`
    sat in the loading test, and a request that had *failed* satisfies it just as well as
    one still in flight. A settled query with no data is a failure, not a wait.
  */
  const failure = history.error ?? settings.error;
  if (failure || !history.data || !settings.data)
    return (
      <div className="p-4 sm:p-6">
        <ErrorBlock
          message={(failure as Error | undefined)?.message ?? 'Could not load this report card.'}
          onRetry={() => {
            void history.refetch();
            void settings.refetch();
          }}
        />
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
    <div className="mx-auto max-w-3xl p-4 sm:p-6 print:p-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button variant="ghost" onClick={goBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back
        </Button>
        {/* Its own row on a phone, where a 176px dropdown plus two buttons cannot share
            one: the picker takes the width it needs and the buttons wrap beneath it. */}
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <label htmlFor="report-scope" className="text-sm text-slate-600">
            Show
          </label>
          <Select
            id="report-scope"
            className="min-w-40 flex-1 sm:w-44 sm:flex-none"
            value={scopeToParam(scope)}
            onChange={(event) => {
              // Always written, never dropped: an absent parameter means the school's
              // default now, so clearing it would be a way of choosing that rather than
              // "all papers".
              // `replace` so flicking through papers does not bury the page you arrived
              // from under six history entries.
              setSearchParams({ exam: event.target.value }, { replace: true });
            }}
          >
            <option value={FULL_SESSION}>Full session</option>
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
      <div className="print-page">
        <ReportCardSheet
          school={school}
          studentName={history.data.fullName}
          guardian={history.data.guardian}
          year={year}
          columns={columns}
          scope={scope}
        />
      </div>
    </div>
  );
}
