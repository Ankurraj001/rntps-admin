import { CLASS_CODES, classLabel, formatINR, toDateKey } from '@rntps/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Info, Check, FileText } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { feeKeys, feesApi } from '@/api/fees';
import { PageHeader } from '@/components/layout/AppShell';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ErrorBlock, Spinner } from '@/components/ui/Feedback';
import { Input } from '@/components/ui/Field';
import { formatDate } from '@/lib/utils';

/**
 * Two explicit steps. Generating invoices writes one document per student, and a wrong
 * month or fee amount is expensive to unpick, so the preview is not skippable.
 */
export function InvoiceRunPage() {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState(toDateKey().slice(0, 7));
  const [classCodes, setClassCodes] = useState<string[]>([]);

  const preview = useMutation({ mutationFn: () => feesApi.previewRun(period, classCodes) });
  const commit = useMutation({
    mutationFn: () => feesApi.commitRun(period, classCodes),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: feeKeys.all });
      preview.reset();
    },
  });

  function toggleClass(code: string) {
    setClassCodes((current) =>
      current.includes(code) ? current.filter((c) => c !== code) : [...current, code],
    );
    preview.reset();
  }

  const data = preview.data;

  return (
    <>
      <PageHeader title="Generate invoices" description="Preview first, then commit. Re-running a month is safe — it cannot double-bill." />

      <div className="space-y-4 p-6">
        {preview.error && <ErrorBlock message={(preview.error as Error).message} />}
        {commit.error && <ErrorBlock message={(commit.error as Error).message} />}

        {commit.data && (
          <Card className="border-emerald-300 bg-emerald-50">
            <CardBody className="flex flex-wrap items-center gap-3">
              <Check className="h-5 w-5 text-emerald-700" aria-hidden />
              <p className="text-sm text-emerald-900">
                Created <strong>{commit.data.created}</strong> invoice
                {commit.data.created === 1 ? '' : 's'} for {commit.data.period} totalling{' '}
                <strong>{formatINR(commit.data.totalRupees)}</strong>
                {commit.data.skipped > 0 && `, skipped ${commit.data.skipped} already invoiced`}.
              </p>
              <Link to={`/fees/invoices?period=${commit.data.period}`} className="ml-auto">
                <Button variant="secondary" size="sm">View invoices</Button>
              </Link>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="Step 1 — choose what to bill" />
          <CardBody className="space-y-4">
            <label className="block max-w-xs text-sm">
              <span className="mb-1.5 block font-medium text-slate-700">Month</span>
              <Input
                type="month"
                value={period}
                onChange={(e) => {
                  setPeriod(e.target.value);
                  preview.reset();
                }}
              />
            </label>

            <div>
              <p className="mb-2 text-sm font-medium text-slate-700">
                Classes <span className="font-normal text-slate-500">(none selected = every class)</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {CLASS_CODES.map((code) => (
                  <label
                    key={code}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm hover:bg-slate-50"
                  >
                    <input type="checkbox" checked={classCodes.includes(code)} onChange={() => toggleClass(code)} />
                    {classLabel(code)}
                  </label>
                ))}
              </div>
            </div>

            <Button onClick={() => preview.mutate()} disabled={preview.isPending || !period}>
              {preview.isPending && <Spinner />}
              <FileText className="h-4 w-4" aria-hidden />
              Preview
            </Button>
          </CardBody>
        </Card>

        {data && (
          <Card>
            <CardHeader
              title="Step 2 — review and commit"
              description={`Due ${formatDate(data.dueDate)} · academic year ${data.academicYear}`}
              action={
                <Button
                  onClick={() => commit.mutate()}
                  disabled={commit.isPending || data.totals.toCreate === 0}
                >
                  {commit.isPending && <Spinner />}
                  Create {data.totals.toCreate} invoice{data.totals.toCreate === 1 ? '' : 's'}
                </Button>
              }
            />

            <CardBody className="space-y-4">
              <div className="flex flex-wrap gap-6 text-sm">
                <span>Students: <strong>{data.totals.students}</strong></span>
                <span>To create: <strong className="text-brand-700">{data.totals.toCreate}</strong></span>
                <span>Already invoiced: <strong>{data.totals.alreadyInvoiced}</strong></span>
                <span>Total: <strong>{formatINR(data.totals.totalRupees)}</strong></span>
              </div>

              {data.rows.some((row) => row.chargeCount > 0) && (
                <div className="flex items-start gap-2 rounded-md bg-slate-50 p-3 text-sm text-slate-700">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    This run will absorb{' '}
                    <strong>
                      {formatINR(data.rows.reduce((sum, row) => sum + row.chargeRupees, 0))}
                    </strong>{' '}
                    of pending charges from{' '}
                    {data.rows.filter((row) => row.chargeCount > 0).length} student(s) into their
                    invoices. Each charge is billed once and never again.
                  </span>
                </div>
              )}

              {data.rows.some((row) => row.transportUnpriced) && (
                <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    {data.rows.filter((row) => row.transportUnpriced).length} student(s) use transport
                    but have no fare — nothing will be billed for it. Set a fare on the student, or add
                    a transport fee to their{' '}
                    <Link to="/fees/structures" className="underline">class fee structure</Link>.
                  </span>
                </div>
              )}

              {data.rows.some((row) => row.transportFareIgnored) && (
                <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    {data.rows.filter((row) => row.transportFareIgnored).length} student(s) have a
                    transport fare on record but are not marked as using transport, so it is not
                    billed.
                  </span>
                </div>
              )}

              {data.classesWithoutStructure.length > 0 && (
                <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    No fee structure for{' '}
                    <strong>{data.classesWithoutStructure.map((c) => classLabel(c)).join(', ')}</strong>. Those
                    students will not be billed —{' '}
                    <Link to="/fees/structures" className="underline">set their fees first</Link>.
                  </span>
                </div>
              )}

              {data.rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-500">
                  Nothing to bill. Check that classes have a fee structure and active students.
                </p>
              ) : (
                <div className="max-h-96 overflow-auto rounded-md border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th scope="col" className="px-4 py-2 font-medium">Student</th>
                        <th scope="col" className="px-4 py-2 font-medium">Class</th>
                        <th scope="col" className="px-4 py-2 font-medium">Heads</th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">Gross</th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">Concession</th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.rows.map((row) => (
                        <tr key={row.studentId} className={row.alreadyInvoiced ? 'bg-slate-50 text-slate-400' : ''}>
                          <td className="px-4 py-2">
                            {row.fullName}
                            {row.alreadyInvoiced && <Badge tone="slate">already billed</Badge>}
                          </td>
                          <td className="px-4 py-2">{classLabel(row.classCode)}</td>
                          <td className="px-4 py-2 text-xs">
                            {row.lineItems.map((i) => i.name).join(' + ') || '—'}
                            {row.transportOverridden && (
                              <Badge tone="blue">own fare</Badge>
                            )}
                            {row.chargeCount > 0 && (
                              <Badge tone="amber">
                                +{row.chargeCount} charge{row.chargeCount === 1 ? '' : 's'}{' '}
                                {formatINR(row.chargeRupees)}
                              </Badge>
                            )}
                            {row.transportUnpriced && (
                              <span
                                className="ml-1 text-amber-700"
                                title="Uses transport, but no fare is set on the student or the class"
                              >
                                transport unpriced
                              </span>
                            )}
                            {row.transportFareIgnored && (
                              <span
                                className="ml-1 text-amber-700"
                                title="A fare is on record but transport is switched off for this student"
                              >
                                fare not billed
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatINR(row.grossRupees)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {row.concessionRupees > 0 ? (
                              <span title={row.concessionLabel}>−{formatINR(row.concessionRupees)}</span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-4 py-2 text-right font-medium tabular-nums">
                            {formatINR(row.totalRupees)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
