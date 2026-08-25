import { CLASS_CODES, classLabel, formatINR, toDateKey } from '@rntps/shared';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { downloadCsv, reportKeys, reportsApi } from '@/api/reports';
import { PageHeader } from '@/components/layout/AppShell';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorBlock, LoadingBlock } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Field';
import { cn, formatDate } from '@/lib/utils';

const TABS = ['Dues', 'Collection', 'Attendance'] as const;
type Tab = (typeof TABS)[number];

const BUCKET_TONE: Record<string, BadgeTone> = {
  'not-due': 'slate',
  '0-30': 'amber',
  '31-60': 'red',
  '60+': 'red',
};

export function ReportsPage() {
  const [tab, setTab] = useState<Tab>('Dues');

  return (
    <>
      <PageHeader title="Reports" description="Export any of these as CSV for the office records." />

      <div className="border-b border-slate-200 bg-white px-6">
        <nav className="flex gap-1" role="tablist">
          {TABS.map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={tab === name}
              onClick={() => setTab(name)}
              className={cn(
                '-mb-px border-b-2 px-4 py-3 text-sm font-medium',
                tab === name ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800',
              )}
            >
              {name}
            </button>
          ))}
        </nav>
      </div>

      <div className="space-y-4 p-6">
        {tab === 'Dues' && <DuesReport />}
        {tab === 'Collection' && <CollectionReport />}
        {tab === 'Attendance' && <AttendanceReport />}
      </div>
    </>
  );
}

function DuesReport() {
  const [classCode, setClassCode] = useState('');
  const params = { classCode: classCode || undefined };
  const dues = useQuery({ queryKey: reportKeys.dues(params), queryFn: () => reportsApi.dues(params) });

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-3 p-4">
          <Select aria-label="Class" className="w-40" value={classCode} onChange={(e) => setClassCode(e.target.value)}>
            <option value="">All classes</option>
            {CLASS_CODES.map((code) => (
              <option key={code} value={code}>
                {classLabel(code)}
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            className="ml-auto"
            onClick={() => void downloadCsv('/reports/dues', params, `dues-${toDateKey()}.csv`)}
          >
            <Download className="h-4 w-4" aria-hidden />
            Export CSV
          </Button>
        </div>
      </Card>

      {dues.isPending && <LoadingBlock />}
      {dues.error && <ErrorBlock message={(dues.error as Error).message} />}

      {dues.data && (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <Card>
              <CardBody>
                <p className="text-xs uppercase tracking-wide text-slate-500">Total outstanding</p>
                <p className="text-2xl font-semibold">{formatINR(dues.data.totals.balanceRupees)}</p>
                <p className="text-xs text-slate-500">{dues.data.totals.students} students</p>
              </CardBody>
            </Card>
            {(['0-30', '31-60', '60+'] as const).map((bucket) => (
              <Card key={bucket}>
                <CardBody>
                  <p className="text-xs uppercase tracking-wide text-slate-500">{bucket} days overdue</p>
                  <p className="text-2xl font-semibold">{formatINR(dues.data.totals.aging[bucket])}</p>
                </CardBody>
              </Card>
            ))}
          </div>

          <Card>
            {dues.data.rows.length === 0 ? (
              <EmptyState title="Nothing outstanding" description="Every invoice is settled." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-5 py-3 font-medium">Student</th>
                      <th scope="col" className="px-5 py-3 font-medium">Class</th>
                      <th scope="col" className="px-5 py-3 font-medium">Invoices</th>
                      <th scope="col" className="px-5 py-3 font-medium">Oldest due</th>
                      <th scope="col" className="px-5 py-3 text-right font-medium">Balance</th>
                      <th scope="col" className="px-5 py-3 font-medium">Age</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {dues.data.rows.map((row) => (
                      <tr key={row.studentId} className="hover:bg-slate-50">
                        <td className="px-5 py-3">
                          <Link to={`/students/${row.studentId}`} className="font-medium text-slate-900 hover:text-brand-700 hover:underline">
                            {row.studentName}
                          </Link>
                        </td>
                        <td className="px-5 py-3 text-slate-600">{classLabel(row.classCode)}</td>
                        <td className="px-5 py-3 text-slate-600">{row.invoiceCount}</td>
                        <td className="px-5 py-3 text-slate-600">{formatDate(row.oldestDueDate)}</td>
                        <td className="px-5 py-3 text-right font-medium tabular-nums">{formatINR(row.balanceRupees)}</td>
                        <td className="px-5 py-3">
                          <Badge tone={BUCKET_TONE[row.bucket] ?? 'slate'}>{row.bucket}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function CollectionReport() {
  const today = toDateKey();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);

  const collection = useQuery({
    queryKey: reportKeys.collection(from, to),
    queryFn: () => reportsApi.collection(from, to),
    enabled: Boolean(from && to),
  });

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-3 p-4">
          <label className="text-sm">
            <span className="mb-1.5 block font-medium text-slate-700">From</span>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="mb-1.5 block font-medium text-slate-700">To</span>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <Button
            variant="secondary"
            className="ml-auto"
            onClick={() => void downloadCsv('/reports/collection', { from, to }, `collection-${from}-to-${to}.csv`)}
          >
            <Download className="h-4 w-4" aria-hidden />
            Export CSV
          </Button>
        </div>
      </Card>

      {collection.isPending && <LoadingBlock />}
      {collection.error && <ErrorBlock message={(collection.error as Error).message} />}

      {collection.data && (
        <>
          <div className="flex flex-wrap gap-4">
            <Card className="flex-1">
              <CardBody>
                <p className="text-xs uppercase tracking-wide text-slate-500">Collected</p>
                <p className="text-2xl font-semibold">{formatINR(collection.data.totals.amountRupees)}</p>
                <p className="text-xs text-slate-500">{collection.data.totals.count} receipts</p>
              </CardBody>
            </Card>
            {Object.entries(collection.data.totals.byMode).map(([mode, amount]) => (
              <Card key={mode} className="flex-1">
                <CardBody>
                  <p className="text-xs uppercase tracking-wide text-slate-500">{mode}</p>
                  <p className="text-2xl font-semibold">{formatINR(amount)}</p>
                </CardBody>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader title="Receipts" description="Reversed payments are excluded." />
            {collection.data.rows.length === 0 ? (
              <EmptyState title="No payments in this range" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-5 py-3 font-medium">Receipt</th>
                      <th scope="col" className="px-5 py-3 font-medium">Date</th>
                      <th scope="col" className="px-5 py-3 font-medium">Student</th>
                      <th scope="col" className="px-5 py-3 font-medium">Month</th>
                      <th scope="col" className="px-5 py-3 font-medium">Mode</th>
                      <th scope="col" className="px-5 py-3 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {collection.data.rows.map((row) => (
                      <tr key={row.receiptNo} className="hover:bg-slate-50">
                        <td className="px-5 py-3 font-mono text-xs">{row.receiptNo}</td>
                        <td className="px-5 py-3 text-slate-600">{formatDate(row.paidAt)}</td>
                        <td className="px-5 py-3">{row.studentName}</td>
                        <td className="px-5 py-3 text-slate-600">{row.period}</td>
                        <td className="px-5 py-3 text-slate-600">{row.mode}</td>
                        <td className="px-5 py-3 text-right font-medium tabular-nums">{formatINR(row.amountRupees)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function AttendanceReport() {
  const [month, setMonth] = useState(toDateKey().slice(0, 7));
  const [threshold, setThreshold] = useState(75);
  const [classCode, setClassCode] = useState('');

  const defaulters = useQuery({
    queryKey: reportKeys.defaulters(month, threshold, classCode || undefined),
    queryFn: () => reportsApi.defaulters(month, threshold, classCode || undefined),
  });

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-3 p-4">
          <label className="text-sm">
            <span className="mb-1.5 block font-medium text-slate-700">Month</span>
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="mb-1.5 block font-medium text-slate-700">Below (%)</span>
            <Input
              type="number"
              min={0}
              max={100}
              className="w-24"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
          </label>
          <Select aria-label="Class" className="w-40" value={classCode} onChange={(e) => setClassCode(e.target.value)}>
            <option value="">All classes</option>
            {CLASS_CODES.map((code) => (
              <option key={code} value={code}>
                {classLabel(code)}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {defaulters.isPending && <LoadingBlock />}
      {defaulters.error && <ErrorBlock message={(defaulters.error as Error).message} />}

      {defaulters.data && (
        <Card>
          <CardHeader
            title={`Below ${threshold}% in ${month}`}
            description="Students with nothing marked are excluded, rather than shown as 0%."
          />
          {defaulters.data.items.length === 0 ? (
            <EmptyState title="Nobody below the threshold" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-5 py-3 font-medium">Student</th>
                    <th scope="col" className="px-5 py-3 font-medium">Class</th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">Present</th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">Absent</th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">Working days</th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {defaulters.data.items.map((item) => (
                    <tr key={item.studentId} className="hover:bg-slate-50">
                      <td className="px-5 py-3">
                        <Link to={`/students/${item.studentId}`} className="font-medium text-slate-900 hover:text-brand-700 hover:underline">
                          {item.fullName}
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-slate-600">{classLabel(item.classCode)}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{item.totals.present}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{item.totals.absent}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{item.totals.workingDays}</td>
                      <td className="px-5 py-3 text-right">
                        <Badge tone="red">{item.totals.percentage}%</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
