import { CLASS_CODES, INVOICE_STATUSES, classLabel, formatINR, toDateKey } from '@rntps/shared';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { feeKeys, feesApi, type InvoiceListParams } from '@/api/fees';
import { PageHeader } from '@/components/layout/AppShell';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorBlock, LoadingBlock } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Field';
import { useDebounced } from '@/hooks/useDebounced';
import { formatDate } from '@/lib/utils';

const STATUS_TONE: Record<string, BadgeTone> = {
  DUE: 'amber',
  PARTIAL: 'blue',
  PAID: 'green',
  VOID: 'slate',
};

export function InvoiceStatusBadge({ status, isOverdue }: { status: string; isOverdue?: boolean }) {
  if (isOverdue && status !== 'PAID' && status !== 'VOID') {
    return <Badge tone="red">Overdue</Badge>;
  }
  return <Badge tone={STATUS_TONE[status] ?? 'slate'}>{status.toLowerCase()}</Badge>;
}

export function InvoicesPage() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [classCode, setClassCode] = useState('');
  // Defaults to this month; a `?period=` link still wins. Clearing the field shows every
  // month, which is how you find an unpaid invoice from earlier in the year.
  const [period, setPeriod] = useState(searchParams.get('period') ?? toDateKey().slice(0, 7));
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [page, setPage] = useState(1);

  const debounced = useDebounced(search);

  const params: InvoiceListParams = {
    page,
    limit: 25,
    q: debounced || undefined,
    status: status || undefined,
    classCode: classCode || undefined,
    period: period || undefined,
    overdueOnly: overdueOnly ? 'true' : undefined,
  };

  const invoices = useQuery({
    queryKey: feeKeys.invoices(params),
    queryFn: () => feesApi.invoices(params),
  });

  function onFilterChange<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Record payments and track what is outstanding."
        action={
          <Link to="/fees/run">
            <Button>Generate invoices</Button>
          </Link>
        }
      />

      <div className="space-y-4 p-6">
        <Card>
          <div className="flex flex-wrap items-end gap-3 p-4">
            <div className="relative min-w-56 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden
              />
              <Input
                aria-label="Search invoices"
                placeholder="Search by student name or ID"
                className="pl-9"
                value={search}
                onChange={(e) => onFilterChange(setSearch)(e.target.value)}
              />
            </div>
            <Input
              aria-label="Month"
              type="month"
              className="w-40"
              value={period}
              onChange={(e) => onFilterChange(setPeriod)(e.target.value)}
            />
            <Select
              aria-label="Status"
              className="w-36"
              value={status}
              onChange={(e) => onFilterChange(setStatus)(e.target.value)}
            >
              <option value="">All statuses</option>
              {INVOICE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.toLowerCase()}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Class"
              className="w-36"
              value={classCode}
              onChange={(e) => onFilterChange(setClassCode)(e.target.value)}
            >
              <option value="">All classes</option>
              {CLASS_CODES.map((code) => (
                <option key={code} value={code}>
                  {classLabel(code)}
                </option>
              ))}
            </Select>
            <label className="flex h-10 items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={overdueOnly}
                onChange={(e) => onFilterChange(setOverdueOnly)(e.target.checked)}
              />
              Overdue only
            </label>
          </div>
        </Card>

        <Card>
          {invoices.isPending && <LoadingBlock />}
          {invoices.error && (
            <div className="p-4">
              <ErrorBlock message={(invoices.error as Error).message} />
            </div>
          )}

          {invoices.data?.items.length === 0 && (
            <EmptyState
              title="No invoices match those filters"
              // The month filter is on by default, so say what is hiding the rest rather
              // than leaving someone to wonder where last month's unpaid invoices went.
              description={
                period
                  ? `Nothing for ${period}. Clear the month to see every invoice.`
                  : 'Generate invoices for a month to get started.'
              }
            />
          )}

          {invoices.data && invoices.data.items.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-5 py-3 font-medium">
                        Student
                      </th>
                      <th scope="col" className="px-5 py-3 font-medium">
                        Class
                      </th>
                      <th scope="col" className="px-5 py-3 font-medium">
                        Month
                      </th>
                      <th scope="col" className="px-5 py-3 font-medium">
                        Due
                      </th>
                      <th scope="col" className="px-5 py-3 text-right font-medium">
                        Total
                      </th>
                      <th scope="col" className="px-5 py-3 text-right font-medium">
                        Paid
                      </th>
                      <th scope="col" className="px-5 py-3 text-right font-medium">
                        Balance
                      </th>
                      <th scope="col" className="px-5 py-3 font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {invoices.data.items.map((invoice) => (
                      <tr key={invoice.id} className="hover:bg-slate-50">
                        <td className="px-5 py-3">
                          <Link
                            to={`/fees/invoices/${encodeURIComponent(invoice.id)}`}
                            className="font-medium text-slate-900 hover:text-brand-700 hover:underline"
                          >
                            {invoice.studentName}
                          </Link>
                          <span className="block font-mono text-xs text-slate-400">
                            {invoice.studentId}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-slate-600">
                          {classLabel(invoice.classCode)}
                        </td>
                        <td className="px-5 py-3 text-slate-600">{invoice.period}</td>
                        <td className="px-5 py-3 text-slate-600">{formatDate(invoice.dueDate)}</td>
                        <td className="px-5 py-3 text-right tabular-nums">
                          {formatINR(invoice.totalRupees)}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums text-slate-600">
                          {formatINR(invoice.paidRupees)}
                        </td>
                        <td className="px-5 py-3 text-right font-medium tabular-nums">
                          {invoice.balanceRupees > 0 ? formatINR(invoice.balanceRupees) : '—'}
                        </td>
                        <td className="px-5 py-3">
                          <InvoiceStatusBadge
                            status={invoice.status}
                            isOverdue={invoice.isOverdue}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm text-slate-600">
                <span>
                  {(invoices.data.page - 1) * invoices.data.limit + 1}–
                  {Math.min(invoices.data.page * invoices.data.limit, invoices.data.total)} of{' '}
                  {invoices.data.total}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={page >= invoices.data.totalPages}
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
