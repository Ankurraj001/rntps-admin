import { declareHolidaySchema, type DeclareHolidayPayload } from '@rntps/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { attendanceApi, attendanceKeys } from '@/api/attendance';
import { reportKeys } from '@/api/reports';
import { settingsKeys } from '@/api/settings';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { ErrorBlock, Spinner } from '@/components/ui/Feedback';
import { Modal } from '@/components/ui/Modal';
import { ApiError } from '@/lib/api';
import { formatDate } from '@/lib/utils';

interface MarkHolidayModalProps {
  dateKey: string;
  /**
   * How many attendance rows already exist for the day. A holiday is derived, so those
   * rows stop being read the moment it is declared — the one consequence worth stating
   * before the button is pressed rather than discovering in the monthly sheet.
   */
  alreadyMarked: number;
  onClose: () => void;
}

export function MarkHolidayModal({ dateKey, alreadyMarked, onClose }: MarkHolidayModalProps) {
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<DeclareHolidayPayload>({
    // The same schema the API validates against, so "2–80 characters" is enforced here
    // rather than only being reported after a round trip.
    resolver: zodResolver(declareHolidaySchema),
    defaultValues: { dateKey, label: '' },
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  const mutation = useMutation({
    mutationFn: (payload: DeclareHolidayPayload) => attendanceApi.declareHoliday(payload),
    onSuccess: async () => {
      // Every register, the monthly grid and the dashboard nudge all read the school
      // calendar, so all three are stale the instant this lands.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: attendanceKeys.all }),
        queryClient.invalidateQueries({ queryKey: reportKeys.dashboard }),
        queryClient.invalidateQueries({ queryKey: settingsKeys.all }),
      ]);
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError) {
        for (const detail of error.fieldErrors) {
          if (detail.field === 'label' || detail.field === 'dateKey') {
            form.setError(detail.field, { message: detail.message });
          }
        }
        setServerError(error.fieldErrors.length ? null : error.message);
        return;
      }
      setServerError((error as Error).message);
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Mark as a school holiday"
      description="Applies to every class and the teacher register. Nobody needs to mark it separately."
    >
      <form
        noValidate
        onSubmit={form.handleSubmit((payload) => {
          setServerError(null);
          mutation.mutate(payload);
        })}
      >
        <div className="space-y-4 px-5 py-4">
          {serverError && <ErrorBlock message={serverError} />}

          <Field label="Date">
            <p className="text-sm font-medium text-slate-900">{formatDate(dateKey)}</p>
          </Field>

          <Field
            label="Reason"
            htmlFor="holiday-label"
            required
            error={form.formState.errors.label?.message}
            hint="Shown on the register and the monthly sheet."
          >
            <Input
              id="holiday-label"
              autoFocus
              placeholder="Diwali"
              aria-invalid={form.formState.errors.label ? true : undefined}
              {...form.register('label')}
            />
          </Field>

          {alreadyMarked > 0 && (
            <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                Attendance is already marked for <strong>{alreadyMarked}</strong> student
                {alreadyMarked === 1 ? '' : 's'} today. Declaring a holiday means those marks stop
                counting — clear the holiday to bring them back.
              </span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending && <Spinner />}
            Mark holiday
          </Button>
        </div>
      </form>
    </Modal>
  );
}
