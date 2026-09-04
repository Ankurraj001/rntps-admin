import {
  ATTENDANCE_LABELS,
  ATTENDANCE_SHORT,
  ATTENDANCE_STATUSES,
  CLASS_CODES,
  TEACHERS_SCOPE,
  attendancePercentage,
  attendanceScopeLabel,
  toDateKey,
  type AttendanceStatus,
} from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Check, Info } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { attendanceApi, attendanceKeys } from '@/api/attendance';
import { useCurrentUser } from '@/auth/AuthProvider';
import { WhatsAppAbsenteesButton } from '@/components/attendance/WhatsAppAbsenteesButton';
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

  // Only an admin marks the teacher register, so only an admin is offered it. Appended
  // last so it never displaces a class as the default selection.
  const scopes =
    me.role === 'ADMIN' ? [...CLASS_CODES, TEACHERS_SCOPE] : me.assignedClasses;
  const [classCode, setClassCode] = useState(scopes[0] ?? '1');
  const isStaff = classCode === TEACHERS_SCOPE;
  const [dateKey, setDateKey] = useState(toDateKey());
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({});
  const [focused, setFocused] = useState(0);
  const [saved, setSaved] = useState(false);

  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const roster = useQuery({
    queryKey: attendanceKeys.roster(classCode, dateKey),
    queryFn: () => attendanceApi.roster(classCode, dateKey),
    enabled: !isStaff && scopes.includes(classCode as never),
  });

  const staffRoster = useQuery({
    queryKey: attendanceKeys.staffRoster(dateKey),
    queryFn: () => attendanceApi.staffRoster(dateKey),
    enabled: isStaff,
  });

  /**
   * The register on screen, whichever roster it came from.
   *
   * Read the enabled query's flags, never the disabled one's: a disabled query stays
   * `isPending` forever, so reading `roster.isPending` here would leave the teacher view
   * showing "Loading roster…" permanently.
   */
  const active = isStaff ? staffRoster : roster;
  const entries = useMemo(
    () =>
      isStaff
        ? (staffRoster.data?.entries ?? []).map((entry) => ({
            id: entry.userId,
            name: entry.name,
            rollNo: null as number | null,
            status: entry.status,
          }))
        : (roster.data?.entries ?? []).map((entry) => ({
            id: entry.studentId,
            name: entry.fullName,
            rollNo: entry.rollNo,
            status: entry.status,
          })),
    [isStaff, staffRoster.data, roster.data],
  );

  // Everyone defaults to Present: marking absences is the exception, so this is the
  // fastest starting point. Existing marks win.
  //
  // Deliberately does NOT clear `saved`: a successful save invalidates this query, so
  // the refetch would land here and wipe the confirmation the admin needs to see.
  useEffect(() => {
    if (!active.data) return;
    const next: Record<string, AttendanceStatus> = {};
    for (const entry of entries) {
      next[entry.id] = entry.status ?? 'PRESENT';
    }
    setMarks(next);
  }, [active.data, entries]);

  // Switching register or date is a new roster, so the previous confirmation no longer
  // applies. Marks go too: they are keyed by row, and the class and teacher registers do
  // not share a key space, so carrying them over could submit one against the other.
  useEffect(() => {
    setMarks({});
    setSaved(false);
    setFocused(0);
  }, [classCode, dateKey]);

  const save = useMutation({
    mutationFn: () =>
      isStaff
        ? attendanceApi.saveStaffRoster({
            dateKey,
            marks: Object.entries(marks).map(([userId, status]) => ({ userId, status })),
          })
        : attendanceApi.saveRoster({
            classCode,
            dateKey,
            marks: Object.entries(marks).map(([studentId, status]) => ({ studentId, status })),
          }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
  });

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
    setMarks(Object.fromEntries(entries.map((entry) => [entry.id, status])));
    setSaved(false);
  }

  /** Arrow keys move down the register; a letter sets the status and advances. */
  function handleKeyDown(event: React.KeyboardEvent, index: number) {
    const entry = entries[index];
    if (!entry) return;

    const status = SHORTCUT[event.key.toLowerCase()];
    if (status) {
      event.preventDefault();
      setStatus(entry.id, status);
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
  const isSundayRoster = active.data?.isSunday ?? false;
  const isReadOnly = (active.data?.isFuture ?? false) || isSundayRoster;

  return (
    <>
      <PageHeader
        title="Mark attendance"
        description={`Everyone starts as present — mark the exceptions. Keys: ${SHORTCUT_HINT}.`}
        action={
          <div className="flex items-center gap-2">
            <Button
              onClick={() => save.mutate()}
              disabled={save.isPending || entries.length === 0 || isReadOnly}
            >
              {save.isPending && <Spinner />}
              {saved ? <Check className="h-4 w-4" aria-hidden /> : null}
              {saved ? 'Saved' : 'Save attendance'}
            </Button>
            {/*
              `saved` as well as `submittedAt`: a save invalidates the roster query, so
              `submittedAt` only arrives once the refetch lands and the button would
              otherwise stay disabled for that gap.
            */}
            {/* The absentee report goes to the school office about children, so it is
                offered for a class only — not for the teacher register. */}
            {!isStaff && (
              <WhatsAppAbsenteesButton
                entries={roster.data?.entries ?? []}
                marks={marks}
                classCode={classCode}
                dateKey={dateKey}
                disabled={entries.length === 0 || isReadOnly || !(saved || roster.data?.submittedAt)}
              />
            )}
          </div>
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
                {scopes.map((code) => (
                  <option key={code} value={code}>
                    {attendanceScopeLabel(code)}
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
              <strong>Sunday</strong> — a holiday for the whole school. Nothing to mark, and it
              does not count toward anyone's attendance.
            </span>
          </div>
        )}

        {!isSundayRoster && active.data?.holiday && (
          <div className="flex items-center gap-2 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <CalendarDays className="h-4 w-4 shrink-0" aria-hidden />
            <span>
              <strong>{active.data.holiday.label}</strong> is a school holiday. You can still mark
              attendance if the school was open.
            </span>
          </div>
        )}

        {active.data?.submittedAt && (
          <div className="flex items-center gap-2 rounded-md bg-slate-100 px-4 py-3 text-sm text-slate-700">
            <Info className="h-4 w-4 shrink-0" aria-hidden />
            Already submitted {new Date(active.data.submittedAt).toLocaleString('en-IN')} — saving again
            replaces it.
          </div>
        )}

        {save.error && <ErrorBlock message={(save.error as Error).message} />}
        {active.error && <ErrorBlock message={(active.error as Error).message} />}

        <Card>
          {active.isPending && <LoadingBlock label="Loading roster…" />}

          {active.data && entries.length === 0 && (
            <EmptyState
              title={isStaff ? 'No active teachers' : `No active students in ${attendanceScopeLabel(classCode)}`}
              description={
                isStaff
                  ? 'Add teacher accounts under Users first.'
                  : 'Onboard students into this class first.'
              }
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
                    {!isStaff && <th scope="col" className="w-16 px-5 py-3 font-medium">Roll</th>}
                    <th scope="col" className="px-5 py-3 font-medium">Name</th>
                    <th scope="col" className="px-5 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {entries.map((entry, index) => (
                    <tr
                      key={entry.id}
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
                      {!isStaff && <td className="px-5 py-2 tabular-nums text-slate-500">{entry.rollNo ?? '—'}</td>}
                      <td className="px-5 py-2 font-medium text-slate-900">{entry.name}</td>
                      <td className="px-5 py-2">
                        <div className="flex gap-1">
                          {ATTENDANCE_STATUSES.map((status) => {
                            const chosen = marks[entry.id] === status;
                            return (
                              <button
                                key={status}
                                type="button"
                                disabled={isReadOnly}
                                aria-pressed={chosen}
                                aria-label={`${entry.name}: ${ATTENDANCE_LABELS[status]}`}
                                onClick={() => setStatus(entry.id, status)}
                                className={cn(
                                  'rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                                  chosen ? TONE[status] : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
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
