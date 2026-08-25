import { PAYMENT_MODE_LABELS, classLabel, formatINR } from '@rntps/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { feeKeys, feesApi } from '@/api/fees';
import { settingsApi, settingsKeys } from '@/api/settings';
import { Button } from '@/components/ui/Button';
import { ErrorBlock, LoadingBlock } from '@/components/ui/Feedback';
import { formatDate } from '@/lib/utils';

/**
 * Printed through the browser rather than generated as a server-side PDF.
 *
 * A school prints receipts from the browser anyway, and this keeps the receipt in the
 * same codebase as the data — no PDF layout library, no font bundling, and it works on
 * whatever printer the office already has. `@media print` in index.css hides the chrome.
 */
export function ReceiptPage() {
  const { invoiceId = '', receiptNo = '' } = useParams<{ invoiceId: string; receiptNo: string }>();

  const invoice = useQuery({ queryKey: feeKeys.invoice(invoiceId), queryFn: () => feesApi.invoice(invoiceId) });
  const settings = useQuery({ queryKey: settingsKeys.all, queryFn: settingsApi.get });

  // Give the browser a title that becomes the default PDF filename.
  useEffect(() => {
    const previous = document.title;
    document.title = `Receipt ${receiptNo}`;
    return () => {
      document.title = previous;
    };
  }, [receiptNo]);

  if (invoice.isPending || settings.isPending || !settings.data) return <LoadingBlock />;
  if (invoice.error) return <div className="p-6"><ErrorBlock message={(invoice.error as Error).message} /></div>;

  const payment = invoice.data.payments.find((p) => p.receiptNo === receiptNo);
  if (!payment) {
    return (
      <div className="p-6">
        <ErrorBlock message={`No payment found with receipt ${receiptNo}`} />
      </div>
    );
  }

  const school = settings.data;
  const data = invoice.data;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-4 flex justify-between print:hidden">
        <Link to={`/fees/invoices/${encodeURIComponent(invoiceId)}`}>
          <Button variant="ghost">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to invoice
          </Button>
        </Link>
        <Button onClick={() => window.print()}>
          <Printer className="h-4 w-4" aria-hidden />
          Print
        </Button>
      </div>

      <article className="rounded-lg border border-slate-300 bg-white p-8 print:border-0 print:p-0">
        <header className="border-b-2 border-slate-800 pb-4 text-center">
          <h1 className="text-xl font-bold uppercase tracking-wide text-slate-900">{school.schoolName}</h1>
          {school.schoolAddress && <p className="text-sm text-slate-600">{school.schoolAddress}</p>}
          {school.schoolPhone && <p className="text-sm text-slate-600">Phone: {school.schoolPhone}</p>}
          <p className="mt-3 inline-block border border-slate-400 px-3 py-1 text-sm font-semibold uppercase">
            Fee Receipt
          </p>
        </header>

        {payment.isReversed && (
          <p className="mt-4 border-2 border-red-600 p-2 text-center text-sm font-bold uppercase text-red-700">
            Reversed — {payment.reversalReason}
          </p>
        )}

        <dl className="mt-6 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-slate-600">Receipt no.</dt>
          <dd className="text-right font-mono font-semibold">{payment.receiptNo}</dd>

          <dt className="text-slate-600">Date</dt>
          <dd className="text-right">{formatDate(payment.paidAt)}</dd>

          <dt className="text-slate-600">Student</dt>
          <dd className="text-right font-semibold">{data.studentName}</dd>

          <dt className="text-slate-600">Student ID</dt>
          <dd className="text-right font-mono">{data.studentId}</dd>

          <dt className="text-slate-600">Class</dt>
          <dd className="text-right">{classLabel(data.classCode)}</dd>

          <dt className="text-slate-600">Fee month</dt>
          <dd className="text-right">{data.period}</dd>
        </dl>

        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-y border-slate-400 text-left">
              <th scope="col" className="py-2 font-semibold">Particulars</th>
              <th scope="col" className="py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.lineItems.map((item) => (
              <tr key={item.code} className="border-b border-slate-200">
                <td className="py-2">{item.name}</td>
                <td className="py-2 text-right tabular-nums">{formatINR(item.amountRupees)}</td>
              </tr>
            ))}
            {data.concessionRupees > 0 && (
              <tr className="border-b border-slate-200">
                <td className="py-2">Less: concession</td>
                <td className="py-2 text-right tabular-nums">−{formatINR(data.concessionRupees)}</td>
              </tr>
            )}
            <tr className="border-b border-slate-400 font-semibold">
              <td className="py-2">Invoice total</td>
              <td className="py-2 text-right tabular-nums">{formatINR(data.totalRupees)}</td>
            </tr>
            <tr className="text-base font-bold">
              <td className="py-3">Amount received ({PAYMENT_MODE_LABELS[payment.mode]})</td>
              <td className="py-3 text-right tabular-nums">{formatINR(payment.amountRupees)}</td>
            </tr>
            <tr className="border-t border-slate-300">
              <td className="py-2 text-slate-600">Balance outstanding</td>
              <td className="py-2 text-right tabular-nums">{formatINR(data.balanceRupees)}</td>
            </tr>
          </tbody>
        </table>

        {payment.reference && (
          <p className="mt-3 text-sm text-slate-600">Reference: {payment.reference}</p>
        )}
        {payment.notes && <p className="text-sm text-slate-600">Note: {payment.notes}</p>}

        <footer className="mt-12 flex items-end justify-between text-xs text-slate-600">
          <p>This is a computer-generated receipt.</p>
          <p className="border-t border-slate-400 pt-1">Authorised signatory</p>
        </footer>
      </article>
    </div>
  );
}
