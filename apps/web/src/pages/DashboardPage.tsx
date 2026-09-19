import { CLASS_CODES, classLabel, formatINR, isSunday } from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarCheck,
  CalendarDays,
  // Gift,  — re-enable with the "other income" dashboard tile, see below
  IndianRupee,
  MessageSquare,
  Plus,
  TrendingUp,
  Users,
  // Wallet,  — re-enable with the profit/loss dashboard tile, see below
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { attendanceApi, attendanceKeys } from '@/api/attendance';
import { reportKeys, reportsApi } from '@/api/reports';
import { settingsKeys } from '@/api/settings';
import { useCurrentUser } from '@/auth/AuthProvider';
import { MarkHolidayModal } from '@/components/attendance/MarkHolidayModal';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ErrorBlock, LoadingBlock, Spinner } from '@/components/ui/Feedback';
import { formatDate } from '@/lib/utils';

export function DashboardPage() {
  const me = useCurrentUser();
  const isAdmin = me.role === 'ADMIN';
  const queryClient = useQueryClient();
  const [declaring, setDeclaring] = useState(false);

  const dashboard = useQuery({ queryKey: reportKeys.dashboard, queryFn: reportsApi.dashboard });
  const today = dashboard.data?.today;

  // The class bars are scaled against the biggest class, not against the roll total: eleven
  // classes sharing ~200 students puts a typical class under a tenth of the track, so every
  // bar read as a stub and the differences between them were the part that got lost. The
  // number beside each bar is still the count, so nothing here is claiming a percentage.
  const largestClassSize = Math.max(
    0,
    ...(dashboard.data?.studentsByClass.map((row) => row.count) ?? []),
  );

  const clearHoliday = useMutation({
    mutationFn: (dateKey: string) => attendanceApi.clearHoliday(dateKey),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: attendanceKeys.all }),
        queryClient.invalidateQueries({ queryKey: reportKeys.dashboard }),
        queryClient.invalidateQueries({ queryKey: settingsKeys.all }),
      ]);
    },
  });

  // A Sunday is derived from the calendar rather than declared, so there is no stored
  // entry to remove and no Undo to offer. Tested on the date rather than the label, which
  // is only the wording shown to the reader.
  const isDeclared = Boolean(today?.holiday) && !isSunday(today?.dateKey ?? '');

  return (
    <>
      <PageHeader
        title={`Good day, ${me.name.split(' ')[0]}`}
        description={
          // From the dashboard payload rather than GET /settings, which is admin-only.
          dashboard.data
            ? `${dashboard.data.school.name} · ${dashboard.data.school.academicYear}`
            : undefined
        }
        action={
          isAdmin ? (
            <Link to="/students/new">
              <Button>
                <Plus className="h-4 w-4" aria-hidden />
                Onboard student
              </Button>
            </Link>
          ) : (
            <Link to="/attendance">
              <Button>
                <CalendarCheck className="h-4 w-4" aria-hidden />
                Mark attendance
              </Button>
            </Link>
          )
        }
      />

      <div className="space-y-5 p-4 sm:p-6">
        {dashboard.isPending && <LoadingBlock />}
        {dashboard.error && (
          <ErrorBlock
            message={(dashboard.error as Error).message}
            onRetry={() => void dashboard.refetch()}
          />
        )}

        {dashboard.data && (
          <>
            {/* Nudges first: these are the things that need doing today. */}
            <div className="space-y-3">
              {/*
                The school being closed is stated instead of the nudge, not alongside it:
                "attendance not marked" on a day nobody could mark is the bug this replaces.
              */}
              {dashboard.data.today.holiday && (
                <ActionBanner
                  tone="slate"
                  icon={<CalendarDays className="h-4 w-4" aria-hidden />}
                  message={
                    <>
                      Today is <strong>{dashboard.data.today.holiday.label}</strong> — a school
                      holiday. No attendance to mark.
                    </>
                  }
                  action={
                    isAdmin && isDeclared ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={clearHoliday.isPending}
                        onClick={() => clearHoliday.mutate(dashboard.data.today.dateKey)}
                      >
                        {clearHoliday.isPending && <Spinner />}
                        Undo
                      </Button>
                    ) : undefined
                  }
                />
              )}

              {!dashboard.data.today.holiday && dashboard.data.today.unmarkedClasses.length > 0 && (
                <ActionBanner
                  tone="amber"
                  icon={<CalendarCheck className="h-4 w-4" aria-hidden />}
                  message={
                    <>
                      Attendance not marked today for{' '}
                      <strong>
                        {dashboard.data.today.unmarkedClasses
                          .filter((c) => isAdmin || me.assignedClasses.includes(c))
                          .map((c) => classLabel(c))
                          .join(', ') || 'other classes'}
                      </strong>
                      .
                    </>
                  }
                  action={
                    <div className="flex items-center gap-2">
                      <Link to="/attendance">
                        <Button size="sm">Mark now</Button>
                      </Link>
                      {/*
                        Admin-only: this closes every class at once, which is not a call a
                        teacher makes on behalf of the school. The API enforces the same.
                      */}
                      {isAdmin && (
                        <Button size="sm" variant="secondary" onClick={() => setDeclaring(true)}>
                          Mark holiday
                        </Button>
                      )}
                    </div>
                  }
                />
              )}

              {isAdmin && dashboard.data.outstanding.aging['60+'] > 0 && (
                <ActionBanner
                  tone="red"
                  icon={<AlertTriangle className="h-4 w-4" aria-hidden />}
                  message={
                    <>
                      <strong>{formatINR(dashboard.data.outstanding.aging['60+'])}</strong> has been
                      outstanding for over 60 days.
                    </>
                  }
                  action={
                    <Link to="/notifications">
                      <Button size="sm" variant="secondary">
                        Send reminders
                      </Button>
                    </Link>
                  }
                />
              )}

              {isAdmin && dashboard.data.studentsWithoutWhatsapp > 0 && (
                <ActionBanner
                  tone="amber"
                  icon={<MessageSquare className="h-4 w-4" aria-hidden />}
                  message={
                    <>
                      <strong>{dashboard.data.studentsWithoutWhatsapp}</strong> student
                      {dashboard.data.studentsWithoutWhatsapp === 1 ? '' : 's'} have no reachable
                      WhatsApp number, so fee reminders cannot go out for them.
                    </>
                  }
                  action={
                    <Link to="/students">
                      <Button size="sm" variant="secondary">
                        Review
                      </Button>
                    </Link>
                  }
                />
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                icon={<Users className="h-5 w-5 text-brand-600" aria-hidden />}
                label="Active students"
                value={String(dashboard.data.activeStudents)}
              />
              <Stat
                icon={<CalendarCheck className="h-5 w-5 text-emerald-600" aria-hidden />}
                label={`Present today (${formatDate(dashboard.data.today.dateKey)})`}
                value={
                  // "Not marked" on a closed school reads as an outstanding task rather
                  // than as the school being shut, so a holiday says so plainly.
                  dashboard.data.today.holiday
                    ? 'Holiday'
                    : dashboard.data.today.marked === 0
                      ? 'Not marked'
                      : `${dashboard.data.today.percentage}%`
                }
                hint={
                  dashboard.data.today.holiday
                    ? dashboard.data.today.holiday.label
                    : dashboard.data.today.marked > 0
                      ? `${dashboard.data.today.present} of ${dashboard.data.today.marked} marked`
                      : undefined
                }
              />
              {isAdmin && (
                <>
                  <Stat
                    icon={<TrendingUp className="h-5 w-5 text-emerald-600" aria-hidden />}
                    label={`Collected in ${dashboard.data.month.period}`}
                    value={formatINR(dashboard.data.month.collectedRupees)}
                    hint={`of ${formatINR(dashboard.data.month.invoicedRupees)} invoiced`}
                  />
                  <Stat
                    icon={<IndianRupee className="h-5 w-5 text-amber-600" aria-hidden />}
                    label="Outstanding"
                    value={formatINR(dashboard.data.outstanding.balanceRupees)}
                    hint={`${dashboard.data.outstanding.students} students`}
                  />
                  {/* Other income and profit/loss: switched off, not deleted. Uncomment the
                      block below and the `Gift` / `Wallet` imports at the top of this file to
                      put both tiles back — the API still sends `finance` (admin only), so
                      nothing else has to change.

                      Off because a grant or a donation arrives a few times a year, so on a
                      screen read every day both tiles would sit at zero or unchanged almost
                      always, and a tile nobody needs to look at trains the eye to skip the
                      row it lives in. The figures are on Reports → Expenses, which is where a
                      month actually gets reviewed.

                  {dashboard.data.finance && (
                    <>
                      <Stat
                        icon={<Gift className="h-5 w-5 text-emerald-600" aria-hidden />}
                        label="Other income"
                        value={formatINR(dashboard.data.finance.gainRupees)}
                        hint={`${formatINR(dashboard.data.finance.moneyInRupees)} in altogether`}
                      />
                      <Stat
                        icon={<Wallet className="h-5 w-5 text-slate-600" aria-hidden />}
                        label={dashboard.data.finance.netRupees >= 0 ? 'Profit' : 'Loss'}
                        value={formatINR(Math.abs(dashboard.data.finance.netRupees))}
                        hint={`${formatINR(dashboard.data.finance.expenseRupees)} spent this month`}
                      />
                    </>
                  )}
                  */}
                </>
              )}
            </div>

            {isAdmin && dashboard.data.outstanding.balanceRupees > 0 && (
              <Card>
                <CardHeader
                  title="Dues by age"
                  description="Measured from the oldest unpaid invoice's due date."
                  action={
                    <Link to="/reports">
                      <Button variant="secondary" size="sm">
                        Full report
                      </Button>
                    </Link>
                  }
                />
                <CardBody>
                  <div className="grid gap-4 sm:grid-cols-4">
                    {(['not-due', '0-30', '31-60', '60+'] as const).map((bucket) => (
                      <div key={bucket}>
                        <p className="text-xs uppercase tracking-wide text-slate-500">
                          {bucket === 'not-due' ? 'Not yet due' : `${bucket} days`}
                        </p>
                        <p className="text-lg font-semibold tabular-nums">
                          {formatINR(dashboard.data.outstanding.aging[bucket])}
                        </p>
                      </div>
                    ))}
                  </div>
                </CardBody>
              </Card>
            )}

            <Card>
              <CardHeader title="Students by class" description="Active students on the roll." />
              <CardBody>
                {dashboard.data.activeStudents === 0 ? (
                  <p className="py-6 text-center text-sm text-slate-500">
                    No students yet.{' '}
                    {isAdmin && (
                      <Link to="/students/new" className="text-brand-700 underline">
                        Onboard the first one
                      </Link>
                    )}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {CLASS_CODES.map((code) => {
                      const count =
                        dashboard.data.studentsByClass.find((row) => row.classCode === code)
                          ?.count ?? 0;
                      const share = (count / largestClassSize) * 100;
                      return (
                        <li key={code} className="flex items-center gap-3 text-sm">
                          <Link
                            to={`/students?classCode=${code}`}
                            className="w-24 shrink-0 text-slate-600 hover:text-brand-700"
                          >
                            {classLabel(code)}
                          </Link>
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full bg-brand-500"
                              style={{ width: `${share}%` }}
                            />
                          </div>
                          <span className="w-8 text-right tabular-nums text-slate-900">
                            {count}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardBody>
            </Card>
          </>
        )}
      </div>

      {declaring && today && (
        <MarkHolidayModal
          dateKey={today.dateKey}
          alreadyMarked={today.marked}
          onClose={() => setDeclaring(false)}
        />
      )}
    </>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardBody>
        <div className="flex items-start gap-3">
          {icon}
          <div className="min-w-0">
            <p className="truncate text-xs uppercase tracking-wide text-slate-500">{label}</p>
            <p className="text-2xl font-semibold text-slate-900">{value}</p>
            {hint && <p className="text-xs text-slate-500">{hint}</p>}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function ActionBanner({
  tone,
  icon,
  message,
  action,
}: {
  tone: 'amber' | 'red' | 'slate';
  icon: ReactNode;
  message: ReactNode;
  action?: ReactNode;
}) {
  const styles = {
    red: 'bg-red-50 text-red-900',
    amber: 'bg-amber-50 text-amber-900',
    // Neutral on purpose: a closed school is information, not a task.
    slate: 'bg-slate-100 text-slate-700',
  }[tone];
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-md px-4 py-3 text-sm ${styles}`}>
      {icon}
      <span className="min-w-0 flex-1">{message}</span>
      {action}
    </div>
  );
}
