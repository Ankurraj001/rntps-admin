import { CLASS_CODES, classLabel, formatINR, lastDayOfPeriod, toDateKey, toPeriod } from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Mail, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { expenseKeys, expensesApi, type ExpenseEmailResult } from '@/api/expenses';
import { downloadCsv, reportKeys, reportsApi } from '@/api/reports';
import { PageHeader } from '@/components/layout/AppShell';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorBlock, LoadingBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Field';
import { cn, formatDate } from '@/lib/utils';

const TABS = ['Expenses', 'Dues', 'Collection', 'Attendance'] as const;
type Tab = (typeof TABS)[number];

const BUCKET_TONE: Record<string, BadgeTone> = {
  'not-due': 'slate',
  '0-30': 'amber',
  '31-60': 'red',
  '60+': 'red',
};

export function ReportsPage() {
  const [tab, setTab] = useState<Tab>('Expenses');

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
        {tab === 'Expenses' && <ExpensesReport />}
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
            {/* Only when there is something to report — an amber card on every clean month
                would read as a problem where there is none. */}
            {collection.data.totals.reversedCount > 0 && (
              <Card className="flex-1 border-amber-300 bg-amber-50">
                <CardBody>
                  <p className="text-xs uppercase tracking-wide text-amber-800">Reversed</p>
                  <p className="text-2xl font-semibold text-amber-900">
                    {formatINR(collection.data.totals.reversedRupees)}
                  </p>
                  <p className="text-xs text-amber-800">
                    {collection.data.totals.reversedCount} receipt
                    {collection.data.totals.reversedCount === 1 ? '' : 's'} · not collected
                  </p>
                </CardBody>
              </Card>
            )}
          </div>

          <Card>
            <CardHeader
              title="Receipts"
              description="Newest first. Reversed receipts are listed for the record but not counted as collected."
            />
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
                      <tr key={row.receiptNo} className={cn('hover:bg-slate-50', row.isReversed && 'bg-amber-50/40')}>
                        <td className="px-5 py-3 font-mono text-xs">{row.receiptNo}</td>
                        <td className="px-5 py-3 text-slate-600">{formatDate(row.paidAt)}</td>
                        <td className="px-5 py-3">
                          {row.studentName}
                          {row.isReversed && (
                            <span className="ml-2 align-middle">
                              <Badge tone="amber">Reversed</Badge>
                            </span>
                          )}
                          {/* The reason is required when reversing, so it always says
                              something useful about why the money is not there. */}
                          {row.isReversed && row.reversalReason && (
                            <span className="block text-xs text-amber-800">
                              {row.reversalReason}
                              {row.reversedAt && ` · ${formatDate(row.reversedAt)}`}
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-slate-600">{row.period}</td>
                        <td className="px-5 py-3 text-slate-600">{row.mode}</td>
                        {/* Struck through as well as badged: the amount is the cell someone
                            reads when adding up a column by eye. */}
                        <td
                          className={cn(
                            'px-5 py-3 text-right font-medium tabular-nums',
                            row.isReversed && 'text-slate-400 line-through',
                          )}
                        >
                          {formatINR(row.amountRupees)}
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

/**
 * The day the add-form opens on: today when today falls inside the month being viewed,
 * otherwise the first of that month. Filing an expense under November while September is on
 * screen would make it vanish the moment it was added.
 */
function defaultExpenseDate(month: string): string {
  const today = toDateKey();
  return toPeriod(today) === month ? today : `${month}-01`;
}

function ExpensesReport() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(toDateKey().slice(0, 7));
  const [date, setDate] = useState(() => defaultExpenseDate(toDateKey().slice(0, 7)));
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');

  const expenses = useQuery({
    queryKey: expenseKeys.month(month),
    queryFn: () => expensesApi.month(month),
  });

  const typed = Number(amount || 0);
  // Refused rather than truncated, as everywhere else money is entered.
  const amountError =
    amount !== '' && !Number.isInteger(typed) ? 'Enter a whole number of rupees' : undefined;
  // Blocked rather than quietly filed elsewhere: the month comes from the date, so a date
  // outside the month on screen would add a row that immediately disappears from it.
  const dateError =
    date !== '' && toPeriod(date) !== month ? `Pick a day in ${month}` : undefined;
  const ready = date !== '' && !dateError && name.trim().length >= 2 && typed > 0 && !amountError;

  // Every add and remove refetches, so the cards above never disagree with the rows below.
  // Staging rows behind a Save button would leave the totals stale while the list showed
  // the new figures — the page contradicting itself on screen.
  const refresh = () => queryClient.invalidateQueries({ queryKey: expenseKeys.all });

  const add = useMutation({
    mutationFn: () =>
      expensesApi.add({ dateKey: date, name: name.trim(), amountRupees: Math.trunc(typed) }),
    onSuccess: async () => {
      // The date is deliberately kept: entering a run of receipts from the same day should
      // not mean re-picking it for every one.
      setName('');
      setAmount('');
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => expensesApi.remove(id),
    onSuccess: refresh,
  });

  const [emailResult, setEmailResult] = useState<ExpenseEmailResult | null>(null);
  const email = useMutation({
    mutationFn: () => expensesApi.email(month),
    onSuccess: setEmailResult,
  });

  // A result from one month must not sit under another: switching the picker clears it,
  // otherwise "Sent 2026-08" stays on screen while 2026-09 is being viewed.
  const onMonthChange = (value: string) => {
    setMonth(value);
    // Follows the picker, so the form is always ready to add to the month being looked at.
    if (value) setDate(defaultExpenseDate(value));
    setEmailResult(null);
    email.reset();
  };

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-3 p-4">
          <label className="text-sm">
            <span className="mb-1.5 block font-medium text-slate-700">Month</span>
            <Input type="month" value={month} onChange={(e) => onMonthChange(e.target.value)} />
          </label>

          <Button
            variant="secondary"
            className="ml-auto"
            disabled={email.isPending}
            onClick={() => email.mutate()}
          >
            {email.isPending ? <Spinner /> : <Mail className="h-4 w-4" aria-hidden />}
            Email this month
          </Button>
        </div>

        {/* The result is reported rather than assumed: sendMail never throws, so a send that
            never left the building would otherwise look identical to one that arrived. */}
        {emailResult && (
          <div className="border-t border-slate-100 px-4 py-2 text-sm">
            {emailResult.sent ? (
              <span className="text-emerald-700">
                Sent {emailResult.month} to the report address — {emailResult.rowCount}{' '}
                {emailResult.rowCount === 1 ? 'entry' : 'entries'},{' '}
                {formatINR(emailResult.totalRupees)}.
              </span>
            ) : (
              <span className="text-red-700">
                {emailResult.attempted
                  ? `Could not send: ${emailResult.error ?? 'the mail transport refused it'}`
                  : 'No recipient configured — set DAILY_REPORT_TO to switch this on.'}
              </span>
            )}
          </div>
        )}
        {email.error && (
          <div className="border-t border-slate-100 px-4 py-2">
            <ErrorBlock message={(email.error as Error).message} />
          </div>
        )}
      </Card>

      {expenses.isPending && <LoadingBlock />}
      {expenses.error && <ErrorBlock message={(expenses.error as Error).message} />}

      {expenses.data && (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <Card>
              <CardBody>
                <p className="text-xs uppercase tracking-wide text-slate-500">Collected in {month}</p>
                <p className="text-2xl font-semibold">{formatINR(expenses.data.collectedRupees)}</p>
                <p className="text-xs text-slate-500">
                  of {formatINR(expenses.data.invoicedRupees)} invoiced
                </p>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <p className="text-xs uppercase tracking-wide text-slate-500">Expenses in {month}</p>
                <p className="text-2xl font-semibold">{formatINR(expenses.data.totalRupees)}</p>
                <p className="text-xs text-slate-500">
                  {expenses.data.items.length}{' '}
                  {expenses.data.items.length === 1 ? 'entry' : 'entries'}
                </p>
              </CardBody>
            </Card>
            <ProfitCard
              label="This month"
              collectedRupees={expenses.data.collectedRupees}
              expenseRupees={expenses.data.totalRupees}
            />
            <Card>
              <CardBody>
                <p className="text-xs uppercase tracking-wide text-slate-500">Outstanding</p>
                <p className="text-2xl font-semibold">
                  {formatINR(expenses.data.outstanding.balanceRupees)}
                </p>
                {/* Deliberately says "today": this is the all-time balance the dashboard
                    shows, not what was outstanding at the end of the month being viewed. */}
                <p className="text-xs text-slate-500">
                  {expenses.data.outstanding.students} students · as of today
                </p>
              </CardBody>
            </Card>
          </div>

          {expenses.data.allTime && (
            <p className="text-xs text-slate-500">
              <span className="font-medium text-slate-600">All time total:</span> collected{' '}
              {formatINR(expenses.data.allTime.collectedRupees)} · spent{' '}
              {formatINR(expenses.data.allTime.expenseRupees)} ·{' '}
              {netLabel(
                expenses.data.allTime.collectedRupees - expenses.data.allTime.expenseRupees,
              )}
            </p>
          )}

          <Card>
            <CardHeader
              title={`Expenses in ${month}`}
              description="Salaries, fuel, bills — anything the school paid for this month."
            />
            {/* Tight rows on purpose: a month of salaries and bills is a list to scan, not a
                stack of cards. The remove control is a bare icon rather than a `Button`,
                whose `h-8` would set the row height on its own.

                Capped at `max-w-xl` so a short name and its amount are not left at opposite
                ends of a wide card — the amounts still right-align into one column, which is
                what makes a list of numbers comparable at a glance. */}
            <CardBody className="max-w-xl divide-y divide-slate-100 py-2">
              {expenses.data.items.length === 0 && (
                <p className="text-sm text-slate-500">Nothing recorded for this month yet.</p>
              )}
              {expenses.data.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 py-1.5 text-sm first:pt-0 last:pb-0"
                >
                  <span className="w-20 shrink-0 tabular-nums text-slate-500">
                    {formatDate(item.dateKey)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="w-24 text-right tabular-nums text-slate-600">
                      {formatINR(item.amountRupees)}
                    </span>
                    <button
                      type="button"
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 disabled:opacity-50"
                      aria-label={`Remove ${item.name}`}
                      title="Remove"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(item.id)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </span>
                </div>
              ))}

              {expenses.data.items.length > 0 && (
                <div className="flex items-center gap-3 py-1.5 text-sm first:pt-0 last:pb-0">
                  <span className="min-w-0 flex-1 font-semibold">
                    Total for {expenses.data.month}
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="w-24 text-right font-semibold tabular-nums">
                      {formatINR(expenses.data.totalRupees)}
                    </span>
                    {/* Matches the remove button's 24px, so the total sits in the same
                        column as the amounts above rather than one icon to the right. */}
                    <span className="w-6" aria-hidden />
                  </span>
                </div>
              )}
            </CardBody>

            <CardBody className="space-y-3 border-t border-slate-100">
              {add.error && <ErrorBlock message={(add.error as Error).message} />}
              {remove.error && <ErrorBlock message={(remove.error as Error).message} />}

              <div className="grid max-w-3xl gap-3 sm:grid-cols-12">
                <Field label="Date" required className="sm:col-span-3" error={dateError}>
                  {/* Bounded to the month on screen, so the picker cannot offer a day that
                      would file the expense into a month you are not looking at. */}
                  <Input
                    type="date"
                    value={date}
                    min={`${month}-01`}
                    max={lastDayOfPeriod(month)}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </Field>
                <Field label="What was it for" required className="sm:col-span-5">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={80}
                    placeholder="Teacher salary, Petrol, Electricity…"
                  />
                </Field>
                <Field label="Amount (₹)" required error={amountError} className="sm:col-span-2">
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </Field>
                <div className="flex items-end sm:col-span-2">
                  <Button onClick={() => add.mutate()} disabled={!ready || add.isPending}>
                    {add.isPending && <Spinner />}
                    Add
                  </Button>
                </div>
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </>
  );
}

/** "profit ₹500" / "loss ₹500" — the sign said in words, not left to a minus sign. */
function netLabel(netRupees: number): string {
  return `${netRupees >= 0 ? 'profit' : 'loss'} ${formatINR(Math.abs(netRupees))}`;
}

/**
 * Fee collection minus recorded expenses, green when ahead and red when behind.
 *
 * The only place in this app that colours a figure by its sign — red is otherwise reserved
 * for destructive actions. It earns the exception because the whole point of the card is
 * which way the month went, and that should be readable without doing the subtraction.
 */
function ProfitCard({
  label,
  collectedRupees,
  expenseRupees,
}: {
  label: string;
  collectedRupees: number;
  expenseRupees: number;
}) {
  const net = collectedRupees - expenseRupees;
  const inProfit = net >= 0;

  return (
    <Card>
      <CardBody>
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {inProfit ? 'Profit' : 'Loss'}
        </p>
        <p className={cn('text-2xl font-semibold', inProfit ? 'text-emerald-700' : 'text-red-700')}>
          {formatINR(Math.abs(net))}
        </p>
        <p className="text-xs text-slate-500">{label} · collected minus expenses</p>
      </CardBody>
    </Card>
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
