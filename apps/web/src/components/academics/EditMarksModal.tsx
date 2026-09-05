import { zodResolver } from '@hookform/resolvers/zod';
import {
  EXAM_CODES,
  EXAM_LABELS,
  classLabel,
  examScoresSchema,
  type AcademicRow,
  type ExamCode,
  type ExamScores,
} from '@rntps/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { academicKeys, academicsApi } from '@/api/academics';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { ErrorBlock, Spinner } from '@/components/ui/Feedback';
import { Modal } from '@/components/ui/Modal';
import { ApiError } from '@/lib/api';

interface EditMarksModalProps {
  row: AcademicRow;
  onClose: () => void;
}

/**
 * Blank means "not recorded", which is a different thing from zero — a student who has
 * not sat a paper must not read as having scored nothing.
 *
 * Number() is used raw here. The Math.trunc coercion every other form in this app applies
 * is right for whole rupees and quietly wrong for a mark: it would turn 87.5 into 87.
 */
function toMark(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function EditMarksModal({ row, onClose }: EditMarksModalProps) {
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<ExamScores>({
    // The same schema the API validates against, so "two decimal places" is enforced
    // here rather than only being reported after a round trip.
    resolver: zodResolver(examScoresSchema),
    defaultValues: { ...row.scores },
    // Matching the student form: errors appear on submit, then track every keystroke.
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  const mutation = useMutation({
    mutationFn: (scores: ExamScores) =>
      academicsApi.saveMarks({ studentId: row.studentId, academicYear: row.academicYear, scores }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: academicKeys.all });
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError) {
        for (const detail of error.fieldErrors) {
          // The API reports these as "scores.UT1"; the form is keyed on the exam alone.
          const code = detail.field.replace(/^scores\./, '') as ExamCode;
          if (EXAM_CODES.includes(code)) form.setError(code, { message: detail.message });
        }
        setServerError(error.fieldErrors.length ? null : error.message);
        return;
      }
      setServerError((error as Error).message);
    },
  });

  const errors = form.formState.errors;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit marks — ${row.fullName}`}
      description={`${classLabel(row.classCode)} · Roll ${row.rollNo ?? '—'} · ${row.academicYear}`}
    >
      <form
        noValidate
        onSubmit={form.handleSubmit((scores) => {
          setServerError(null);
          mutation.mutate(scores);
        })}
      >
        <div className="space-y-4 px-5 py-4">
          {serverError && <ErrorBlock message={serverError} />}

          <p className="text-sm text-slate-500">
            Marks are percentages, to at most two decimal places. Leave a paper blank if it has not
            been sat yet.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            {EXAM_CODES.map((code) => (
              <Field key={code} label={EXAM_LABELS[code]} htmlFor={`score-${code}`} error={errors[code]?.message}>
                <div className="relative">
                  <Input
                    id={`score-${code}`}
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min={0}
                    max={100}
                    className="pr-8 text-right tabular-nums"
                    aria-invalid={errors[code] ? true : undefined}
                    autoFocus={code === 'UT1'}
                    {...form.register(code, { setValueAs: toMark })}
                  />
                  <span
                    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400"
                    aria-hidden
                  >
                    %
                  </span>
                </div>
              </Field>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
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
