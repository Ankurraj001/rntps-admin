import {
  CLASS_CODES,
  EXAM_CODES,
  EXAM_LABELS,
  classLabel,
  type AcademicRow,
  type ExamCode,
} from '@rntps/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, Pencil, Search } from 'lucide-react';
import { useState } from 'react';
import { academicKeys, academicsApi, type AcademicsListParams } from '@/api/academics';
import { useCurrentUser } from '@/auth/AuthProvider';
import { EditMarksModal } from '@/components/academics/EditMarksModal';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Field';
import { EmptyState, ErrorBlock, LoadingBlock } from '@/components/ui/Feedback';
import { useDebounced } from '@/hooks/useDebounced';

const PAGE_SIZE = 25;

type SortField = ExamCode | 'fullName' | 'rollNo';

/** A mark as the gradebook shows it: two decimals and a per cent sign, or a dash. */
function formatMark(mark: number | null): string {
  return mark === null ? '—' : `${mark.toFixed(2)}%`;
}

export function AcademicsPage() {
  const me = useCurrentUser();
  const isAdmin = me.role === 'ADMIN';
  // A teacher is offered only the classes they can actually open, so the page never
  // fires a request that is guaranteed to come back 403.
  const myClasses = isAdmin ? [...CLASS_CODES] : me.assignedClasses;

  const [search, setSearch] = useState('');
  const [classCode, setClassCode] = useState('');
  const [academicYear, setAcademicYear] = useState('');
  const [sort, setSort] = useState<SortField>('rollNo');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [editingStudentId, setEditingStudentId] = useState<string | null>(null);

  const debouncedSearch = useDebounced(search);

  const years = useQuery({ queryKey: academicKeys.years, queryFn: academicsApi.years });

  const params: AcademicsListParams = {
    page,
    limit: PAGE_SIZE,
    q: debouncedSearch || undefined,
    classCode: classCode || undefined,
    academicYear: academicYear || undefined,
    sort,
    order,
  };

  const { data, isPending, error, refetch } = useQuery({
    queryKey: academicKeys.list(params),
    queryFn: () => academicsApi.list(params),
  });

  // Any filter change invalidates the current page number.
  function updateFilter(setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
      setPage(1);
    };
  }

  /**
   * First click on a column sorts it; clicking the same one again reverses it. Marks
   * start descending because the question asked of a marks column is almost always who
   * scored highest, while the register columns start ascending.
   */
  function toggleSort(field: SortField) {
    if (sort === field) {
      setOrder((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(field);
      setOrder(field === 'fullName' || field === 'rollNo' ? 'asc' : 'desc');
    }
    setPage(1);
  }

  // Looked up from live list data rather than held in state, so the modal shows the
  // refreshed row after a save rather than the copy captured when it opened.
  const editing = data?.items.find((row) => row.studentId === editingStudentId) ?? null;
  const hasFilters = Boolean(debouncedSearch || classCode);

  return (
    <>
      <PageHeader
        title="Academics"
        description={
          isAdmin
            ? 'Exam marks for every class, as a percentage per paper.'
            : 'Exam marks for the classes you are assigned to.'
        }
      />

      <div className="space-y-4 p-6">
        <Card>
          <div className="flex flex-wrap items-end gap-3 p-4">
            <div className="relative min-w-64 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden
              />
              <Input
                aria-label="Search students"
                placeholder="Search by name or student ID"
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
              <option value="">{isAdmin ? 'All classes' : 'My classes'}</option>
              {myClasses.map((code) => (
                <option key={code} value={code}>
                  {classLabel(code)}
                </option>
              ))}
            </Select>

            <Select
              aria-label="Filter by session"
              className="w-48"
              value={academicYear}
              onChange={(event) => updateFilter(setAcademicYear)(event.target.value)}
            >
              <option value="">
                {years.data ? `${years.data.activeAcademicYear} (current)` : 'Current session'}
              </option>
              {(years.data?.years ?? [])
                .filter((year) => year !== years.data?.activeAcademicYear)
                .map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
            </Select>
          </div>
        </Card>

        <Card>
          {isPending && <LoadingBlock label="Loading marks…" />}
          {error && (
            <div className="p-4">
              <ErrorBlock message={(error as Error).message} onRetry={() => void refetch()} />
            </div>
          )}

          {data && data.items.length === 0 && (
            <EmptyState
              title={hasFilters ? 'No students match those filters' : 'No students in this session'}
              description={
                hasFilters
                  ? 'Try a different name or class.'
                  : 'Students on the roll for this session will appear here, ready for their marks.'
              }
            />
          )}

          {data && data.items.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <SortableHeader
                        label="Name"
                        field="fullName"
                        sort={sort}
                        order={order}
                        onSort={toggleSort}
                      />
                      <th scope="col" className="px-5 py-3 font-medium">
                        Class
                      </th>
                      <SortableHeader
                        label="Roll no"
                        field="rollNo"
                        sort={sort}
                        order={order}
                        onSort={toggleSort}
                      />
                      {EXAM_CODES.map((code) => (
                        <SortableHeader
                          key={code}
                          label={EXAM_LABELS[code]}
                          field={code}
                          sort={sort}
                          order={order}
                          onSort={toggleSort}
                          align="right"
                        />
                      ))}
                      <th scope="col" className="px-5 py-3 font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.items.map((row) => (
                      <MarksRow
                        key={row.studentId}
                        row={row}
                        canEdit={isAdmin || myClasses.includes(row.classCode as never)}
                        onEdit={() => setEditingStudentId(row.studentId)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm text-slate-600">
                <span>
                  {(data.page - 1) * data.limit + 1}–{Math.min(data.page * data.limit, data.total)} of{' '}
                  {data.total}
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

      {editing && <EditMarksModal row={editing} onClose={() => setEditingStudentId(null)} />}
    </>
  );
}

function MarksRow({
  row,
  canEdit,
  onEdit,
}: {
  row: AcademicRow;
  canEdit: boolean;
  onEdit: () => void;
}) {
  return (
    <tr className="hover:bg-slate-50">
      <td className="px-5 py-3 font-medium text-slate-900">{row.fullName}</td>
      <td className="px-5 py-3 text-slate-600">{classLabel(row.classCode)}</td>
      <td className="px-5 py-3 text-slate-600">{row.rollNo ?? '—'}</td>
      {EXAM_CODES.map((code) => (
        <td
          key={code}
          className={
            row.scores[code] === null
              ? 'px-5 py-3 text-right text-slate-400'
              : 'px-5 py-3 text-right tabular-nums text-slate-700'
          }
        >
          {formatMark(row.scores[code])}
        </td>
      ))}
      <td className="px-5 py-3 text-right">
        {canEdit && (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="h-4 w-4" aria-hidden />
            Edit
          </Button>
        )}
      </td>
    </tr>
  );
}

/**
 * A column header that sorts.
 *
 * aria-sort carries the state to a screen reader, which a coloured arrow alone does not.
 * Note that whichever column is sorted, a student with no mark for it stays at the bottom
 * — the API keeps unrecorded papers out of the ordering in both directions.
 */
function SortableHeader({
  label,
  field,
  sort,
  order,
  onSort,
  align = 'left',
}: {
  label: string;
  field: SortField;
  sort: SortField;
  order: 'asc' | 'desc';
  onSort: (field: SortField) => void;
  align?: 'left' | 'right';
}) {
  const active = sort === field;
  const Icon = !active ? ArrowUpDown : order === 'asc' ? ArrowUp : ArrowDown;

  return (
    <th
      scope="col"
      className={align === 'right' ? 'px-5 py-3 text-right font-medium' : 'px-5 py-3 font-medium'}
      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={
          align === 'right'
            ? 'ml-auto flex items-center gap-1 uppercase tracking-wide hover:text-slate-800'
            : 'flex items-center gap-1 uppercase tracking-wide hover:text-slate-800'
        }
      >
        {label}
        <Icon className={active ? 'h-3.5 w-3.5 text-brand-600' : 'h-3.5 w-3.5 text-slate-400'} aria-hidden />
      </button>
    </th>
  );
}
