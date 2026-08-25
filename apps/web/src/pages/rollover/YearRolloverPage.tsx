import { classLabel } from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Check, Circle, Copy, GraduationCap } from 'lucide-react';
import { feeKeys, feesApi } from '@/api/fees';
import { settingsApi, settingsKeys } from '@/api/settings';
import { studentKeys, studentsApi } from '@/api/students';
import { PageHeader } from '@/components/layout/AppShell';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ErrorBlock, LoadingBlock, Spinner } from '@/components/ui/Feedback';
import { cn } from '@/lib/utils';

/**
 * The annual March→April session change, as three ordered steps.
 *
 * The order is the point. Each step is a separate endpoint with no knowledge of the others,
 * and doing them out of order breaks things quietly:
 *
 * - Copy the fee structures **first**, because cloning reads the *source* year. Flip the
 *   year before copying and every class is left unpriced.
 * - Set the session year **second**, because promotion refuses to run into a year the
 *   school is not in yet.
 * - Promote **last**. Leaving this undone after the flip makes the monthly run price last
 *   year's classes against this year's structures — the whole school billed one class
 *   behind, with nothing to say so.
 *
 * Every step is safe to repeat, so a half-finished rollover is resumed by reloading.
 */
export function YearRolloverPage() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: studentKeys.rollover,
    queryFn: studentsApi.rolloverStatus,
  });

  const refreshAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: studentKeys.all }),
      queryClient.invalidateQueries({ queryKey: settingsKeys.all }),
      queryClient.invalidateQueries({ queryKey: feeKeys.all }),
    ]);
  };

  const from = status.data?.fromAcademicYear ?? '';
  const to = status.data?.toAcademicYear ?? '';

  const clone = useMutation({
    // Both years passed explicitly. The fee-structure page infers the source from settings,
    // which is what makes its own copy button order-dependent; this one is not.
    mutationFn: () => feesApi.cloneStructures(from, to),
    onSuccess: refreshAll,
  });
  const setYear = useMutation({
    mutationFn: () => settingsApi.update({ activeAcademicYear: to }),
    onSuccess: refreshAll,
  });
  const preview = useMutation({
    mutationFn: () =>
      studentsApi.promote({ fromAcademicYear: from, toAcademicYear: to, dryRun: true }),
  });
  const apply = useMutation({
    mutationFn: () =>
      studentsApi.promote({ fromAcademicYear: from, toAcademicYear: to, dryRun: false }),
    onSuccess: async () => {
      preview.reset();
      await refreshAll();
    },
  });

  if (status.isPending) return <LoadingBlock />;
  if (status.error) {
    return (
      <div className="p-6">
        <ErrorBlock message={(status.error as Error).message} />
      </div>
    );
  }

  const data = status.data;
  const steps = data.steps;
  const plan = preview.data ?? apply.data;
  const staleCohorts = data.cohorts.filter((cohort) => cohort.academicYear < data.activeAcademicYear);

  return (
    <>
      <PageHeader
        title="Year rollover"
        description={`${from} → ${to} · every step is safe to run again`}
      />

      <div className="space-y-4 p-6">
        {data.notStarted && (
          <Card>
            <CardBody className="flex items-start gap-3 text-sm text-slate-700">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
              <p>
                The current session is <strong>{data.activeAcademicYear}</strong> and every student is
                in it — nothing is part-finished. Run these steps when the session ends in March.
              </p>
            </CardBody>
          </Card>
        )}

        {staleCohorts.length > 1 && (
          <Card className="border-amber-300 bg-amber-50">
            <CardBody className="flex items-start gap-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div>
                <p className="font-medium">More than one session is behind.</p>
                <p className="mt-1">
                  {staleCohorts.map((c) => `${c.count} in ${c.academicYear}`).join(', ')}. A rollover
                  moves one session at a time, so this will promote {from} only. Run it again for the
                  rest.
                </p>
              </div>
            </CardBody>
          </Card>
        )}

        <Step
          index={1}
          title="Copy the fee structures forward"
          done={steps.feeStructuresCloned}
          detail={`Every class's heads and amounts from ${from} are copied to ${to}. Amounts are copied unchanged — revise them on the Fee structure page afterwards.`}
        >
          {clone.error && <ErrorBlock message={(clone.error as Error).message} />}
          {clone.data && (
            <p className="text-sm text-slate-600">
              Copied <strong>{clone.data.copied}</strong>
              {clone.data.skipped > 0 && `, skipped ${clone.data.skipped} already there`}.
            </p>
          )}
          <Button
            variant={steps.feeStructuresCloned ? 'secondary' : 'primary'}
            onClick={() => clone.mutate()}
            disabled={clone.isPending}
          >
            {clone.isPending && <Spinner />}
            <Copy className="h-4 w-4" aria-hidden />
            Copy {from} → {to}
          </Button>
        </Step>

        <Step
          index={2}
          title="Set the new session year"
          done={steps.academicYearSet}
          detail={`Generated student IDs and receipt numbers follow this year, and the fee run prices from it. Currently ${data.activeAcademicYear}.`}
          blockedBy={!steps.feeStructuresCloned ? 'Copy the fee structures first, or every class starts the new session unpriced.' : null}
        >
          {setYear.error && <ErrorBlock message={(setYear.error as Error).message} />}
          <Button
            variant={steps.academicYearSet ? 'secondary' : 'primary'}
            onClick={() => setYear.mutate()}
            disabled={setYear.isPending || !steps.feeStructuresCloned || steps.academicYearSet}
          >
            {setYear.isPending && <Spinner />}
            <ArrowRight className="h-4 w-4" aria-hidden />
            Set active year to {to}
          </Button>
        </Step>

        <Step
          index={3}
          title="Promote the students"
          done={steps.studentsPromoted}
          detail="Every student on the roll moves up one class. Class 8 and anyone holding a transfer certificate become alumni. Roll numbers are cleared for reassignment."
          blockedBy={!steps.academicYearSet ? `Set the active year to ${to} first — promotion will not run into a session the school is not in.` : null}
        >
          {preview.error && <ErrorBlock message={(preview.error as Error).message} />}
          {apply.error && <ErrorBlock message={(apply.error as Error).message} />}

          {plan && (
            <div className="space-y-2 rounded-md bg-slate-50 p-3 text-sm">
              <div className="flex flex-wrap gap-4">
                <span>
                  <strong>{plan.promoted.length}</strong> move up
                </span>
                <span>
                  <strong>{plan.graduated.length}</strong> become alumni
                </span>
                {plan.skipped.length > 0 && (
                  <span className="text-amber-800">
                    <strong>{plan.skipped.length}</strong> need attention
                  </span>
                )}
              </div>

              {plan.promoted.length > 0 && (
                <p className="text-xs text-slate-600">
                  {summariseMoves(plan.promoted)}
                </p>
              )}

              {/* Surfaced rather than passed over: a record nothing can promote needs
                  fixing, and it used to be turned into an alumnus in silence. */}
              {plan.skipped.map((entry) => (
                <p key={entry.studentId} className="text-xs text-amber-800">
                  {entry.studentId}: {entry.reason}
                </p>
              ))}

              {apply.data && (
                <p className="flex items-center gap-2 text-emerald-800">
                  <Check className="h-4 w-4" aria-hidden />
                  Done.
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => preview.mutate()}
              disabled={preview.isPending || !steps.academicYearSet}
            >
              {preview.isPending && <Spinner />}
              Preview
            </Button>
            {/* Deliberately gated on a preview: this rewrites every student in one call. */}
            <Button
              onClick={() => apply.mutate()}
              disabled={apply.isPending || !preview.data || preview.data.promoted.length + preview.data.graduated.length === 0}
            >
              {apply.isPending && <Spinner />}
              <GraduationCap className="h-4 w-4" aria-hidden />
              Apply
            </Button>
          </div>
        </Step>

        <Card>
          <CardHeader title="Students on the roll" description="Grouped by the session on their record." />
          <CardBody className="flex flex-wrap gap-2">
            {data.cohorts.length === 0 && <p className="text-sm text-slate-500">No students yet.</p>}
            {data.cohorts.map((cohort) => (
              <Badge
                key={cohort.academicYear}
                tone={cohort.academicYear < data.activeAcademicYear ? 'amber' : 'green'}
              >
                {cohort.academicYear}: {cohort.count}
              </Badge>
            ))}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

/** "Nursery → LKG, UKG → 1" — enough to spot a wrong year pair before applying it. */
function summariseMoves(promoted: { from: string; to: string }[]): string {
  const seen = new Map<string, number>();
  for (const move of promoted) {
    const key = `${classLabel(move.from)} → ${classLabel(move.to)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].map(([move, count]) => `${move} (${count})`).join(', ');
}

function Step({
  index,
  title,
  detail,
  done,
  blockedBy,
  children,
}: {
  index: number;
  title: string;
  detail: string;
  done: boolean;
  blockedBy?: string | null;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn(done && 'border-emerald-300')}>
      <CardBody className="space-y-3">
        <div className="flex items-start gap-3">
          {done ? (
            <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
          ) : (
            <Circle className="mt-0.5 h-5 w-5 shrink-0 text-slate-300" aria-hidden />
          )}
          <div>
            <p className="font-medium text-slate-900">
              {index}. {title}
            </p>
            <p className="mt-0.5 text-sm text-slate-600">{detail}</p>
          </div>
        </div>

        {blockedBy ? (
          <p className="ml-8 text-sm text-amber-800">{blockedBy}</p>
        ) : (
          <div className="ml-8 space-y-3">{children}</div>
        )}
      </CardBody>
    </Card>
  );
}
