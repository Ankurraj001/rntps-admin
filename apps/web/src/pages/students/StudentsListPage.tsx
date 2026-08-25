import { CLASS_CODES, STUDENT_STATUSES, classLabel } from '@rntps/shared';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { studentKeys, studentsApi, type StudentListParams } from '@/api/students';
import { PageHeader } from '@/components/layout/AppShell';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorBlock, LoadingBlock } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Field';
import { useAuth } from '@/auth/AuthProvider';
import { useDebounced } from '@/hooks/useDebounced';
import { displayPhone } from '@/lib/utils';

const PAGE_SIZE = 25;

export function StudentsListPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [search, setSearch] = useState('');
  const [classCode, setClassCode] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebounced(search);

  const params: StudentListParams = {
    page,
    limit: PAGE_SIZE,
    q: debouncedSearch || undefined,
    classCode: classCode || undefined,
    status: status || undefined,
  };

  const { data, isPending, error, refetch } = useQuery({
    queryKey: studentKeys.list(params),
    queryFn: () => studentsApi.list(params),
  });

  // Any filter change invalidates the current page number.
  function updateFilter(setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
      setPage(1);
    };
  }

  return (
    <>
      <PageHeader
        title="Students"
        description={isAdmin ? 'Onboard students and manage their records.' : 'Directory of students on the roll.'}
        action={
          isAdmin ? (
            <Link to="/students/new">
              <Button>
                <Plus className="h-4 w-4" aria-hidden />
                Onboard student
              </Button>
            </Link>
          ) : undefined
        }
      />

      <div className="space-y-4 p-6">
        <Card>
          <div className="flex flex-wrap items-end gap-3 p-4">
            <div className="relative min-w-64 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
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
          </div>
        </Card>

        <Card>
          {isPending && <LoadingBlock label="Loading students…" />}
          {error && <div className="p-4"><ErrorBlock message={(error as Error).message} onRetry={() => void refetch()} /></div>}

          {data && data.items.length === 0 && (
            <EmptyState
              title={debouncedSearch || classCode ? 'No students match those filters' : 'No students yet'}
              description={
                debouncedSearch || classCode
                  ? 'Try a different name, class or status.'
                  : 'Onboard the first student to get started.'
              }
              action={
                !debouncedSearch && !classCode && isAdmin ? (
                  <Link to="/students/new">
                    <Button>Onboard student</Button>
                  </Link>
                ) : undefined
              }
            />
          )}

          {data && data.items.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-5 py-3 font-medium">Student ID</th>
                      <th scope="col" className="px-5 py-3 font-medium">Name</th>
                      <th scope="col" className="px-5 py-3 font-medium">Class</th>
                      <th scope="col" className="px-5 py-3 font-medium">Roll</th>
                      <th scope="col" className="px-5 py-3 font-medium">Primary guardian</th>
                      <th scope="col" className="px-5 py-3 font-medium">Status</th>
                      {isAdmin && (
                        <th scope="col" className="px-5 py-3 font-medium">
                          <span className="sr-only">Actions</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.items.map((student) => {
                      const primary = student.guardians.find((g) => g.isPrimary) ?? student.guardians[0];
                      return (
                        <tr key={student.studentId} className="hover:bg-slate-50">
                          <td className="px-5 py-3 font-mono text-xs text-slate-500">
                            <Link to={`/students/${student.studentId}`} className="hover:text-brand-700 hover:underline">
                              {student.studentId}
                            </Link>
                          </td>
                          <td className="px-5 py-3">
                            <Link to={`/students/${student.studentId}`} className="font-medium text-slate-900 hover:text-brand-700 hover:underline">
                              {student.fullName}
                            </Link>
                          </td>
                          <td className="px-5 py-3 text-slate-600">{classLabel(student.classCode)}</td>
                          <td className="px-5 py-3 text-slate-600">{student.rollNo ?? '—'}</td>
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
                          <td className="px-5 py-3"><StatusBadge status={student.status} /></td>
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
                  {(data.page - 1) * data.limit + 1}–{Math.min(data.page * data.limit, data.total)} of {data.total}
                </span>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" disabled={data.page <= 1} onClick={() => setPage((p) => p - 1)}>
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
