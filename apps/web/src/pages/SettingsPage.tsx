import type { SettingsDto } from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { settingsApi, settingsKeys } from '@/api/settings';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ErrorBlock, LoadingBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input } from '@/components/ui/Field';

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
      }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      setTimeout(() => setSaved(false), 2500);
    },
  });

  if (isPending) return <LoadingBlock />;
  if (error) return <div className="p-6"><ErrorBlock message={(error as Error).message} /></div>;

  function set<K extends keyof SettingsDto>(key: K, value: SettingsDto[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  return (
    <>
      <PageHeader title="Settings" description="School-wide configuration." />

      <div className="max-w-2xl space-y-5 p-6">
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
