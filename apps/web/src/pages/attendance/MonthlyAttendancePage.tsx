import {
  ATTENDANCE_SHORT,
  CLASS_CODES,
  TEACHERS_SCOPE,
  attendanceScopeLabel,
  toDateKey,
  type AttendanceStatus,
} from '@rntps/shared';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { attendanceApi, attendanceKeys } from '@/api/attendance';
import { useCurrentUser } from '@/auth/AuthProvider';
import { PageHeader } from '@/components/layout/AppShell';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorBlock, LoadingBlock } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Field';
import { cn } from '@/lib/utils';

const CELL_TONE: Record<AttendanceStatus, string> = {
  PRESENT: 'text-emerald-700',
  ABSENT: 'bg-red-50 font-semibold text-red-700',
  HOLIDAY: 'text-slate-400',
};

export function MonthlyAttendancePage() {
  const me = useCurrentUser();
  const myClasses = me.role === 'ADMIN' ? [...CLASS_CODES] : me.assignedClasses;
  // The teacher register is read-only here, so everyone may see it. Appended last so it
  // never displaces a class as the default.
  const scopes = [...myClasses, TEACHERS_SCOPE];

  // Falling back to '1' would hand a teacher with no assigned classes a guaranteed 403.
  const [classCode, setClassCode] = useState(myClasses[0] ?? TEACHERS_SCOPE);
  const [month, setMonth] = useState(toDateKey().slice(0, 7));
  const isStaff = classCode === TEACHERS_SCOPE;

  const monthly = useQuery({
    queryKey: attendanceKeys.monthly(classCode, month),
    queryFn: () => attendanceApi.monthly(classCode, month),
    enabled: !isStaff && myClasses.includes(classCode as never),
  });

  const staffMonthly = useQuery({
    queryKey: attendanceKeys.staffMonthly(month),
    queryFn: () => attendanceApi.staffMonthly(month),
    enabled: isStaff,
  });

  /**
   * The grid on screen, whichever register it came from. Always the *enabled* query: a
   * disabled one stays `isPending` forever and would leave this permanently loading.
   *
   * `month`, `dateKeys` and `holidays` are field-compatible between the two responses by
   * design, so only the rows need adapting.
   */
  const active = isStaff ? staffMonthly : monthly;
  const view = active.data;
  const rows = useMemo(
    () =>
      isStaff
        ? (staffMonthly.data?.rows ?? []).map((row) => ({
            id: row.userId,
            name: row.name,
            rollNo: null as number | null,
            href: null as string | null,
            days: row.days,
            totals: row.totals,
          }))
        : (monthly.data?.rows ?? []).map((row) => ({
            id: row.studentId,
            name: row.fullName,
            rollNo: row.rollNo,
            href: `/students/${row.studentId}`,
            days: row.days,
            totals: row.totals,
          })),
    [isStaff, staffMonthly.data, monthly.data],
  );

  return (
    <>
      <PageHeader title="Monthly attendance" description="One row per person, one column per day." />

      <div className="space-y-4 p-6">
        <Card>
          <div className="flex flex-wrap items-end gap-3 p-4">
            <label className="text-sm">
              <span className="mb-1.5 block font-medium text-slate-700">Class</span>
              <Select className="w-40" value={classCode} onChange={(e) => setClassCode(e.target.value)}>
                {scopes.map((code) => (
                  <option key={code} value={code}>
                    {attendanceScopeLabel(code)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="text-sm">
              <span className="mb-1.5 block font-medium text-slate-700">Month</span>
              <Input type="month" className="w-44" value={month} onChange={(e) => setMonth(e.target.value)} />
            </label>
            <p className="ml-auto text-xs text-slate-500">
              P present · A absent · H holiday (Sundays included)
            </p>
          </div>
        </Card>

        {active.error && <ErrorBlock message={(active.error as Error).message} />}

        <Card>
          {active.isPending && <LoadingBlock />}

          {view && rows.length === 0 && (
            <EmptyState
              title={isStaff ? 'No active teachers' : `No active students in ${attendanceScopeLabel(classCode)}`}
            />
          )}

          {view && rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th scope="col" className="sticky left-0 z-10 bg-slate-50 px-4 py-2 text-left font-medium">
                      {isStaff ? 'Teacher' : 'Student'}
                    </th>
                    {view.dateKeys.map((dateKey) => {
                      const day = dateKey.slice(8);
                      const holiday = view.holidays[dateKey];
                      return (
                        <th
                          key={dateKey}
                          scope="col"
                          title={holiday ?? dateKey}
                          className={cn('w-8 px-0 py-2 text-center font-medium', holiday && 'bg-slate-200')}
                        >
                          {day}
                        </th>
                      );
                    })}
                    <th scope="col" className="px-3 py-2 text-right font-medium">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50">
                      <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-4 py-2">
                        {/* A teacher has no detail page to link to. */}
                        {row.href ? (
                          <Link
                            to={row.href}
                            className="font-medium text-slate-900 hover:text-brand-700 hover:underline"
                          >
                            {row.rollNo !== null && <span className="mr-1.5 text-slate-400">{row.rollNo}</span>}
                            {row.name}
                          </Link>
                        ) : (
                          <span className="font-medium text-slate-900">{row.name}</span>
                        )}
                      </td>
                      {view.dateKeys.map((dateKey) => {
                        const status = row.days[dateKey] as AttendanceStatus | undefined;
                        return (
                          <td
                            key={dateKey}
                            title={status ? `${dateKey}: ${status}` : `${dateKey}: not marked`}
                            className={cn(
                              'px-0 py-2 text-center text-xs',
                              status ? CELL_TONE[status] : 'text-slate-200',
                            )}
                          >
                            {status ? ATTENDANCE_SHORT[status] : '·'}
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-right">
                        {row.totals.workingDays === 0 ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <Badge tone={row.totals.percentage >= 75 ? 'green' : 'red'}>
                            {row.totals.percentage}%
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
