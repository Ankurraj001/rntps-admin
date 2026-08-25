import {
  ATTENDANCE_LABELS,
  ATTENDANCE_SHORT,
  ATTENDANCE_STATUSES,
  CLASS_CODES,
  attendancePercentage,
  classLabel,
  toDateKey,
  type AttendanceStatus,
} from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Check, Info } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { attendanceApi, attendanceKeys } from '@/api/attendance';
import { useCurrentUser } from '@/auth/AuthProvider';
import { PageHeader } from '@/components/layout/AppShell';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { EmptyState, ErrorBlock, LoadingBlock, Spinner } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Field';
import { cn } from '@/lib/utils';

/**
 * Keyboard shortcut for each status, so a class can be marked without the mouse.
 *
 * Derived from `ATTENDANCE_SHORT` rather than written out, so the bound keys, the letters
 * named in the hint above the roster and the statuses themselves cannot drift apart. They
 * had: the hint went on advertising keys for two statuses that no longer exist.
 */
const SHORTCUT: Record<string, AttendanceStatus> = Object.fromEntries(
  ATTENDANCE_STATUSES.map((status) => [ATTENDANCE_SHORT[status].toLowerCase(), status]),
);

const SHORTCUT_HINT = ATTENDANCE_STATUSES.map((status) => ATTENDANCE_SHORT[status]).join(', ');

const TONE: Record<AttendanceStatus, string> = {
  PRESENT: 'bg-emerald-600 text-white',
  ABSENT: 'bg-red-600 text-white',
  HOLIDAY: 'bg-slate-500 text-white',
};

export function MarkAttendancePage() {
  const me = useCurrentUser();
  const queryClient = useQueryClient();

  const myClasses = me.role === 'ADMIN' ? [...CLASS_CODES] : me.assignedClasses;
  const [classCode, setClassCode] = useState(myClasses[0] ?? '1');
  const [dateKey, setDateKey] = useState(toDateKey());
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({});
  const [focused, setFocused] = useState(0);
  const [saved, setSaved] = useState(false);

  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const roster = useQuery({
    queryKey: attendanceKeys.roster(classCode, dateKey),
    queryFn: () => attendanceApi.roster(classCode, dateKey),
    enabled: myClasses.includes(classCode as never),
  });

  // Everyone defaults to Present: marking absences is the exception, so this is the
  // fastest starting point. Existing marks win.
  //
  // Deliberately does NOT clear `saved`: a successful save invalidates this query, so
  // the refetch would land here and wipe the confirmation the admin needs to see.
  useEffect(() => {
    if (!roster.data) return;
    const next: Record<string, AttendanceStatus> = {};
    for (const entry of roster.data.entries) {
      next[entry.studentId] = entry.status ?? 'PRESENT';
    }
    setMarks(next);
  }, [roster.data]);

  // Switching class or date is a new roster, so the previous confirmation no longer applies.
  useEffect(() => {
    setSaved(false);
    setFocused(0);
  }, [classCode, dateKey]);

  const save = useMutation({
    mutationFn: () =>
      attendanceApi.saveRoster({
        classCode,
        dateKey,
        marks: Object.entries(marks).map(([studentId, status]) => ({ studentId, status })),
      }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
  });

  const entries = roster.data?.entries ?? [];

  const counts = useMemo(() => {
    const tally = { PRESENT: 0, ABSENT: 0, HOLIDAY: 0 } as Record<AttendanceStatus, number>;
    for (const status of Object.values(marks)) tally[status] += 1;
    const working = entries.length - tally.HOLIDAY;
    return { tally, working, percentage: attendancePercentage(tally.PRESENT, working) };
  }, [marks, entries.length]);

  function setStatus(studentId: string, status: AttendanceStatus) {
    setMarks((current) => ({ ...current, [studentId]: status }));
    setSaved(false);
  }

  function markAll(status: AttendanceStatus) {
    setMarks(Object.fromEntries(entries.map((entry) => [entry.studentId, status])));
    setSaved(false);
  }

  /** Arrow keys move down the register; a letter sets the status and advances. */
  function handleKeyDown(event: React.KeyboardEvent, index: number) {
    const entry = entries[index];
    if (!entry) return;

    const status = SHORTCUT[event.key.toLowerCase()];
    if (status) {
      event.preventDefault();
      setStatus(entry.studentId, status);
      const next = Math.min(index + 1, entries.length - 1);
      setFocused(next);
      rowRefs.current[next]?.focus();
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.max(0, Math.min(index + (event.key === 'ArrowDown' ? 1 : -1), entries.length - 1));
      setFocused(next);
      rowRefs.current[next]?.focus();
    }
  }

  // Sundays cannot be marked at all — the API refuses them, so the UI must not offer.
  const isSundayRoster = roster.data?.isSunday ?? false;
  const isReadOnly = (roster.data?.isFuture ?? false) || isSundayRoster;

  return (
    <>
      <PageHeader
        title="Mark attendance"
        description={`Everyone starts as present — mark the exceptions. Keys: ${SHORTCUT_HINT}.`}
        action={
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || entries.length === 0 || isReadOnly}
          >
            {save.isPending && <Spinner />}
            {saved ? <Check className="h-4 w-4" aria-hidden /> : null}
            {saved ? 'Saved' : 'Save attendance'}
          </Button>
        }
      />

      <div className="space-y-4 p-6">
        <Card>
          <CardBody className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1.5 block font-medium text-slate-700">Class</span>
              <Select
                className="w-40"
                value={classCode}
                onChange={(event) => setClassCode(event.target.value)}
              >
                {myClasses.map((code) => (
                  <option key={code} value={code}>
                    {classLabel(code)}
                  </option>
                ))}
              </Select>
            </label>

            <label className="text-sm">
              <span className="mb-1.5 block font-medium text-slate-700">Date</span>
              <Input
                type="date"
                className="w-44"
                max={toDateKey()}
                value={dateKey}
                onChange={(event) => setDateKey(event.target.value)}
              />
            </label>

            <div className="ml-auto flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => markAll('PRESENT')} disabled={isReadOnly}>
                All present
              </Button>
              <Button variant="secondary" size="sm" onClick={() => markAll('HOLIDAY')} disabled={isReadOnly}>
                Mark holiday
              </Button>
            </div>
          </CardBody>
        </Card>

        {isSundayRoster && (
          <div className="flex items-center gap-2 rounded-md bg-slate-100 px-4 py-3 text-sm text-slate-700">
            <CalendarDays className="h-4 w-4 shrink-0" aria-hidden />
            <span>
              <strong>Sunday</strong> — a holiday for every class. Nothing to mark, and it does not
              count toward anyone's attendance.
            </span>
          </div>
        )}

        {!isSundayRoster && roster.data?.holiday && (
          <div className="flex items-center gap-2 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <CalendarDays className="h-4 w-4 shrink-0" aria-hidden />
            <span>
              <strong>{roster.data.holiday.label}</strong> is a school holiday. You can still mark
              attendance if the school was open.
            </span>
          </div>
        )}

        {roster.data?.submittedAt && (
          <div className="flex items-center gap-2 rounded-md bg-slate-100 px-4 py-3 text-sm text-slate-700">
            <Info className="h-4 w-4 shrink-0" aria-hidden />
            Already submitted {new Date(roster.data.submittedAt).toLocaleString('en-IN')} — saving again
            replaces it.
          </div>
        )}

        {save.error && <ErrorBlock message={(save.error as Error).message} />}
        {roster.error && <ErrorBlock message={(roster.error as Error).message} />}

        <Card>
          {roster.isPending && <LoadingBlock label="Loading roster…" />}

          {roster.data && entries.length === 0 && (
            <EmptyState
              title={`No active students in ${classLabel(classCode)}`}
              description="Onboard students into this class first."
            />
          )}

          {entries.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3 text-sm">
                <span className="font-medium text-slate-700">{entries.length} students</span>
                {ATTENDANCE_STATUSES.map((status) => (
                  <span key={status} className="text-slate-600">
                    {ATTENDANCE_LABELS[status]}: <strong>{counts.tally[status]}</strong>
                  </span>
                ))}
                <Badge tone={counts.percentage >= 75 ? 'green' : 'amber'}>
                  {counts.percentage}% present
                </Badge>
              </div>

              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="w-16 px-5 py-3 font-medium">Roll</th>
                    <th scope="col" className="px-5 py-3 font-medium">Name</th>
                    <th scope="col" className="px-5 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {entries.map((entry, index) => (
                    <tr
                      key={entry.studentId}
                      ref={(node) => {
                        rowRefs.current[index] = node;
                      }}
                      tabIndex={0}
                      onFocus={() => setFocused(index)}
                      onKeyDown={(event) => handleKeyDown(event, index)}
                      className={cn(
                        'outline-none',
                        focused === index ? 'bg-brand-50' : 'hover:bg-slate-50',
                      )}
                    >
                      <td className="px-5 py-2 tabular-nums text-slate-500">{entry.rollNo ?? '—'}</td>
                      <td className="px-5 py-2 font-medium text-slate-900">{entry.fullName}</td>
                      <td className="px-5 py-2">
                        <div className="flex gap-1">
                          {ATTENDANCE_STATUSES.map((status) => {
                            const active = marks[entry.studentId] === status;
                            return (
                              <button
                                key={status}
                                type="button"
                                disabled={isReadOnly}
                                aria-pressed={active}
                                aria-label={`${entry.fullName}: ${ATTENDANCE_LABELS[status]}`}
                                onClick={() => setStatus(entry.studentId, status)}
                                className={cn(
                                  'rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                                  active ? TONE[status] : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                                )}
                              >
                                {ATTENDANCE_LABELS[status]}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
