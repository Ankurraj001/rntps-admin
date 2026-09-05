import {
  EXAM_CODES,
  EXAM_LABELS,
  STUDENT_STATUSES,
  academicYearForPeriod,
  buildLineItems,
  classLabel,
  formatAadhaar,
  formatINR,
  isTransportHead,
  TRANSPORT_HEAD_CODE,
} from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Printer, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { academicKeys, academicsApi } from '@/api/academics';
import { attendanceApi, attendanceKeys } from '@/api/attendance';
import { feeKeys, feesApi } from '@/api/fees';
import { studentKeys, studentsApi } from '@/api/students';
import { PageHeader } from '@/components/layout/AppShell';
import { RecordPaymentCard } from '@/components/fees/RecordPaymentCard';
import { WhatsAppInvoiceButton } from '@/components/fees/WhatsAppInvoiceButton';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorBlock, LoadingBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Field';
import { useAuth } from '@/auth/AuthProvider';
import { ageFrom, cn, displayPhone, formatDate } from '@/lib/utils';

// Fees leads: what a parent is at the counter about is almost always money.
const TABS = ['Fees', 'Profile', 'Family', 'Attendance', 'Academics'] as const;
type Tab = (typeof TABS)[number];

export function StudentDetailPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const { studentId = '' } = useParams<{ studentId: string }>();
  const [tab, setTab] = useState<Tab>('Fees');

  // Fees is admin-only on the API, so for a teacher that tab holds nothing but a notice.
  // Hiding it rather than showing a dead tab also lands them on Profile by default.
  const tabs = TABS.filter((name) => name !== 'Fees' || isAdmin);
  // Guards the moment before the signed-in user resolves, when `tabs` can still change.
  const active = tabs.includes(tab) ? tab : tabs[0];

  const student = useQuery({
    queryKey: studentKeys.detail(studentId),
    queryFn: () => studentsApi.get(studentId),
  });

  const siblings = useQuery({
    queryKey: studentKeys.siblings(studentId),
    queryFn: () => studentsApi.siblings(studentId),
    enabled: tab === 'Family',
  });

  if (student.isPending) return <LoadingBlock label="Loading student…" />;
  if (student.error) {
    return (
      <div className="p-6">
        <ErrorBlock
          message={(student.error as Error).message}
          onRetry={() => void student.refetch()}
        />
        <Link to="/students" className="mt-4 inline-block text-sm text-brand-700 underline">
          Back to students
        </Link>
      </div>
    );
  }

  const data = student.data;

  return (
    <>
      <PageHeader
        title={data.fullName}
        description={`${data.studentId} · ${classLabel(data.classCode)}${data.rollNo ? ` · Roll ${data.rollNo}` : ''}`}
        action={
          <div className="flex gap-2">
            <Link to="/students">
              <Button variant="ghost">
                <ArrowLeft className="h-4 w-4" aria-hidden />
                Back
              </Button>
            </Link>
            {isAdmin && (
              <Link to={`/students/${data.studentId}/edit`}>
                <Button variant="secondary">
                  <Pencil className="h-4 w-4" aria-hidden />
                  Edit
                </Button>
              </Link>
            )}
          </div>
        }
      />

      <div className="border-b border-slate-200 bg-white px-6">
        <nav className="flex gap-1" role="tablist">
          {tabs.map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={active === name}
              onClick={() => setTab(name)}
              className={cn(
                '-mb-px border-b-2 px-4 py-3 text-sm font-medium',
                active === name
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800',
              )}
            >
              {name}
            </button>
          ))}
        </nav>
      </div>

      <div className="space-y-5 p-6">
        {active === 'Profile' && <ProfileTab student={data} canEdit={isAdmin} />}
        {active === 'Family' && (
          <FamilyTab
            familyId={data.familyId}
            isPending={siblings.isPending}
            siblings={siblings.data?.items ?? []}
          />
        )}
        {active === 'Fees' && <StudentFeesTab student={data} canManage={isAdmin} />}
        {active === 'Attendance' && <StudentAttendanceTab studentId={studentId} />}
        {active === 'Academics' && <StudentAcademicsTab studentId={studentId} />}
      </div>
    </>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value}</dd>
    </div>
  );
}

function ProfileTab({
  student,
  canEdit,
}: {
  student: import('@rntps/shared').StudentDto;
  canEdit: boolean;
}) {
  return (
    <>
      <Card>
        <CardHeader title="Profile" action={<StatusBadge status={student.status} />} />
        <CardBody>
          <dl className="grid gap-5 sm:grid-cols-3">
            <Detail
              label="Student ID"
              value={<span className="font-mono">{student.studentId}</span>}
            />
            <Detail label="Class" value={classLabel(student.classCode)} />
            <Detail label="Roll number" value={student.rollNo ?? '—'} />
            <Detail
              label="Date of birth"
              value={`${formatDate(student.dob)} (${ageFrom(student.dob)})`}
            />
            <Detail
              label="Gender"
              value={student.gender.charAt(0) + student.gender.slice(1).toLowerCase()}
            />
            <Detail label="Admitted" value={formatDate(student.admissionDate)} />
            <Detail label="Academic year" value={student.academicYear} />
            <Detail
              label="Aadhaar"
              value={
                student.aadhaar ? (
                  <span className="font-mono">{formatAadhaar(student.aadhaar)}</span>
                ) : (
                  '—'
                )
              }
            />
            <Detail
              label="APAAR ID / PEN"
              value={student.apaarId ? <span className="font-mono">{student.apaarId}</span> : '—'}
            />
            <Detail
              label="Transport"
              value={
                !student.transportOpted
                  ? 'No'
                  : student.transportFareOverrideRupees === null
                    ? 'Yes — class default fare'
                    : `Yes — ${formatINR(student.transportFareOverrideRupees)}`
              }
            />
            <Detail
              label="Discount"
              value={
                student.concession.type === 'NONE'
                  ? 'None'
                  : `${student.concession.type === 'PERCENT' ? `${student.concession.value}%` : formatINR(student.concession.value)}${student.concession.reason ? ` · ${student.concession.reason}` : ''}`
              }
            />
            <Detail
              label="Address"
              value={
                [
                  student.address.line1,
                  student.address.city,
                  student.address.state,
                  student.address.pincode,
                ]
                  .filter(Boolean)
                  .join(', ') || '—'
              }
            />
          </dl>

          {student.notes && (
            <div className="mt-6 border-t border-slate-100 pt-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Notes</p>
              <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{student.notes}</p>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Guardians" />
        <CardBody className="divide-y divide-slate-100">
          {student.guardians.map((guardian) => (
            <div
              key={guardian.phone}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div>
                <p className="text-sm font-medium text-slate-900">
                  {guardian.name}
                  <span className="ml-2 text-xs font-normal text-slate-500">
                    {guardian.relation.charAt(0) + guardian.relation.slice(1).toLowerCase()}
                  </span>
                </p>
                <p className="font-mono text-xs text-slate-500">{displayPhone(guardian.phone)}</p>
              </div>
              <div className="flex gap-2">
                {guardian.isPrimary && <Badge tone="green">Primary</Badge>}
                {guardian.whatsappOptOut && (
                  <span className="text-xs text-amber-700">No WhatsApp</span>
                )}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      {canEdit && <StatusCard student={student} />}
    </>
  );
}

function FamilyTab({
  familyId,
  siblings,
  isPending,
}: {
  familyId: string;
  siblings: import('@rntps/shared').SiblingDto[];
  isPending: boolean;
}) {
  return (
    <Card>
      <CardHeader
        title="Siblings in school"
        description={`Family ID ${familyId} — fee reminders go to this family as one message.`}
      />
      {isPending && <LoadingBlock />}
      {!isPending && siblings.length === 0 && (
        <EmptyState
          title="No siblings on the roll"
          description="Link a sibling when onboarding the next child from this family."
        />
      )}
      {!isPending && siblings.length > 0 && (
        <CardBody className="divide-y divide-slate-100">
          {siblings.map((sibling) => (
            <Link
              key={sibling.studentId}
              to={`/students/${sibling.studentId}`}
              className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0 hover:text-brand-700"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <Users className="h-4 w-4 text-slate-400" aria-hidden />
                {sibling.fullName}
              </span>
              <span className="text-xs text-slate-500">
                {classLabel(sibling.classCode)} · {sibling.studentId}
              </span>
            </Link>
          ))}
        </CardBody>
      )}
    </Card>
  );
}

/**
 * Everything this student owes beyond the fees the whole class pays.
 *
 * Three groups, because they behave differently:
 *
 *   - **Every month** — recurring, billed by the fee run. Transport, when they opted in.
 *     Shown for visibility; the amount is already inside each monthly invoice, so it is
 *     not added to the outstanding total.
 *   - **Waiting for the next invoice** — charges entered here. They are not invoices yet;
 *     the next monthly run folds them into that month's single invoice.
 *   - **Already billed** — charges that a monthly invoice has absorbed, with a link to it.
 *     This group follows the session picked on the Invoices card, since it is history and
 *     grows with every month. The two groups above are about now and next, so they always
 *     show whichever session is selected.
 */
function DuesCard({
  studentId,
  extras,
  year,
}: {
  studentId: string;
  extras: MonthlyExtra[];
  year: string;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');

  const charges = useQuery({
    queryKey: studentKeys.charges(studentId),
    queryFn: () => studentsApi.charges(studentId),
  });

  const typed = Number(amount || 0);
  // Refused rather than truncated, as everywhere else money is entered. A non-positive
  // amount says so rather than only disabling the button: reaching for a negative charge
  // is the obvious way to try to record a discount, so point at where that actually lives.
  const amountError =
    amount === ''
      ? undefined
      : !Number.isInteger(typed)
        ? 'Enter a whole number of rupees'
        : typed <= 0
          ? 'A charge is always positive — use the Discount field on the student form to reduce fees'
          : undefined;
  const ready = name.trim().length >= 2 && typed > 0 && !amountError;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: studentKeys.charges(studentId) }),
      queryClient.invalidateQueries({ queryKey: feeKeys.studentInvoices(studentId) }),
    ]);
  };

  const add = useMutation({
    mutationFn: () =>
      studentsApi.addCharge(studentId, { name: name.trim(), amountRupees: Math.trunc(typed) }),
    onSuccess: async () => {
      setName('');
      setAmount('');
      setOpen(false);
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (chargeId: string) => studentsApi.removeCharge(studentId, chargeId),
    onSuccess: refresh,
  });

  const items = charges.data?.items ?? [];
  const pending = items.filter((charge) => charge.billedOnInvoiceId === null);
  const billed = items.filter(
    (charge) =>
      charge.billedOnInvoiceId !== null &&
      (year === ALL_YEARS ||
        // A billed charge with no period on record cannot be filed under a session.
        // Showing it in every year beats dropping it out of all of them.
        charge.billedPeriod === null ||
        academicYearForPeriod(charge.billedPeriod) === year),
  );
  const pendingTotal = pending.reduce((sum, charge) => sum + charge.amountRupees, 0);

  return (
    <Card>
      <CardHeader
        title="Dues and other charges"
        description="Everything on this student's bill beyond the fees the whole class pays"
      />

      <CardBody className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Every month</p>
        {extras.map((row) => (
          <div key={row.key}>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0">
                <span className={cn('font-medium', row.none && 'text-slate-500')}>{row.label}</span>
                {row.tag && <span className="ml-2 text-xs text-slate-500">{row.tag}</span>}
              </span>
              <span
                className={cn(
                  'tabular-nums',
                  row.none ? 'text-slate-400' : row.credit ? 'text-emerald-700' : 'text-slate-600',
                )}
              >
                {row.value}
              </span>
            </div>
            {row.note && <p className="mt-0.5 text-xs text-amber-700">{row.note}</p>}
          </div>
        ))}
        {extras.some((row) => !row.none) && (
          <p className="text-xs text-slate-500">
            Already included in each monthly invoice, so not counted again in the outstanding total.
          </p>
        )}
      </CardBody>

      {charges.error && (
        <CardBody className="border-t border-slate-100">
          <ErrorBlock message={(charges.error as Error).message} />
        </CardBody>
      )}

      {pending.length > 0 && (
        <CardBody className="space-y-2 border-t border-slate-100">
          <div className="flex items-baseline justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Waiting for the next invoice
            </p>
            <p className="text-xs font-medium tabular-nums text-slate-600">
              {formatINR(pendingTotal)}
            </p>
          </div>
          {pending.map((charge) => (
            <div key={charge.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 font-medium">{charge.name}</span>
              <span className="flex items-center gap-3">
                <span className="tabular-nums text-slate-600">
                  {formatINR(charge.amountRupees)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(charge.id)}
                >
                  Remove
                </Button>
              </span>
            </div>
          ))}
          <p className="text-xs text-slate-500">
            Not billed yet. The next monthly invoice for this student will include these.
          </p>
        </CardBody>
      )}

      {billed.length > 0 && (
        <CardBody className="space-y-2 border-t border-slate-100">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Already billed{year !== ALL_YEARS && ` · ${year}`}
          </p>
          {billed.map((charge) => (
            <div key={charge.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 text-slate-600">{charge.name}</span>
              <span className="flex items-center gap-3">
                <span className="tabular-nums text-slate-500">
                  {formatINR(charge.amountRupees)}
                </span>
                <Link
                  to={`/fees/invoices/${encodeURIComponent(charge.billedOnInvoiceId ?? '')}`}
                  className="text-xs text-brand-700 hover:underline"
                >
                  {charge.billedPeriod ?? 'invoice'}
                </Link>
              </span>
            </div>
          ))}
        </CardBody>
      )}

      {remove.error && (
        <CardBody className="border-t border-slate-100">
          <ErrorBlock message={(remove.error as Error).message} />
        </CardBody>
      )}

      {!open ? (
        <CardBody className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100">
          <p className="text-xs text-slate-500">
            Arrears, exam fees, trips, fines — added to this student's next invoice.
          </p>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            Add a charge
          </Button>
        </CardBody>
      ) : (
        <CardBody className="space-y-3 border-t border-slate-100">
          {add.error && <ErrorBlock message={(add.error as Error).message} />}

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="What is it for" required className="sm:col-span-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                autoFocus
                placeholder="Dues carried forward, Annual exam fee, Picnic…"
              />
            </Field>
            <Field label="Amount (₹)" required error={amountError}>
              <Input
                type="number"
                min="1"
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          </div>

          <div className="flex items-center justify-end gap-3">
            <Button
              variant="secondary"
              onClick={() => {
                setName('');
                setAmount('');
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button onClick={() => add.mutate()} disabled={!ready || add.isPending}>
              {add.isPending && <Spinner />}
              Add charge
            </Button>
          </div>
        </CardBody>
      )}
    </Card>
  );
}

function StatusCard({ student }: { student: import('@rntps/shared').StudentDto }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState(student.status);
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: () => studentsApi.setStatus(student.studentId, status, reason),
    onSuccess: async () => {
      setReason('');
      await queryClient.invalidateQueries({ queryKey: studentKeys.all });
    },
  });

  const changed = status !== student.status;

  return (
    <Card>
      <CardHeader
        title="Status"
        description="Students are never deleted — mark them inactive, TC issued or alumni instead."
      />
      <CardBody className="flex flex-wrap items-end gap-3">
        <Select
          aria-label="Student status"
          className="w-44"
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
        >
          {STUDENT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value.replace('_', ' ').toLowerCase()}
            </option>
          ))}
        </Select>

        <Input
          aria-label="Reason"
          placeholder="Reason (added to notes)"
          className="min-w-56 flex-1"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />

        <Button disabled={!changed || mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending && <Spinner />}
          Update status
        </Button>

        {mutation.error && <ErrorBlock message={(mutation.error as Error).message} />}
      </CardBody>
    </Card>
  );
}

function StudentAttendanceTab({ studentId }: { studentId: string }) {
  const history = useQuery({
    queryKey: attendanceKeys.student(studentId),
    queryFn: () => attendanceApi.forStudent(studentId),
  });

  if (history.isPending) return <LoadingBlock />;
  if (history.error) return <ErrorBlock message={(history.error as Error).message} />;

  const { records, totals } = history.data;

  return (
    <>
      <Card>
        <CardHeader title="Attendance" description="Across every marked day." />
        <CardBody>
          <dl className="grid gap-5 sm:grid-cols-5">
            <Detail label="Present" value={totals.present} />
            <Detail label="Absent" value={totals.absent} />
            <Detail label="Working days" value={totals.workingDays} />
            <Detail
              label="Percentage"
              value={
                totals.workingDays === 0 ? (
                  '—'
                ) : (
                  <Badge tone={totals.percentage >= 75 ? 'green' : 'red'}>
                    {totals.percentage}%
                  </Badge>
                )
              }
            />
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="History" description="Most recent first." />
        {records.length === 0 ? (
          <EmptyState
            title="Nothing marked yet"
            description="Attendance will appear here once a roster is saved."
          />
        ) : (
          <CardBody className="divide-y divide-slate-100">
            {records.map((record) => (
              <div
                key={record.dateKey}
                className="flex items-center justify-between py-2 text-sm first:pt-0 last:pb-0"
              >
                <span className="text-slate-700">{formatDate(record.dateKey)}</span>
                <span className="flex items-center gap-3">
                  {record.remarks && (
                    <span className="text-xs text-slate-500">{record.remarks}</span>
                  )}
                  <span className="font-medium text-slate-900">{record.status.toLowerCase()}</span>
                </span>
              </div>
            ))}
          </CardBody>
        )}
      </Card>
    </>
  );
}

function StudentAcademicsTab({ studentId }: { studentId: string }) {
  const history = useQuery({
    queryKey: academicKeys.student(studentId),
    queryFn: () => academicsApi.student(studentId),
  });

  if (history.isPending) return <LoadingBlock />;
  if (history.error) return <ErrorBlock message={(history.error as Error).message} />;

  const { years } = history.data;

  if (years.length === 0) {
    return (
      <Card>
        <CardHeader title="Academics" description="Exam marks, by session." />
        <EmptyState
          title="No marks recorded yet"
          description="Marks entered on the Academics page will appear here."
        />
      </Card>
    );
  }

  return (
    <>
      {years.map((year) => (
        <Card key={year.academicYear}>
          <CardHeader
            title={year.academicYear}
            description={`${classLabel(year.classCode)}${year.rollNo === null ? '' : ` · Roll ${year.rollNo}`}`}
          />
          <CardBody>
            <dl className="grid gap-5 sm:grid-cols-3">
              {EXAM_CODES.map((code) => (
                <Detail
                  key={code}
                  label={EXAM_LABELS[code]}
                  value={year.scores[code] === null ? '—' : `${year.scores[code]!.toFixed(2)}%`}
                />
              ))}
            </dl>
          </CardBody>
        </Card>
      ))}
    </>
  );
}

/** One line in the "every month" list: what it is, and what it costs — or why it does not. */
type MonthlyExtra = {
  key: string;
  label: string;
  /** Small qualifier beside the label, e.g. "own fare". */
  tag?: string;
  /** Right-hand text — an amount, or the reason nothing is billed. */
  value: string;
  /** True when nothing is actually charged, so the row renders muted. */
  none?: boolean;
  /** True when the amount comes off the bill, so it renders green like a concession. */
  credit?: boolean;
  /** A situation that needs explaining rather than just stating. */
  note?: string;
};

/**
 * The transport rows.
 *
 * Transport always produces a row, even when the student has not opted in. A hidden row
 * is indistinguishable from a row that has not loaded, and "does this child use the bus?"
 * is exactly the question this section exists to answer.
 *
 * Amounts come from the same `buildLineItems()` the invoice run uses, so what is shown
 * here cannot drift from what is billed.
 */
function transportExtrasFor(
  student: import('@rntps/shared').StudentDto,
  structure: import('@rntps/shared').FeeStructureDto | undefined,
  structuresPending: boolean,
): MonthlyExtra[] {
  const fare = student.transportFareOverrideRupees;
  const transportHead = structure?.heads.find(isTransportHead);

  // The cases where nothing is billed each need their own explanation — "Not opted" and
  // "this class has no transport fee" are very different problems.
  if (!student.transportOpted) {
    return [
      {
        key: 'transport',
        label: 'Transport',
        value: 'Not opted',
        none: true,
        // A fare left behind after transport was switched off is easy to miss, and it
        // silently does nothing.
        note:
          fare !== null
            ? `A fare of ${formatINR(fare)} is on record but is not billed while transport is off.`
            : undefined,
      },
    ];
  }
  if (structuresPending) {
    return [{ key: 'transport', label: 'Transport', value: '…', none: true }];
  }
  if (!structure) {
    return [
      {
        key: 'transport',
        label: 'Transport',
        value: 'No fee structure',
        none: true,
        note: `${classLabel(student.classCode)} has no fee structure for this year, so nothing can be billed yet.`,
      },
    ];
  }
  // No class transport head and no fare of their own: nothing to charge, and it needs
  // fixing. With a fare set, buildLineItems bills it regardless of the class structure,
  // so that case falls through to the rows below.
  if (!transportHead && fare === null) {
    return [
      {
        key: 'transport',
        label: 'Transport',
        value: 'No fare set',
        none: true,
        note: `This student uses transport, but neither they nor ${classLabel(student.classCode)} has an amount set, so nothing is billed. Set a fare on this student, or add a transport fee to the class.`,
      },
    ];
  }

  // Transport is billed. Read the rows straight off the lines the invoice would carry, so
  // every opt-in head appears — and appears at the amount actually charged, including ₹0
  // for a child who travels free.
  const rows: MonthlyExtra[] = [];
  for (const line of buildLineItems(structure.heads, student).lineItems) {
    const head = structure.heads.find((h) => h.code === line.code);
    // A transport line billed from the student's own fare has no head in the structure,
    // so `head` is undefined — that is the synthesised line, not something to skip.
    if (head && head.appliesTo === 'ALL') continue;
    const isTransport = head ? isTransportHead(head) : line.code === TRANSPORT_HEAD_CODE;
    if (!head && !isTransport) continue;
    rows.push({
      key: line.code,
      label: line.name,
      tag: isTransport && fare !== null ? 'own fare' : 'class rate',
      value: `${formatINR(line.amountRupees)} / month`,
      note:
        !head && isTransport
          ? `Billed from this student's own fare — ${classLabel(student.classCode)} has no transport fee in its structure.`
          : undefined,
    });
  }

  return rows;
}

/**
 * The standing discount row.
 *
 * Shown even when there is none, for the same reason transport is: "does this child get a
 * discount?" is a question this section should answer outright rather than by omission.
 */
function discountExtraFor(
  student: import('@rntps/shared').StudentDto,
  structure: import('@rntps/shared').FeeStructureDto | undefined,
  structuresPending: boolean,
): MonthlyExtra {
  const { type, value, reason } = student.concession;

  if (type === 'NONE' || value <= 0) {
    return { key: 'discount', label: 'Discount', value: 'None', none: true };
  }

  // A percentage is not settable from the student form, and its rupee value moves with
  // the fee lines, so state the rate rather than a figure that could mislead.
  if (type === 'PERCENT') {
    return {
      key: 'discount',
      label: 'Discount',
      tag: reason || undefined,
      value: `${value}% / month`,
      credit: true,
    };
  }

  // The discount is clamped to the fees it comes off, so a flat amount larger than the
  // monthly fee lines is quietly capped. Say so rather than promising a bigger reduction.
  const feeLines = structuresPending || !structure ? null : buildLineItems(structure.heads, student).lineItems;
  const billable = feeLines === null ? null : feeLines.reduce((sum, line) => sum + line.amountRupees, 0);

  return {
    key: 'discount',
    label: 'Discount',
    tag: reason || undefined,
    value: `−${formatINR(value)} / month`,
    credit: true,
    note:
      billable !== null && value > billable
        ? `Only ${formatINR(billable)} is taken off, since that is all this student is billed in fees each month. A discount never becomes a credit.`
        : undefined,
  };
}

/**
 * Everything billed to this student every month beyond what the whole class pays, and
 * anything that comes off it.
 *
 * Composed rather than built in one pass because the transport rows return early in
 * several states — not opted in, no structure, no fare — and the discount has to show up
 * in every one of them.
 */
function monthlyExtrasFor(
  student: import('@rntps/shared').StudentDto,
  structure: import('@rntps/shared').FeeStructureDto | undefined,
  structuresPending: boolean,
): MonthlyExtra[] {
  return [
    ...transportExtrasFor(student, structure, structuresPending),
    discountExtraFor(student, structure, structuresPending),
  ];
}

/** Sentinel for "don't filter" in the session picker — no academic year can collide with it. */
const ALL_YEARS = 'ALL';

/**
 * Sessions offered in the picker, newest first.
 *
 * The student's own session is always included even when nothing has been billed in it
 * yet: in April, before the first run of a new session, the picker would otherwise not
 * offer the year the school is actually in.
 */
function academicYearsIn(
  invoices: import('@rntps/shared').InvoiceDto[],
  studentYear: string,
): string[] {
  const years = new Set(invoices.map((invoice) => invoice.academicYear));
  years.add(studentYear);
  return [...years].sort().reverse();
}

/**
 * Which session the picker opens on — the student's current one, which is what a parent
 * at the counter is asking about.
 *
 * Falls back to the newest session that actually has invoices when the current one has
 * none, because opening on an empty list reads as a broken screen rather than a filtered
 * one. That is the normal state for an alumnus, and for anyone whose billing stopped.
 */
function defaultAcademicYear(
  invoices: import('@rntps/shared').InvoiceDto[],
  studentYear: string,
): string {
  if (invoices.some((invoice) => invoice.academicYear === studentYear)) return studentYear;
  // Invoices arrive newest period first, so the first one carries the latest session.
  return invoices[0]?.academicYear ?? studentYear;
}

function StudentFeesTab({
  student,
  canManage,
}: {
  student: import('@rntps/shared').StudentDto;
  canManage: boolean;
}) {
  const studentId = student.studentId;
  const queryClient = useQueryClient();
  // Null until the picker is touched: the sensible default depends on invoices that have
  // not loaded on first render, so it is resolved lazily below rather than through an
  // effect that would flash the wrong session first.
  const [pickedYear, setPickedYear] = useState<string | null>(null);
  // One consolidated payment can land on more than one invoice, each minting its own
  // receipt — kept around just long enough to point at all of them once, not merged into
  // a single number that would hide which invoices were actually touched.
  const [lastPaymentReceipts, setLastPaymentReceipts] = useState<
    { invoiceId: string; period: string; receiptNo: string; amountRupees: number }[] | null
  >(null);

  const invoices = useQuery({
    queryKey: feeKeys.studentInvoices(studentId),
    queryFn: () => feesApi.studentInvoices(studentId),
    // Fees are admin-only on the API; asking as a teacher would just 403.
    enabled: canManage,
  });

  // Needed to show what this student's recurring extras actually cost. Admin-only, like
  // this whole tab.
  const structures = useQuery({
    queryKey: feeKeys.structures(),
    queryFn: () => feesApi.structures(),
    enabled: canManage,
  });

  // Families usually pay for every sibling at once, so the number that matters at the
  // counter is often this, not just the one student being viewed.
  const familyBalance = useQuery({
    queryKey: feeKeys.familyBalance(student.familyId),
    queryFn: () => feesApi.familyBalance(student.familyId),
    enabled: canManage,
  });

  if (!canManage) {
    return (
      <Card>
        <EmptyState title="Fees are managed by an administrator" />
      </Card>
    );
  }
  if (invoices.isPending) return <LoadingBlock />;
  if (invoices.error) return <ErrorBlock message={(invoices.error as Error).message} />;

  const items = invoices.data.items;
  const live = items.filter((i) => i.status !== 'VOID');
  // Every session on purpose, not the filtered view: this is the figure collected against
  // at the counter, and the payment card below settles oldest invoice first across all
  // years. A total that moved with the picker would name a different amount from the one
  // actually being paid.
  const outstanding = live.reduce((sum, i) => sum + i.balanceRupees, 0);

  const years = academicYearsIn(items, student.academicYear);
  const year = pickedYear ?? defaultAcademicYear(items, student.academicYear);
  const shown = year === ALL_YEARS ? items : items.filter((i) => i.academicYear === year);
  // What the picker is holding back, so a debt from an earlier session cannot sit unseen
  // behind a filter that opens on this one.
  const dueElsewhere =
    year === ALL_YEARS
      ? 0
      : live
          .filter((invoice) => invoice.academicYear !== year)
          .reduce((sum, invoice) => sum + invoice.balanceRupees, 0);

  const structure = structures.data?.items.find((item) => item.classCode === student.classCode);
  const extras = monthlyExtrasFor(student, structure, structures.isPending);

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardBody className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Total outstanding</p>
              <p className="text-3xl font-semibold tabular-nums">{formatINR(outstanding)}</p>
            </div>
            <p className="text-xs text-slate-500">
              Across {live.length} {live.length === 1 ? 'invoice' : 'invoices'}
            </p>
          </CardBody>
        </Card>

        {familyBalance.data && familyBalance.data.children.length > 1 && (
          <Card>
            <CardHeader
              title="Family outstanding"
              description={`Family ID ${student.familyId} — total owed across every sibling`}
            />
            <CardBody className="space-y-3">
              <p className="text-2xl font-semibold tabular-nums">
                {formatINR(familyBalance.data.totalOutstandingRupees)}
              </p>
              <ul className="divide-y divide-slate-100">
                {familyBalance.data.children.map((child) => (
                  <li
                    key={child.studentId}
                    className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                  >
                    {child.studentId === studentId ? (
                      <span className="text-sm font-medium">
                        {child.fullName}{' '}
                        <span className="text-xs text-slate-500">(this student)</span>
                      </span>
                    ) : (
                      <Link
                        to={`/students/${child.studentId}`}
                        className="text-sm font-medium hover:text-brand-700"
                      >
                        {child.fullName}
                      </Link>
                    )}
                    <span className="text-sm tabular-nums">{formatINR(child.outstandingRupees)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Invoices"
            description="One per month, covering fees, transport and any charges"
            action={
              <Select
                aria-label="Filter invoices by session"
                className="w-36 shrink-0"
                value={year}
                onChange={(event) => setPickedYear(event.target.value)}
              >
                <option value={ALL_YEARS}>All years</option>
                {years.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            }
          />
          {items.length === 0 ? (
            <EmptyState
              title="No invoices yet"
              description="Generate invoices for a month to see them here."
            />
          ) : shown.length === 0 ? (
            <EmptyState
              title={`Nothing billed in ${year}`}
              description="Pick another session to see this student's other invoices."
            />
          ) : (
            <CardBody className="divide-y divide-slate-100">
              {shown.map((invoice) => (
                <InvoiceRow key={invoice.id} invoice={invoice} label={invoice.period} />
              ))}
            </CardBody>
          )}
          {dueElsewhere > 0 && (
            <CardBody className="border-t border-slate-100">
              <p className="text-xs text-amber-700">
                {formatINR(dueElsewhere)} still due outside {year}.{' '}
                <button
                  type="button"
                  className="underline"
                  onClick={() => setPickedYear(ALL_YEARS)}
                >
                  Show all years
                </button>
              </p>
            </CardBody>
          )}
        </Card>

        <DuesCard studentId={studentId} extras={extras} year={year} />
      </div>

      <div className="space-y-5">
        {outstanding > 0 && (
          <RecordPaymentCard
            title="Record payment"
            description={`Outstanding ${formatINR(outstanding)} across ${live.length} ${
              live.length === 1 ? 'invoice' : 'invoices'
            }`}
            balanceRupees={outstanding}
            onSubmit={async (payload) => {
              const result = await feesApi.recordStudentPayment(studentId, payload);
              setLastPaymentReceipts(
                result.invoices.map((invoice) => {
                  const last = invoice.payments[invoice.payments.length - 1];
                  return {
                    invoiceId: invoice.id,
                    period: invoice.period,
                    receiptNo: last?.receiptNo ?? '',
                    amountRupees: last?.amountRupees ?? 0,
                  };
                }),
              );
              return result;
            }}
            onDone={() => queryClient.invalidateQueries({ queryKey: feeKeys.studentInvoices(studentId) })}
          />
        )}

        {lastPaymentReceipts && lastPaymentReceipts.length > 0 && (
          <div className="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <div className="flex items-center justify-between gap-3">
              <p className="font-medium">
                {lastPaymentReceipts.length > 1
                  ? `Recorded across ${lastPaymentReceipts.length} invoices`
                  : 'Recorded'}
              </p>
              <button
                type="button"
                className="text-xs underline"
                onClick={() => setLastPaymentReceipts(null)}
              >
                Dismiss
              </button>
            </div>
            <ul className="mt-1 space-y-1">
              {lastPaymentReceipts.map((receipt) => (
                <li key={receipt.receiptNo}>
                  {receipt.period} — {formatINR(receipt.amountRupees)} —{' '}
                  <Link
                    className="underline"
                    to={`/fees/receipts/${encodeURIComponent(receipt.invoiceId)}/${receipt.receiptNo}`}
                  >
                    Receipt {receipt.receiptNo}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function InvoiceRow({
  invoice,
  label,
}: {
  invoice: import('@rntps/shared').InvoiceDto;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3 py-3 text-sm first:pt-0 last:pb-0">
      <Link
        to={`/fees/invoices/${encodeURIComponent(invoice.id)}`}
        className="flex min-w-0 flex-1 items-center justify-between gap-3 hover:text-brand-700"
      >
        <span className="min-w-0">
          <span className="font-medium">{label}</span>
          {invoice.status === 'VOID' && <Badge tone="slate">Void</Badge>}
        </span>
        <span className="flex items-center gap-4 tabular-nums">
          <span className="text-slate-600">{formatINR(invoice.totalRupees)}</span>
          <span className="font-medium">
            {invoice.status === 'VOID'
              ? '—'
              : invoice.balanceRupees > 0
                ? `${formatINR(invoice.balanceRupees)} due`
                : 'settled'}
          </span>
        </span>
      </Link>
      <Link
        to={`/fees/invoices/${encodeURIComponent(invoice.id)}/slip`}
        className="shrink-0 text-slate-400 hover:text-brand-700"
        aria-label={`Fee slip for ${label}`}
        title="Fee slip"
      >
        <Printer className="h-4 w-4" aria-hidden />
      </Link>
      <WhatsAppInvoiceButton invoiceId={invoice.id} iconOnly />
    </div>
  );
}
