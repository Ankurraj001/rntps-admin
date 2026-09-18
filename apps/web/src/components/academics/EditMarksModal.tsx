import { zodResolver } from '@hookform/resolvers/zod';
import {
  EXAM_CODES,
  EXAM_LABELS,
  GRADED_SUBJECT_CODES,
  GRADE_MAX_LENGTH,
  MAX_SUBJECT_MARK,
  SUBJECT_CODES,
  SUBJECT_LABELS,
  classLabel,
  examSubjectGradesSchema,
  examSubjectMarksSchema,
  examTotal,
  subjectMarksForClass,
  subjectsForClass,
  type AcademicRow,
  type ExamCode,
  type ExamScores,
  type GradedSubjectCode,
  type SubjectCode,
} from '@rntps/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import { useState } from 'react';
import { type ChangeEvent } from 'react';
import { useForm, useWatch, type Control, type Path } from 'react-hook-form';
import { academicKeys, academicsApi } from '@/api/academics';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { ErrorBlock, Spinner } from '@/components/ui/Feedback';
import { Modal } from '@/components/ui/Modal';
import { ApiError } from '@/lib/api';
import { z } from 'zod';

interface EditMarksModalProps {
  row: AcademicRow;
  onClose: () => void;
}

/**
 * The form holds both halves of the card under the names the API uses, so a server error
 * at `subjectMarks.UT1.ENGLISH` addresses the very field it came from and needs no path
 * rewriting on the way in.
 */
const marksFormSchema = z.object({
  subjectMarks: examSubjectMarksSchema,
  subjectGrades: examSubjectGradesSchema,
});

type MarksForm = z.output<typeof marksFormSchema>;

/**
 * Blank means "not recorded", which is a different thing from zero — a student who has
 * not sat a paper must not read as having scored nothing.
 *
 * Number() is used raw here, and it matters more than it used to. The Math.trunc coercion
 * every other form in this app applies is right for whole rupees and quietly wrong for a
 * mark: it would turn a mistyped 17.5 into a filed 17. A subject mark *is* a whole number,
 * but the way to say so is to let 17.5 reach zod and be rejected, not to floor it here.
 */
function toMark(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Refuses a keystroke that would put a box over its paper's maximum, by restoring what was
 * there before — the same way `maxLength` refuses an eleventh character in a grade box.
 *
 * Refused, not clamped. Turning a typed 25 into 20 is the silent-alteration this form
 * avoids everywhere else: `toMark` deliberately lets 17.5 through so zod can reject it
 * rather than flooring it to 17, and quietly rewriting 25 as a perfectly plausible 20
 * would be worse, because nothing on screen would say it had happened.
 *
 * The previous value comes from the form rather than the DOM: this runs before the
 * registered handler, so what react-hook-form is holding is still the last one accepted.
 */
function refuseOutOfRange(
  event: ChangeEvent<HTMLInputElement>,
  max: number,
  previous: number | null | undefined,
): void {
  const raw = event.target.value;
  if (raw === '') return;

  const value = Number(raw);
  // A half-typed "17." parses to 17 and is left alone, so a fractional mark still reaches
  // zod and is still rejected there rather than being blocked mid-keystroke.
  if (Number.isNaN(value) || (value <= max && value >= 0)) return;

  event.target.value = previous === null || previous === undefined ? '' : String(previous);
}

/** `subjectMarks.UT1.ENGLISH`, typed — what react-hook-form registers each cell against. */
function markPath(exam: ExamCode, subject: SubjectCode): Path<MarksForm> {
  return `subjectMarks.${exam}.${subject}`;
}

function gradePath(exam: ExamCode, subject: GradedSubjectCode): Path<MarksForm> {
  return `subjectGrades.${exam}.${subject}`;
}

/** Blank clears the grade, so an emptied box reads as "not graded", not as an empty grade. */
function toGrade(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

/**
 * The subject column, which stays put while the papers scroll under it.
 *
 * Sticky rather than frozen by a second table: on a phone the six papers cannot fit, and a
 * grid of numbers with the row labels scrolled off is unreadable. The opaque background is
 * load-bearing — without it the scrolled cells show through.
 */
const STICKY_LABEL = 'sticky left-0 z-10 bg-white pl-5 pr-3 text-left sm:pl-3';

/** The footer outranks the sticky column, which otherwise scrolls up over the buttons. */
const STICKY_FOOTER =
  'sticky bottom-0 z-20 flex justify-end gap-2 rounded-b-lg border-t border-slate-200 bg-white px-5 py-3';

/**
 * What each paper comes to, recomputed as marks are typed.
 *
 * One subscription to the whole form rendering both footer rows, rather than one per cell:
 * there are up to 42 inputs here, and a `watch()` in the parent would re-render every one
 * of them on each digit. Only these two rows redraw.
 */
function TotalRows({
  control,
  classCode,
  storedScores,
  legacyPapers,
}: {
  control: Control<MarksForm>;
  classCode: string;
  storedScores: ExamScores;
  legacyPapers: Set<ExamCode>;
}) {
  // Only the marks branch is watched. Typing a grade cannot redraw a total, which is the
  // same separation the schema enforces one layer down.
  const marks = useWatch({ control, name: 'subjectMarks' });
  const totals = EXAM_CODES.map((code) => examTotal(marks?.[code], classCode, code));

  return (
    <>
      <tr>
        <th scope="row" className={`${STICKY_LABEL} py-2 font-medium text-slate-900`}>
          Total
        </th>
        {totals.map((total, index) => (
          <td
            key={EXAM_CODES[index]}
            className={
              total
                ? 'px-1.5 py-2 text-center font-medium tabular-nums text-slate-900'
                : 'px-1.5 py-2 text-center text-slate-400'
            }
          >
            {total ? `${total.obtained}/${total.max}` : '—'}
          </td>
        ))}
      </tr>
      <tr>
        <th scope="row" className={`${STICKY_LABEL} py-2 font-medium text-slate-900`}>
          Percentage
        </th>
        {totals.map((total, index) => {
          const code = EXAM_CODES[index]!;
          // A paper with no marks behind it falls back to the stored percentage, which can
          // only have come from before subject-wise entry. Amber says "this is not derived
          // from anything on screen" without needing a note per column.
          const legacy = !total && legacyPapers.has(code);
          const percent = total ? total.percent : legacy ? storedScores[code] : null;

          return (
            <td
              key={code}
              className={
                percent === null
                  ? 'px-1.5 py-2 text-center text-slate-400'
                  : `px-1.5 py-2 text-center font-medium tabular-nums ${
                      legacy ? 'text-amber-700' : 'text-slate-900'
                    }`
              }
              title={legacy ? 'Recorded before subject-wise entry' : undefined}
            >
              {percent === null ? '—' : `${percent.toFixed(2)}%`}
            </td>
          );
        })}
      </tr>
    </>
  );
}

export function EditMarksModal({ row, onClose }: EditMarksModalProps) {
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

  const subjects = subjectsForClass(row.classCode);

  // Papers holding a percentage with no marks behind it. Read from the row rather than the
  // form, so it does not change under the teacher as they type.
  const legacyPapers = new Set(
    EXAM_CODES.filter(
      (code) =>
        row.scores[code] !== null && !subjects.some((s) => row.subjectMarks[code][s] !== null),
    ),
  );

  const form = useForm<MarksForm>({
    // The same schemas the API validates against, so "whole numbers" and "out of 20" are
    // enforced here rather than only being reported after a round trip.
    resolver: zodResolver(marksFormSchema),
    defaultValues: {
      // Projected to this class first: the form posts back its defaults whether or not a
      // field was rendered, so a mark left behind by a subject the class no longer sits
      // would be sent invisibly and rejected on an input that is not on screen.
      subjectMarks: subjectMarksForClass(row.subjectMarks, row.classCode),
      // Grades need no projection — every class is graded on all three.
      subjectGrades: row.subjectGrades,
    },
    // Matching the student form: errors appear on submit, then track every keystroke.
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  const mutation = useMutation({
    mutationFn: (values: MarksForm) =>
      academicsApi.saveMarks({
        studentId: row.studentId,
        academicYear: row.academicYear,
        ...values,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: academicKeys.all });
      onClose();
    },
    onError: (error: unknown) => {
      if (!(error instanceof ApiError)) {
        setServerError((error as Error).message);
        return;
      }

      // The API's field paths are the form's field names, so a cell error addresses its
      // own input. Anything that does not resolve to a real cell — an error on the card as
      // a whole, say — falls through to the banner rather than being set on a field that
      // is not there to show it.
      let unplaceable = 0;
      for (const detail of error.fieldErrors) {
        const [branch, exam, subject] = detail.field.split('.');
        const known =
          EXAM_CODES.includes(exam as ExamCode) &&
          ((branch === 'subjectMarks' && SUBJECT_CODES.includes(subject as SubjectCode)) ||
            (branch === 'subjectGrades' &&
              GRADED_SUBJECT_CODES.includes(subject as GradedSubjectCode)));

        if (known) {
          form.setError(detail.field as Path<MarksForm>, { message: detail.message });
        } else {
          unplaceable += 1;
        }
      }
      setServerError(unplaceable > 0 || error.fieldErrors.length === 0 ? error.message : null);
    },
  });

  const errors = form.formState.errors;
  const markError = (exam: ExamCode, subject: SubjectCode) =>
    errors.subjectMarks?.[exam]?.[subject]?.message;
  const gradeError = (exam: ExamCode, subject: GradedSubjectCode) =>
    errors.subjectGrades?.[exam]?.[subject]?.message;

  /**
   * Every bad cell, named.
   *
   * A grid has nowhere to hang an inline message — `Field`'s label-and-error stack does not
   * fit a table cell, and forty of them would not fit the dialog. So the cell turns red and
   * the reason is listed once, above, saying which subject and which paper it belongs to.
   */
  const cellErrors = EXAM_CODES.flatMap((code) =>
    [
      ...subjects.map((subject) => ({ subject, message: markError(code, subject) })),
      ...GRADED_SUBJECT_CODES.map((subject) => ({ subject, message: gradeError(code, subject) })),
    ]
      .filter((entry): entry is typeof entry & { message: string } => Boolean(entry.message))
      .map((entry) => ({
        key: `${code}.${entry.subject}`,
        label: `${SUBJECT_LABELS[entry.subject]} · ${EXAM_LABELS[code]}`,
        message: entry.message,
      })),
  );

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={`Edit marks — ${row.fullName}`}
      description={`${classLabel(row.classCode)} · Roll ${row.rollNo ?? '—'} · ${row.academicYear}`}
    >
      <form
        noValidate
        onSubmit={form.handleSubmit((subjectMarks) => {
          setServerError(null);
          mutation.mutate(subjectMarks);
        })}
      >
        <div className="space-y-4 px-5 py-4">
          {serverError && <ErrorBlock message={serverError} />}

          <p className="text-sm text-slate-500">
            Marks are whole numbers. The total and percentage are worked out from them, and count
            only the subjects filled in — leave a subject blank if it has not been marked yet.
            Drawing, discipline and neatness take a grade and count towards neither.
          </p>

          {cellErrors.length > 0 && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-md bg-red-50 p-4 text-sm text-red-800"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <ul className="space-y-0.5">
                {cellErrors.map((entry) => (
                  <li key={entry.key}>
                    <span className="font-medium">{entry.label}</span> — {entry.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Scrolls sideways on a narrow screen rather than reflowing: a mark sheet read
              down a column is the thing being reproduced, and stacking it by paper is what
              made this dialog too tall to use in the first place. */}
          <div className="-mx-5 overflow-x-auto sm:mx-0">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th scope="col" className={`${STICKY_LABEL} pb-2 font-medium`}>
                    Subject
                  </th>
                  {EXAM_CODES.map((code) => (
                    <th key={code} scope="col" className="px-1.5 pb-2 text-center font-medium">
                      {EXAM_LABELS[code]}
                      <span className="block font-normal normal-case text-slate-400">
                        out of {MAX_SUBJECT_MARK[code]}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {subjects.map((subject, subjectIndex) => (
                  <tr key={subject}>
                    <th
                      scope="row"
                      className={`${STICKY_LABEL} py-1 font-normal text-slate-700`}
                    >
                      {SUBJECT_LABELS[subject]}
                    </th>
                    {EXAM_CODES.map((code) => {
                      const invalid = Boolean(markError(code, subject));
                      const max = MAX_SUBJECT_MARK[code];
                      const path = markPath(code, subject);
                      const field = form.register(path, { setValueAs: toMark });
                      return (
                        <td key={code} className="px-1.5 py-1">
                          <Input
                            type="number"
                            inputMode="numeric"
                            step="1"
                            min={0}
                            max={max}
                            className="w-16 px-2 text-center tabular-nums"
                            // The column and row headers name this cell on screen, but a
                            // screen reader reading the input alone needs both said again.
                            aria-label={`${SUBJECT_LABELS[subject]} — ${EXAM_LABELS[code]}, out of ${max}`}
                            aria-invalid={invalid ? true : undefined}
                            autoFocus={code === 'UT1' && subjectIndex === 0}
                            {...field}
                            // After the spread, so this wraps the registered handler
                            // rather than being replaced by it.
                            onChange={(event) => {
                              refuseOutOfRange(event, max, form.getValues(path) as number | null);
                              return field.onChange(event);
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>

              {/* Its own body with a caption, because "this does not count" is the whole
                  point of the distinction and a row that merely looks different would not
                  say it. */}
              <tbody>
                <tr>
                  <td
                    colSpan={EXAM_CODES.length + 1}
                    className="sticky left-0 pl-5 pt-4 pb-1 text-xs font-medium uppercase tracking-wide text-slate-500 sm:pl-3"
                  >
                    Graded
                  </td>
                </tr>
                {GRADED_SUBJECT_CODES.map((subject) => (
                  <tr key={subject}>
                    <th scope="row" className={`${STICKY_LABEL} py-1 font-normal text-slate-700`}>
                      {SUBJECT_LABELS[subject]}
                    </th>
                    {EXAM_CODES.map((code) => {
                      const invalid = Boolean(gradeError(code, subject));
                      return (
                        <td key={code} className="px-1.5 py-1">
                          <Input
                            type="text"
                            maxLength={GRADE_MAX_LENGTH}
                            className="w-16 px-2 text-center uppercase"
                            aria-label={`${SUBJECT_LABELS[subject]} — ${EXAM_LABELS[code]}, grade`}
                            aria-invalid={invalid ? true : undefined}
                            {...form.register(gradePath(code, subject), { setValueAs: toGrade })}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>

              <tfoot className="border-t border-slate-200">
                <TotalRows
                  control={form.control}
                  classCode={row.classCode}
                  storedScores={row.scores}
                  legacyPapers={legacyPapers}
                />
              </tfoot>
            </table>
          </div>

          {legacyPapers.size > 0 && (
            <p className="text-sm text-amber-800">
              Percentages shown in amber were recorded before subject-wise entry. Enter that
              paper's subjects to replace one.
            </p>
          )}
        </div>

        {/* Sticky: on a phone the card still scrolls, and a Save button below the fold
            reads as a form with no way to submit it. */}
        <div className={STICKY_FOOTER}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending && <Spinner />}
            Save marks
          </Button>
        </div>
      </form>
    </Modal>
  );
}
