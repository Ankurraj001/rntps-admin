import {
  EXAM_LABELS,
  GRADED_SUBJECT_CODES,
  MAX_SUBJECT_MARK,
  SUBJECT_LABELS,
  classLabel,
  examTotal,
  subjectsForClass,
  type CardGuardian,
  type ExamCode,
  type SchoolInfoDto,
  type StudentExamYear,
} from '@rntps/shared';
import { useState } from 'react';

/**
 * Where the school crest lives. Dropped in `apps/web/public/`, so it is served as-is and
 * needs no bundler import — the file can be replaced without a rebuild.
 */
const LOGO_SRC = '/school-logo.png';

/**
 * Colours are declared with `print-color-adjust: exact`.
 *
 * Browsers strip background colours when printing unless told otherwise, which would leave
 * the header band and the striped rows as plain white and the card looking half-finished
 * on the one medium it exists for.
 */
const PRINT_EXACT = '[print-color-adjust:exact] [-webkit-print-color-adjust:exact]';

/** Names the two halves of a CBSE-pattern card: what is marked, and what is graded. */
function SectionHeading({ children }: { children: string }) {
  return (
    <h2 className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.15em] text-blue-900">
      {children}
    </h2>
  );
}

/** A label-and-value pair from the identity block. */
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <span className="h-px flex-1 border-b border-dotted border-slate-300" aria-hidden />
      <span className="font-semibold text-slate-900">{value}</span>
    </div>
  );
}

/**
 * One printable report card.
 *
 * Shared by the single-student page and the class run so the two can never drift — a card
 * a parent is handed should not depend on which screen the office printed it from.
 *
 * `columns` decides the scope: every paper for a full session, or one for a single result.
 * The caller picks it, because the two pages reach it differently — a URL parameter on one,
 * a dialog on the other.
 */
export function ReportCardSheet({
  school,
  studentName,
  guardian,
  year,
  columns,
  scope,
}: {
  /** The letterhead only: this draws a school's name and address, not its settings. */
  school: SchoolInfoDto;
  studentName: string;
  guardian: CardGuardian | null;
  year: StudentExamYear;
  columns: ExamCode[];
  scope: ExamCode | null;
}) {
  // Hidden rather than left as a broken image, so the card still reads properly on an
  // install where the crest has not been dropped in yet.
  const [logoFailed, setLogoFailed] = useState(false);

  const subjects = subjectsForClass(year.classCode);
  const totals = columns.map((code) => examTotal(year.subjectMarks[code], year.classCode, code));

  return (
    <article
      className={`overflow-hidden rounded-lg border-2 border-blue-900 bg-white shadow-sm print:rounded-none print:shadow-none ${PRINT_EXACT}`}
    >
      <header className="flex items-center gap-5 px-6 pt-6 pb-4 sm:px-8">
        {!logoFailed && (
          <img
            src={LOGO_SRC}
            alt=""
            aria-hidden
            onError={() => setLogoFailed(true)}
            className="h-24 w-24 shrink-0 object-contain sm:h-28 sm:w-28"
          />
        )}
        <div className="min-w-0 flex-1 text-center">
          {/* One line, always — a school name broken in two is the first thing that makes
              a card look homemade.

              The crest and its balancing spacer leave 436px here on a printed sheet.
              "R N Tagore Public School" measures 348px at 24px, so there is room to
              spare; at 30px it measures 435px, which fits by one pixel and would wrap on
              any name a character longer. Hence 24px rather than the 30px the heading
              would otherwise take. */}
          <h1 className="whitespace-nowrap text-2xl font-bold uppercase tracking-wide text-blue-900">
            {school.schoolName}
          </h1>
          {school.schoolAddress && (
            <p className="mt-0.5 text-sm text-slate-600">{school.schoolAddress}</p>
          )}
          {/* Part of the letterhead rather than a badge on the marks: it describes the
              school, not this particular card. */}
          <p className="mt-0.5 text-[11px] font-medium uppercase tracking-[0.15em] text-slate-500">
            Based on CBSE Pattern
          </p>
          <p
            className={`mt-3 inline-block rounded-full bg-blue-900 px-5 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-white ${PRINT_EXACT}`}
          >
            {scope ? `${EXAM_LABELS[scope]} Report Card` : 'Report Card'}
          </p>
          {/* Under the tablet rather than among the student's details: the session says
              which card this is, not who it belongs to. */}
          <p className="mt-2 text-sm font-medium text-slate-700">Session {year.academicYear}</p>
        </div>
        {/* Balances the crest so the name block stays optically centred. */}
        {!logoFailed && <div className="hidden h-24 w-24 shrink-0 sm:block sm:h-28 sm:w-28" aria-hidden />}
      </header>

      <div className="px-6 sm:px-8">
        <div className="border-t-2 border-blue-900" />
      </div>

      <dl className="grid gap-x-10 gap-y-2.5 px-6 py-5 text-sm sm:grid-cols-2 sm:px-8">
        <Detail label="Name" value={studentName} />
        <Detail label="Class" value={classLabel(year.classCode)} />
        {/* "Parent's Name" rather than the relation: it reads correctly whether the
            record holds a father, a mother or another guardian. */}
        <Detail label="Parent's Name" value={guardian?.name ?? '—'} />
        <Detail label="Roll No" value={year.rollNo === null ? '—' : String(year.rollNo)} />
      </dl>

      <div className="px-6 pb-2 sm:px-8">
        <SectionHeading>Scholastic Assessment</SectionHeading>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className={`bg-blue-900 text-xs uppercase tracking-wide text-white ${PRINT_EXACT}`}>
              <th scope="col" className="border border-blue-900 px-3 py-2 text-left font-semibold">
                Subject
              </th>
              {columns.map((code) => (
                <th
                  key={code}
                  scope="col"
                  className="border border-blue-900 px-2 py-2 text-center font-semibold"
                >
                  {EXAM_LABELS[code]}
                  <span className="block text-[10px] font-normal normal-case text-blue-100">
                    out of {MAX_SUBJECT_MARK[code]}
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {subjects.map((subject, index) => (
              <tr key={subject} className={index % 2 === 1 ? `bg-slate-50 ${PRINT_EXACT}` : undefined}>
                <th
                  scope="row"
                  className="border border-slate-300 px-3 py-1.5 text-left font-normal text-slate-800"
                >
                  {SUBJECT_LABELS[subject]}
                </th>
                {columns.map((code) => {
                  const mark = year.subjectMarks[code][subject];
                  return (
                    <td
                      key={code}
                      className={`border border-slate-300 px-2 py-1.5 text-center tabular-nums ${
                        mark === null ? 'text-slate-400' : 'text-slate-900'
                      }`}
                    >
                      {mark ?? '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>

          <tfoot>
            <tr className={`bg-slate-100 font-semibold text-slate-900 ${PRINT_EXACT}`}>
              <th scope="row" className="border border-slate-400 px-3 py-2 text-left">
                Total
              </th>
              {totals.map((total, index) => (
                <td
                  key={columns[index]}
                  className="border border-slate-400 px-2 py-2 text-center tabular-nums"
                >
                  {total ? `${total.obtained}/${total.max}` : '—'}
                </td>
              ))}
            </tr>
            <tr className={`bg-blue-50 font-bold text-blue-900 ${PRINT_EXACT}`}>
              <th scope="row" className="border border-slate-400 px-3 py-2 text-left">
                Percentage
              </th>
              {totals.map((total, index) => {
                const code = columns[index]!;
                // Falls back to the stored percentage for a paper recorded before
                // subject-wise entry, which has no marks to add up.
                const percent = total ? total.percent : year.scores[code];
                return (
                  <td
                    key={code}
                    className="border border-slate-400 px-2 py-2 text-center tabular-nums"
                  >
                    {percent === null ? '—' : `${percent.toFixed(2)}%`}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="px-6 pb-5 pt-4 sm:px-8">
        <SectionHeading>Co-Scholastic Assessment</SectionHeading>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr
              className={`bg-slate-100 text-xs uppercase tracking-wide text-slate-700 ${PRINT_EXACT}`}
            >
              <th scope="col" className="border border-slate-400 px-3 py-1.5 text-left font-semibold">
                Area
              </th>
              {columns.map((code) => (
                <th
                  key={code}
                  scope="col"
                  className="border border-slate-400 px-2 py-1.5 text-center font-semibold"
                >
                  {EXAM_LABELS[code]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {GRADED_SUBJECT_CODES.map((subject) => (
              <tr key={subject}>
                <th
                  scope="row"
                  className="border border-slate-300 px-3 py-1.5 text-left font-normal text-slate-800"
                >
                  {SUBJECT_LABELS[subject]}
                </th>
                {columns.map((code) => {
                  const grade = year.subjectGrades[code][subject];
                  return (
                    <td
                      key={code}
                      className={`border border-slate-300 px-2 py-1.5 text-center uppercase ${
                        grade === null ? 'text-slate-400' : 'font-medium text-slate-900'
                      }`}
                    >
                      {grade ?? '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-end justify-between gap-6 px-6 pb-6 pt-10 text-xs uppercase tracking-wide text-slate-600 sm:px-8">
        {['Class Teacher', 'Principal', 'Parent'].map((role) => (
          <span key={role} className="w-28 border-t border-slate-500 pt-1 text-center">
            {role}
          </span>
        ))}
      </div>
    </article>
  );
}
