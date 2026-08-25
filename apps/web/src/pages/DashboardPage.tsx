import { CLASS_CODES, classLabel, formatINR } from '@rntps/shared';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarCheck,
  IndianRupee,
  MessageSquare,
  Plus,
  TrendingUp,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { reportKeys, reportsApi } from '@/api/reports';
import { useCurrentUser } from '@/auth/AuthProvider';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ErrorBlock, LoadingBlock } from '@/components/ui/Feedback';
import { formatDate } from '@/lib/utils';

export function DashboardPage() {
  const me = useCurrentUser();
  const isAdmin = me.role === 'ADMIN';

  const dashboard = useQuery({ queryKey: reportKeys.dashboard, queryFn: reportsApi.dashboard });

  return (
    <>
      <PageHeader
        title={`Good day, ${me.name.split(' ')[0]}`}
        description={
          // From the dashboard payload rather than GET /settings, which is admin-only.
          dashboard.data ? `${dashboard.data.school.name} · ${dashboard.data.school.academicYear}` : undefined
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

      <div className="space-y-5 p-6">
        {dashboard.isPending && <LoadingBlock />}
        {dashboard.error && (
          <ErrorBlock message={(dashboard.error as Error).message} onRetry={() => void dashboard.refetch()} />
        )}

        {dashboard.data && (
          <>
            {/* Nudges first: these are the things that need doing today. */}
            <div className="space-y-3">
              {dashboard.data.today.unmarkedClasses.length > 0 && (
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
                  action={<Link to="/attendance"><Button size="sm">Mark now</Button></Link>}
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
                  action={<Link to="/notifications"><Button size="sm" variant="secondary">Send reminders</Button></Link>}
                />
              )}

              {isAdmin && dashboard.data.studentsWithoutWhatsapp > 0 && (
                <ActionBanner
                  tone="amber"
                  icon={<MessageSquare className="h-4 w-4" aria-hidden />}
                  message={
                    <>
                      <strong>{dashboard.data.studentsWithoutWhatsapp}</strong> student
                      {dashboard.data.studentsWithoutWhatsapp === 1 ? '' : 's'} have no reachable WhatsApp
                      number, so fee reminders cannot go out for them.
                    </>
                  }
                  action={<Link to="/students"><Button size="sm" variant="secondary">Review</Button></Link>}
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
                  dashboard.data.today.marked === 0 ? 'Not marked' : `${dashboard.data.today.percentage}%`
                }
                hint={
                  dashboard.data.today.marked > 0
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
                      <Button variant="secondary" size="sm">Full report</Button>
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
                        dashboard.data.studentsByClass.find((row) => row.classCode === code)?.count ?? 0;
                      const share = (count / dashboard.data.activeStudents) * 100;
                      return (
                        <li key={code} className="flex items-center gap-3 text-sm">
                          <Link
                            to={`/students?classCode=${code}`}
                            className="w-24 shrink-0 text-slate-600 hover:text-brand-700"
                          >
                            {classLabel(code)}
                          </Link>
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-brand-500" style={{ width: `${share}%` }} />
                          </div>
                          <span className="w-8 text-right tabular-nums text-slate-900">{count}</span>
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
  tone: 'amber' | 'red';
  icon: ReactNode;
  message: ReactNode;
  action?: ReactNode;
}) {
  const styles = tone === 'red' ? 'bg-red-50 text-red-900' : 'bg-amber-50 text-amber-900';
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-md px-4 py-3 text-sm ${styles}`}>
      {icon}
      <span className="min-w-0 flex-1">{message}</span>
      {action}
    </div>
  );
}
