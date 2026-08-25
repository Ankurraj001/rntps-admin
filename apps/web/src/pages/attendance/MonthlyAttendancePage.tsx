import {
  ATTENDANCE_SHORT,
  CLASS_CODES,
  classLabel,
  toDateKey,
  type AttendanceStatus,
} from '@rntps/shared';
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

  const [classCode, setClassCode] = useState(myClasses[0] ?? '1');
  const [month, setMonth] = useState(toDateKey().slice(0, 7));

  const monthly = useQuery({
    queryKey: attendanceKeys.monthly(classCode, month),
    queryFn: () => attendanceApi.monthly(classCode, month),
    enabled: myClasses.includes(classCode as never),
  });

  return (
    <>
      <PageHeader title="Monthly attendance" description="One row per student, one column per day." />

      <div className="space-y-4 p-6">
        <Card>
          <div className="flex flex-wrap items-end gap-3 p-4">
            <label className="text-sm">
              <span className="mb-1.5 block font-medium text-slate-700">Class</span>
              <Select className="w-40" value={classCode} onChange={(e) => setClassCode(e.target.value)}>
                {myClasses.map((code) => (
                  <option key={code} value={code}>
                    {classLabel(code)}
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

        {monthly.error && <ErrorBlock message={(monthly.error as Error).message} />}

        <Card>
          {monthly.isPending && <LoadingBlock />}

          {monthly.data && monthly.data.rows.length === 0 && (
            <EmptyState title={`No active students in ${classLabel(classCode)}`} />
          )}

          {monthly.data && monthly.data.rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th scope="col" className="sticky left-0 z-10 bg-slate-50 px-4 py-2 text-left font-medium">
                      Student
                    </th>
                    {monthly.data.dateKeys.map((dateKey) => {
                      const day = dateKey.slice(8);
                      const holiday = monthly.data.holidays[dateKey];
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
                  {monthly.data.rows.map((row) => (
                    <tr key={row.studentId} className="hover:bg-slate-50">
                      <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-4 py-2">
                        <Link
                          to={`/students/${row.studentId}`}
                          className="font-medium text-slate-900 hover:text-brand-700 hover:underline"
                        >
                          {row.rollNo !== null && <span className="mr-1.5 text-slate-400">{row.rollNo}</span>}
                          {row.fullName}
                        </Link>
                      </td>
                      {monthly.data.dateKeys.map((dateKey) => {
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
