import { classLabel, formatINR } from '@rntps/shared';
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
 * The bill handed to a parent, as distinct from the receipt that proves they paid.
 *
 * It shows this month's charges and, above them, whatever is still owed from before, so
 * the slip ends in one figure that clears everything. The earlier amounts are only
 * displayed here — each is still billed on its own invoice, so nothing is charged twice.
 */
export function FeeSlipPage() {
  const { invoiceId = '' } = useParams<{ invoiceId: string }>();

  const slip = useQuery({ queryKey: feeKeys.slip(invoiceId), queryFn: () => feesApi.slip(invoiceId) });
  const settings = useQuery({ queryKey: settingsKeys.all, queryFn: settingsApi.get });

  // Becomes the default PDF filename when printed to file.
  useEffect(() => {
    const previous = document.title;
    document.title = `Fee slip ${invoiceId}`;
    return () => {
      document.title = previous;
    };
  }, [invoiceId]);

  if (slip.isPending || settings.isPending || !settings.data) return <LoadingBlock />;
  if (slip.error)
    return (
      <div className="p-6">
        <ErrorBlock message={(slip.error as Error).message} />
      </div>
    );

  const school = settings.data;
  const { invoice, previousDues, previousDuesRupees, thisInvoiceBalanceRupees, totalPayableRupees } =
    slip.data;

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
          <h1 className="text-xl font-bold uppercase tracking-wide text-slate-900">
            {school.schoolName}
          </h1>
          {school.schoolAddress && <p className="text-sm text-slate-600">{school.schoolAddress}</p>}
          {school.schoolPhone && <p className="text-sm text-slate-600">Phone: {school.schoolPhone}</p>}
          <p className="mt-3 inline-block border border-slate-400 px-3 py-1 text-sm font-semibold uppercase">
            Fee Slip
          </p>
        </header>

        {invoice.status === 'VOID' && (
          <p className="mt-4 border-2 border-red-600 p-2 text-center text-sm font-bold uppercase text-red-700">
            Cancelled — {invoice.voidReason}
          </p>
        )}

        <dl className="mt-6 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-slate-600">Student</dt>
          <dd className="text-right font-semibold">{invoice.studentName}</dd>

          <dt className="text-slate-600">Student ID</dt>
          <dd className="text-right font-mono">{invoice.studentId}</dd>

          <dt className="text-slate-600">Class</dt>
          <dd className="text-right">{classLabel(invoice.classCode)}</dd>

          <dt className="text-slate-600">Fee month</dt>
          <dd className="text-right">{invoice.period}</dd>

          <dt className="text-slate-600">Due date</dt>
          <dd className="text-right">{formatDate(invoice.dueDate)}</dd>
        </dl>

        <table className="mt-6 w-full border-collapse text-sm">
          <tbody>
            {previousDues.length > 0 && (
              <>
                <tr className="border-y border-slate-400 text-left">
                  <th scope="col" colSpan={2} className="py-2 text-left font-semibold">
                    Brought forward
                  </th>
                </tr>
                {previousDues.map((line) => (
                  <tr key={line.invoiceId} className="border-b border-slate-200">
                    <td className="py-2">
                      {line.label}
                      <span className="ml-2 text-xs text-slate-500">{line.period}</span>
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatINR(line.balanceRupees)}</td>
                  </tr>
                ))}
                <tr className="border-b border-slate-400 font-semibold">
                  <td className="py-2">Previous dues</td>
                  <td className="py-2 text-right tabular-nums">{formatINR(previousDuesRupees)}</td>
                </tr>
              </>
            )}

            <tr className="border-y border-slate-400 text-left">
              <th scope="col" colSpan={2} className="py-2 text-left font-semibold">
                {invoice.period} charges
              </th>
            </tr>
            {invoice.lineItems.map((item) => (
              <tr key={item.code} className="border-b border-slate-200">
                <td className="py-2">{item.name}</td>
                <td className="py-2 text-right tabular-nums">{formatINR(item.amountRupees)}</td>
              </tr>
            ))}
            {invoice.concessionRupees > 0 && (
              <tr className="border-b border-slate-200">
                <td className="py-2">Less: concession</td>
                <td className="py-2 text-right tabular-nums">
                  −{formatINR(invoice.concessionRupees)}
                </td>
              </tr>
            )}
            <tr className="border-b border-slate-200 font-semibold">
              <td className="py-2">This month</td>
              <td className="py-2 text-right tabular-nums">{formatINR(invoice.totalRupees)}</td>
            </tr>
            {invoice.paidRupees > 0 && (
              <tr className="border-b border-slate-200">
                <td className="py-2">Less: already paid</td>
                <td className="py-2 text-right tabular-nums">−{formatINR(invoice.paidRupees)}</td>
              </tr>
            )}
            {invoice.paidRupees > 0 && (
              <tr className="border-b border-slate-400">
                <td className="py-2">Balance this month</td>
                <td className="py-2 text-right tabular-nums">
                  {formatINR(thisInvoiceBalanceRupees)}
                </td>
              </tr>
            )}

            <tr className="border-b-4 border-double border-slate-800 text-base font-bold">
              <td className="py-3">Total payable</td>
              <td className="py-3 text-right tabular-nums">{formatINR(totalPayableRupees)}</td>
            </tr>
          </tbody>
        </table>

        {previousDues.length > 0 && (
          <p className="mt-3 text-xs text-slate-500">
            Previous dues are billed on their own slips and are shown here for convenience, not
            charged again.
          </p>
        )}

        <footer className="mt-12 flex items-end justify-between text-xs text-slate-600">
          <p>This is a computer-generated fee slip.</p>
          <p className="border-t border-slate-400 pt-1">Authorised signatory</p>
        </footer>
      </article>
    </div>
  );
}
