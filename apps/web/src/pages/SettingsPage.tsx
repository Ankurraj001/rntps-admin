import {
  DEFAULT_REPORT_SCOPE,
  REPORT_SCOPE_CODES,
  REPORT_SCOPE_LABELS,
  isSunday,
  toDateKey,
  type Holiday,
  type ReportScopeCode,
  type SettingsDto,
} from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { attendanceApi, attendanceKeys } from '@/api/attendance';
import { reportKeys } from '@/api/reports';
import { settingsApi, settingsKeys } from '@/api/settings';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DateInput } from '@/components/ui/DateInput';
import { ErrorBlock, LoadingBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Field';
import { formatDate } from '@/lib/utils';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery({ queryKey: settingsKeys.all, queryFn: settingsApi.get });

  const [form, setForm] = useState<Partial<SettingsDto>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const mutation = useMutation({
    mutationFn: () =>
      settingsApi.update({
        schoolName: form.schoolName,
        schoolAddress: form.schoolAddress,
        schoolPhone: form.schoolPhone,
        activeAcademicYear: form.activeAcademicYear,
        studentIdPrefix: form.studentIdPrefix,
        feeDueDayOfMonth: form.feeDueDayOfMonth,
        defaultReportScope: form.defaultReportScope,
      }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      setTimeout(() => setSaved(false), 2500);
    },
  });

  if (isPending) return <LoadingBlock />;
  if (error) return <div className="p-4 sm:p-6"><ErrorBlock message={(error as Error).message} /></div>;

  function set<K extends keyof SettingsDto>(key: K, value: SettingsDto[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  return (
    <>
      <PageHeader title="Settings" description="School-wide configuration." />

      <div className="max-w-2xl space-y-5 p-4 sm:p-6">
        {mutation.error && <ErrorBlock message={(mutation.error as Error).message} />}

        <Card>
          <CardHeader title="School" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="School name" className="sm:col-span-2">
              <Input value={form.schoolName ?? ''} onChange={(e) => set('schoolName', e.target.value)} />
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <Input value={form.schoolAddress ?? ''} onChange={(e) => set('schoolAddress', e.target.value)} />
            </Field>
            <Field label="Phone">
              <Input value={form.schoolPhone ?? ''} onChange={(e) => set('schoolPhone', e.target.value)} />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Academic session & IDs"
            description="The prefix and active year shape every generated student ID."
          />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Active academic year" hint="Form: 2026-27">
              <Input
                value={form.activeAcademicYear ?? ''}
                onChange={(e) => set('activeAcademicYear', e.target.value)}
              />
            </Field>
            <Field label="Student ID prefix" hint={`Next ID: ${form.studentIdPrefix ?? ''}-${(form.activeAcademicYear ?? '----').slice(2, 4)}-${String((data.counters.student ?? 0) + 1).padStart(3, '0')}`}>
              <Input
                value={form.studentIdPrefix ?? ''}
                onChange={(e) => set('studentIdPrefix', e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Fee due day of month" hint="1–28">
              <Input
                type="number"
                min={1}
                max={28}
                value={form.feeDueDayOfMonth ?? 10}
                onChange={(e) => set('feeDueDayOfMonth', Number(e.target.value))}
              />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Report cards"
            description="Which paper a card opens on when a link does not name one."
          />
          <CardBody>
            <Field
              label="Default view"
              hint="Applies to a single student's card, to a class print run, and to the paper the print dialog suggests. Any card can still be switched to another paper once open."
            >
              <Select
                value={form.defaultReportScope ?? DEFAULT_REPORT_SCOPE}
                onChange={(e) => set('defaultReportScope', e.target.value as ReportScopeCode)}
              >
                {REPORT_SCOPE_CODES.map((code) => (
                  <option key={code} value={code}>
                    {REPORT_SCOPE_LABELS[code]}
                  </option>
                ))}
              </Select>
            </Field>
          </CardBody>
        </Card>

        <HolidaysCard holidays={data.holidays} />

        <Card>
          <CardHeader title="Counters" description="Read-only. These only move forward, so IDs are never reused." />
          <CardBody className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Students</p>
              <p className="text-lg font-semibold tabular-nums">{data.counters.student}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Families</p>
              <p className="text-lg font-semibold tabular-nums">{data.counters.family}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Receipts</p>
              <p className="text-lg font-semibold tabular-nums">{data.counters.receipt}</p>
            </div>
          </CardBody>
        </Card>

        <div className="flex items-center justify-end gap-3">
          {saved && <span className="text-sm text-emerald-700">Saved</span>}
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending && <Spinner />}
            Save settings
          </Button>
        </div>
      </div>
    </>
  );
}

/**
 * The school holiday calendar.
 *
 * Edited through the attendance endpoints rather than PATCH /settings, which takes the
 * whole array: two admins with the page open would each save the list they loaded and one
 * would silently lose their entry. Adding and removing one day at a time is also what lets
 * the dashboard's "Mark holiday" button share exactly this code path.
 *
 * Sundays are absent on purpose — they are derived from the calendar, not stored, so there
 * is nothing here to add or remove.
 */
function HolidaysCard({ holidays }: { holidays: Holiday[] }) {
  const queryClient = useQueryClient();
  const [dateKey, setDateKey] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: settingsKeys.all }),
      queryClient.invalidateQueries({ queryKey: attendanceKeys.all }),
      queryClient.invalidateQueries({ queryKey: reportKeys.dashboard }),
    ]);
  }

  const add = useMutation({
    mutationFn: () => attendanceApi.declareHoliday({ dateKey, label: label.trim() }),
    onSuccess: async () => {
      setDateKey('');
      setLabel('');
      setError(null);
      await refresh();
    },
    onError: (e: unknown) => setError((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: (day: string) => attendanceApi.clearHoliday(day),
    onSuccess: refresh,
    onError: (e: unknown) => setError((e as Error).message),
  });

  const sorted = [...holidays].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const today = toDateKey();
  // Mirrors the API's own two rules, so the common mistakes are caught without a round trip.
  const invalid = dateKey !== '' && isSunday(dateKey);
  const canAdd = dateKey !== '' && label.trim().length >= 2 && !invalid && !add.isPending;

  return (
    <Card>
      <CardHeader
        title="School holidays"
        description="Closes every class and the teacher register. Not markable, and not counted toward anyone's attendance."
      />
      <CardBody className="space-y-4">
        {error && <ErrorBlock message={error} />}

        {sorted.length === 0 ? (
          <p className="text-sm text-slate-500">No holidays declared yet. Sundays are automatic.</p>
        ) : (
          <ul className="divide-y divide-slate-200 text-sm">
            {sorted.map((holiday) => (
              <li key={holiday.dateKey} className="flex items-center gap-3 py-2">
                <span className="w-28 shrink-0 tabular-nums text-slate-600">
                  {formatDate(holiday.dateKey)}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-900">{holiday.label}</span>
                {/* Past holidays stay removable: the usual reason to remove one is that it
                    was declared by mistake, which is only noticed afterwards. */}
                {holiday.dateKey <= today && (
                  <span className="text-xs text-slate-400">past</span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${holiday.label}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(holiday.dateKey)}
                >
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4">
          <Field
            label="Date"
            htmlFor="holiday-date"
            error={invalid ? 'Sundays are already a holiday' : undefined}
          >
            <DateInput
              id="holiday-date"
              className="w-44"
              value={dateKey}
              aria-invalid={invalid ? true : undefined}
              onChange={setDateKey}
            />
          </Field>
          <Field label="Reason" htmlFor="holiday-reason" className="min-w-48 flex-1">
            <Input
              id="holiday-reason"
              placeholder="Diwali"
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Button disabled={!canAdd} onClick={() => add.mutate()}>
            {add.isPending && <Spinner />}
            Add
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
