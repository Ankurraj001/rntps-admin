import {
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  classLabel,
  formatINR,
  toDateKey,
  type PaymentMode,
} from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, Printer, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { feeKeys, feesApi } from '@/api/fees';
import { PageHeader } from '@/components/layout/AppShell';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ErrorBlock, LoadingBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Field';
import { formatDate } from '@/lib/utils';
import { InvoiceStatusBadge } from './InvoicesPage';

export function InvoiceDetailPage() {
  const { invoiceId = '' } = useParams<{ invoiceId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const invoice = useQuery({
    queryKey: feeKeys.invoice(invoiceId),
    queryFn: () => feesApi.invoice(invoiceId),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: feeKeys.all });

  const reverse = useMutation({
    mutationFn: ({ receiptNo, reason }: { receiptNo: string; reason: string }) =>
      feesApi.reversePayment(invoiceId, receiptNo, reason),
    onSuccess: refresh,
  });

  const voidInvoice = useMutation({
    mutationFn: (reason: string) => feesApi.voidInvoice(invoiceId, reason),
    onSuccess: refresh,
  });

  if (invoice.isPending) return <LoadingBlock />;
  if (invoice.error) {
    return (
      <div className="p-6">
        <ErrorBlock message={(invoice.error as Error).message} />
        <Link to="/fees/invoices" className="mt-4 inline-block text-sm text-brand-700 underline">
          Back to invoices
        </Link>
      </div>
    );
  }

  const data = invoice.data;
  const canPay = data.status !== 'PAID' && data.status !== 'VOID';

  return (
    <>
      <PageHeader
        title={data.studentName}
        description={`${classLabel(data.classCode)} · ${data.period} · due ${formatDate(data.dueDate)}`}
        action={
          <div className="flex gap-2">
            <Link to="/fees/invoices">
              <Button variant="ghost">
                <ArrowLeft className="h-4 w-4" aria-hidden />
                Back
              </Button>
            </Link>
            <Link to={`/students/${data.studentId}`}>
              <Button variant="secondary">Student</Button>
            </Link>
            <Link to={`/fees/invoices/${encodeURIComponent(data.id)}/slip`}>
              <Button variant="secondary">
                <Printer className="h-4 w-4" aria-hidden />
                Fee slip
              </Button>
            </Link>
          </div>
        }
      />

      <div className="grid gap-5 p-6 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {reverse.error && <ErrorBlock message={(reverse.error as Error).message} />}
          {voidInvoice.error && <ErrorBlock message={(voidInvoice.error as Error).message} />}

          <Card>
            <CardHeader
              title="Invoice"
              description={data.id}
              action={<InvoiceStatusBadge status={data.status} isOverdue={data.isOverdue} />}
            />
            <CardBody>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {data.lineItems.map((item) => (
                    <tr key={item.code}>
                      <td className="py-2 text-slate-700">{item.name}</td>
                      <td className="py-2 text-right tabular-nums">{formatINR(item.amountRupees)}</td>
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td className="py-2">Gross</td>
                    <td className="py-2 text-right tabular-nums">{formatINR(data.grossRupees)}</td>
                  </tr>
                  {data.concessionRupees > 0 && (
                    <tr className="text-emerald-700">
                      <td className="py-2">Concession</td>
                      <td className="py-2 text-right tabular-nums">−{formatINR(data.concessionRupees)}</td>
                    </tr>
                  )}
                  <tr className="border-t-2 border-slate-300 text-base font-semibold">
                    <td className="py-2">Total</td>
                    <td className="py-2 text-right tabular-nums">{formatINR(data.totalRupees)}</td>
                  </tr>
                  <tr>
                    <td className="py-2 text-slate-600">Paid</td>
                    <td className="py-2 text-right tabular-nums text-slate-600">{formatINR(data.paidRupees)}</td>
                  </tr>
                  <tr className="font-semibold">
                    <td className="py-2">Balance</td>
                    <td className="py-2 text-right tabular-nums">{formatINR(data.balanceRupees)}</td>
                  </tr>
                </tbody>
              </table>

              {data.status === 'VOID' && (
                <p className="mt-4 rounded-md bg-slate-100 p-3 text-sm text-slate-700">
                  Voided: {data.voidReason}
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Payments" description="Reversed payments stay on the record." />
            {data.payments.length === 0 ? (
              <CardBody>
                <p className="py-4 text-center text-sm text-slate-500">Nothing recorded yet.</p>
              </CardBody>
            ) : (
              <CardBody className="divide-y divide-slate-100">
                {data.payments.map((payment) => (
                  <div
                    key={payment.receiptNo}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        {formatINR(payment.amountRupees)}
                        <span className="ml-2 font-normal text-slate-500">
                          {PAYMENT_MODE_LABELS[payment.mode]}
                        </span>
                        {payment.isReversed && <Badge tone="red">Reversed</Badge>}
                      </p>
                      <p className="font-mono text-xs text-slate-500">
                        {payment.receiptNo} · {formatDate(payment.paidAt)}
                        {payment.reference && ` · ${payment.reference}`}
                      </p>
                      {payment.isReversed && (
                        <p className="text-xs text-red-700">Reversed: {payment.reversalReason}</p>
                      )}
                    </div>

                    <div className="flex gap-2">
                      <Link to={`/fees/receipts/${encodeURIComponent(data.id)}/${payment.receiptNo}`}>
                        <Button variant="ghost" size="sm">
                          <Printer className="h-4 w-4" aria-hidden />
                          Receipt
                        </Button>
                      </Link>
                      {!payment.isReversed && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600"
                          disabled={reverse.isPending}
                          onClick={() => {
                            const reason = window.prompt(
                              `Reverse ${payment.receiptNo} (${formatINR(payment.amountRupees)})?\n\nReason (stays on the record):`,
                            );
                            if (reason && reason.trim().length >= 3) {
                              reverse.mutate({ receiptNo: payment.receiptNo, reason: reason.trim() });
                            }
                          }}
                        >
                          <Undo2 className="h-4 w-4" aria-hidden />
                          Reverse
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </CardBody>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          {canPay && <RecordPaymentCard invoiceId={invoiceId} balanceRupees={data.balanceRupees} onDone={refresh} />}

          {data.status !== 'VOID' && (
            <Card>
              <CardHeader title="Void invoice" description="For an invoice raised in error." />
              <CardBody>
                <Button
                  variant="secondary"
                  className="w-full text-red-600"
                  disabled={voidInvoice.isPending}
                  onClick={() => {
                    const reason = window.prompt('Void this invoice?\n\nReason (stays on the record):');
                    if (reason && reason.trim().length >= 3) voidInvoice.mutate(reason.trim());
                  }}
                >
                  <Ban className="h-4 w-4" aria-hidden />
                  Void
                </Button>
                {data.paidRupees > 0 && (
                  <p className="mt-2 text-xs text-slate-500">
                    Reverse the payments first — otherwise the collection report would not add up.
                  </p>
                )}
              </CardBody>
            </Card>
          )}

          <Button variant="ghost" className="w-full" onClick={() => navigate('/fees/invoices')}>
            Back to invoices
          </Button>
        </div>
      </div>
    </>
  );
}

function RecordPaymentCard({
  invoiceId,
  balanceRupees,
  onDone,
}: {
  invoiceId: string;
  balanceRupees: number;
  onDone: () => void;
}) {
  const [rupees, setRupees] = useState(String(balanceRupees));
  const [mode, setMode] = useState<PaymentMode>('CASH');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(toDateKey());
  const [notes, setNotes] = useState('');

  const typed = Number(rupees || 0);
  const amountRupees = Math.trunc(typed);
  const tooMuch = amountRupees > balanceRupees;
  // Refuse a fractional amount rather than quietly truncating it — a receipt that says
  // ₹500 for a ₹500.75 payment is a reconciliation problem months later.
  const amountError = tooMuch
    ? 'More than the outstanding balance'
    : Number.isInteger(typed)
      ? undefined
      : 'Enter a whole number of rupees';

  const record = useMutation({
    mutationFn: () =>
      feesApi.recordPayment(invoiceId, { amountRupees, mode, reference, paidAt, notes }),
    onSuccess: () => {
      setReference('');
      setNotes('');
      onDone();
    },
  });

  return (
    <Card>
      <CardHeader title="Record payment" description={`Outstanding ${formatINR(balanceRupees)}`} />
      <CardBody className="space-y-3">
        {record.error && <ErrorBlock message={(record.error as Error).message} />}

        <Field label="Amount (₹)" required error={amountError}>
          <Input
            type="number"
            min="1"
            step="1"
            value={rupees}
            onChange={(e) => setRupees(e.target.value)}
          />
        </Field>

        <Field label="Mode" required>
          <Select value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>
            {PAYMENT_MODES.map((value) => (
              <option key={value} value={value}>
                {PAYMENT_MODE_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Reference" hint="UPI ref, cheque number — optional">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>

        <Field label="Received on" required>
          <Input type="date" max={toDateKey()} value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </Field>

        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <Button
          className="w-full"
          onClick={() => record.mutate()}
          disabled={record.isPending || Boolean(amountError) || amountRupees <= 0}
        >
          {record.isPending && <Spinner />}
          Record {formatINR(amountRupees)}
        </Button>
      </CardBody>
    </Card>
  );
}
