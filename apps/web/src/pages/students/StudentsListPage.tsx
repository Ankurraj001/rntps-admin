import { CLASS_CODES, STUDENT_STATUSES, classLabel, formatAadhaar, toDateKey } from '@rntps/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Pencil, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  downloadStudentsCsv,
  studentKeys,
  studentsApi,
  type StudentListParams,
} from '@/api/students';
import { PageHeader } from '@/components/layout/AppShell';
import { Badge, StatusText } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorBlock, LoadingBlock, Spinner } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Field';
import { useAuth } from '@/auth/AuthProvider';
import { useDebounced } from '@/hooks/useDebounced';
import { displayPhone, formatDate } from '@/lib/utils';

const PAGE_SIZE = 25;

/** The columns this table offers to sort by; all four are server-side orderings. */
type SortField = 'fullName' | 'rollNo' | 'classCode' | 'transportOpted';

/**
 * The direction a column opens in on its first click.
 *
 * The text columns read naturally ascending — A-Z by name, 1-upwards by roll number,
 * Nursery-upwards by class. Transport is a flag rather than a scale, and a click on it is
 * asking who takes the bus, so it opens with those students on top; ascending on a boolean
 * would lead with a screenful of "No".
 */
const INITIAL_ORDER: Record<SortField, 'asc' | 'desc'> = {
  fullName: 'asc',
  rollNo: 'asc',
  classCode: 'asc',
  transportOpted: 'desc',
};

export function StudentsListPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [search, setSearch] = useState('');
  const [classCode, setClassCode] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [transportOnly, setTransportOnly] = useState(false);
  const [sort, setSort] = useState<SortField>('fullName');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebounced(search);

  const params: StudentListParams = {
    page,
    limit: PAGE_SIZE,
    q: debouncedSearch || undefined,
    classCode: classCode || undefined,
    status: status || undefined,
    transportOnly: transportOnly ? 'true' : undefined,
    sort,
    order,
  };

  const { data, isPending, error, refetch } = useQuery({
    queryKey: studentKeys.list(params),
    queryFn: () => studentsApi.list(params),
  });

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  // The download is a one-off side effect with no cached result, so it is plain state
  // rather than a query — and its failure has to surface somewhere, since a click that
  // silently produces no file looks like a broken button.
  async function exportCsv() {
    setExporting(true);
    setExportError('');
    try {
      await downloadStudentsCsv(params, `students-${toDateKey()}.csv`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  // Drives the empty state: with a filter on, "no students yet" would be a lie and the
  // "onboard the first student" prompt actively misleading.
  const hasFilters = Boolean(debouncedSearch || classCode || transportOnly);

  // Any filter change invalidates the current page number.
  function updateFilter<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  // First click on a column sorts it in the direction that column reads best (see
  // INITIAL_ORDER); clicking the same one again reverses it. The API orders classes by the
  // register's order, not the alphabetical order of the codes.
  function toggleSort(field: SortField) {
    if (sort === field) {
      setOrder((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(field);
      setOrder(INITIAL_ORDER[field]);
    }
    setPage(1);
  }

  return (
    <>
      <PageHeader
        title="Students"
        description={
          isAdmin
            ? 'Onboard students and manage their records.'
            : 'Directory of students on the roll.'
        }
        action={
          isAdmin ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => void exportCsv()}
                disabled={exporting || !data?.total}
              >
                {exporting ? <Spinner /> : <Download className="h-4 w-4" aria-hidden />}
                Export CSV
              </Button>
              <Link to="/students/new">
                <Button>
                  <Plus className="h-4 w-4" aria-hidden />
                  Onboard student
                </Button>
              </Link>
            </div>
          ) : undefined
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        <Card>
          <div className="flex flex-wrap items-end gap-3 p-4">
            <div className="relative min-w-64 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden
              />
              <Input
                aria-label="Search students"
                placeholder="Search by name, student ID or phone"
                className="pl-9"
                value={search}
                onChange={(event) => updateFilter(setSearch)(event.target.value)}
              />
            </div>

            <Select
              aria-label="Filter by class"
              className="w-44"
              value={classCode}
              onChange={(event) => updateFilter(setClassCode)(event.target.value)}
            >
              <option value="">All classes</option>
              {CLASS_CODES.map((code) => (
                <option key={code} value={code}>
                  {classLabel(code)}
                </option>
              ))}
            </Select>

            <Select
              aria-label="Filter by status"
              className="w-40"
              value={status}
              onChange={(event) => updateFilter(setStatus)(event.target.value)}
            >
              <option value="">All statuses</option>
              {STUDENT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.replace('_', ' ').toLowerCase()}
                </option>
              ))}
            </Select>

            <label className="flex h-10 items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={transportOnly}
                onChange={(event) => updateFilter(setTransportOnly)(event.target.checked)}
              />
              Transport
            </label>
          </div>
        </Card>

        {exportError && <ErrorBlock message={exportError} onRetry={() => void exportCsv()} />}

        <Card>
          {isPending && <LoadingBlock label="Loading students…" />}
          {error && (
            <div className="p-4">
              <ErrorBlock message={(error as Error).message} onRetry={() => void refetch()} />
            </div>
          )}

          {data && data.items.length === 0 && (
            <EmptyState
              title={hasFilters ? 'No students match those filters' : 'No students yet'}
              description={
                hasFilters
                  ? 'Try a different name, class or status.'
                  : 'Onboard the first student to get started.'
              }
              action={
                !hasFilters && isAdmin ? (
                  <Link to="/students/new">
                    <Button>Onboard student</Button>
                  </Link>
                ) : undefined
              }
            />
          )}

          {data && data.items.length > 0 && (
            <>
              <div className="relative overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-5 py-3 font-medium">
                        Student ID
                      </th>
                      <SortableHeader
                        label="Name"
                        field="fullName"
                        sort={sort}
                        order={order}
                        onSort={toggleSort}
                      />
                      <SortableHeader
                        label="Class"
                        field="classCode"
                        sort={sort}
                        order={order}
                        onSort={toggleSort}
                      />
                      <SortableHeader
                        label="Roll"
                        field="rollNo"
                        sort={sort}
                        order={order}
                        onSort={toggleSort}
                      />
                      <th scope="col" className="px-5 py-3 font-medium">
                        DOB
                      </th>
                      <th scope="col" className="px-5 py-3 font-medium">
                        Aadhaar
                      </th>
                      <th scope="col" className="px-5 py-3 font-medium">
                        Primary guardian
                      </th>
                      <SortableHeader
                        label="Transport"
                        field="transportOpted"
                        sort={sort}
                        order={order}
                        onSort={toggleSort}
                      />
                      <th scope="col" className="px-5 py-3 font-medium">
                        Status
                      </th>
                      {isAdmin && (
                        <th scope="col" className="px-5 py-3 font-medium">
                          <span className="sr-only">Actions</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.items.map((student) => {
                      const primary =
                        student.guardians.find((g) => g.isPrimary) ?? student.guardians[0];
                      return (
                        <tr key={student.studentId} className="hover:bg-slate-50">
                          <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-slate-500">
                            <Link
                              to={`/students/${student.studentId}`}
                              className="hover:text-brand-700 hover:underline"
                            >
                              {student.studentId}
                            </Link>
                          </td>
                          <td className="px-5 py-3">
                            <Link
                              to={`/students/${student.studentId}`}
                              className="font-medium text-slate-900 hover:text-brand-700 hover:underline"
                            >
                              {student.fullName}
                            </Link>
                          </td>
                          <td className="px-5 py-3 text-slate-600">
                            {classLabel(student.classCode)}
                          </td>
                          <td className="px-5 py-3 text-slate-600">{student.rollNo ?? '—'}</td>
                          <td className="whitespace-nowrap px-5 py-3 text-slate-600">
                            {formatDate(student.dob)}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-slate-600">
                            {student.aadhaar ? formatAadhaar(student.aadhaar) : '—'}
                          </td>
                          <td className="px-5 py-3 text-slate-600">
                            {primary ? (
                              <>
                                <span className="block">{primary.name}</span>
                                <span className="block font-mono text-xs text-slate-400">
                                  {displayPhone(primary.phone)}
                                </span>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-5 py-3">
                            <Badge tone={student.transportOpted ? 'green' : 'white'}>
                              {student.transportOpted ? 'Yes' : 'No'}
                            </Badge>
                          </td>
                          <td className="px-5 py-3">
                            <StatusText status={student.status} />
                          </td>
                          {isAdmin && (
                            <td className="px-5 py-3 text-right">
                              <Link to={`/students/${student.studentId}/edit`}>
                                <Button variant="ghost" size="sm">
                                  <Pencil className="h-4 w-4" aria-hidden />
                                  Edit
                                </Button>
                              </Link>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm text-slate-600">
                <span>
                  {(data.page - 1) * data.limit + 1}–{Math.min(data.page * data.limit, data.total)}{' '}
                  of {data.total}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={data.page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={data.page >= data.totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>
      </div>
    </>
  );
}

/**
 * A column header that sorts.
 *
 * aria-sort carries the state to a screen reader, which a coloured arrow alone does not.
 * Sorting is done by the API over the whole result set, not just the page on screen.
 */
function SortableHeader({
  label,
  field,
  sort,
  order,
  onSort,
}: {
  label: string;
  field: SortField;
  sort: SortField;
  order: 'asc' | 'desc';
  onSort: (field: SortField) => void;
}) {
  const active = sort === field;
  const Icon = !active ? ArrowUpDown : order === 'asc' ? ArrowUp : ArrowDown;

  return (
    <th
      scope="col"
      className="px-5 py-3 font-medium"
      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className="flex items-center gap-1 uppercase tracking-wide hover:text-slate-800"
      >
        {label}
        <Icon
          className={active ? 'h-3.5 w-3.5 text-brand-600' : 'h-3.5 w-3.5 text-slate-400'}
          aria-hidden
        />
      </button>
    </th>
  );
}
