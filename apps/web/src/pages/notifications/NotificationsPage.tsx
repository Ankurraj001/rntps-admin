import { CLASS_CODES, classLabel, formatINR, periodLabel, toDateKey } from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ExternalLink, MessageSquare, SkipForward, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { notificationKeys, notificationsApi, type BatchSummary } from '@/api/notifications';
import { PageHeader } from '@/components/layout/AppShell';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ErrorBlock, LoadingBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { cn, displayPhone } from '@/lib/utils';

/**
 * How a batch's class filter reads back.
 *
 * An empty `classCodes` is not "no classes" but every class — the filter form treats
 * nothing ticked as all — so it has to be spelled out rather than left blank, otherwise a
 * whole-school run and a two-class run look identical in the history.
 */
function classFilterLabel(classCodes: string[] | undefined): string {
  if (!classCodes?.length) return 'All classes';
  return classCodes.map(classLabel).join(', ');
}

/** Every class named is eleven labels wide, so the badge shows a few and counts the rest. */
const MAX_BADGE_CLASSES = 3;

function classFilterBadgeLabel(classCodes: string[] | undefined): string {
  if (!classCodes?.length) return 'All classes';
  if (classCodes.length <= MAX_BADGE_CLASSES) return classFilterLabel(classCodes);
  const shown = classCodes.slice(0, MAX_BADGE_CLASSES).map(classLabel).join(', ');
  return `${shown} +${classCodes.length - MAX_BADGE_CLASSES}`;
}

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const [batchId, setBatchId] = useState<string | null>(null);

  const currentMonth = toDateKey().slice(0, 7);
  const [period, setPeriod] = useState(currentMonth);
  const [classCodes, setClassCodes] = useState<string[]>([]);
  const [minDueRupees, setMinDueRupees] = useState('1');
  const [overdueOnly, setOverdueOnly] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<BatchSummary | null>(null);

  /**
   * The history is filtered by the month a batch was *built* in, defaulting to this one:
   * a month-end run is a dozen-odd batches, and every previous month's stay behind the
   * filter rather than stacking up under the ones that still need working through.
   */
  const [historyMonth, setHistoryMonth] = useState(currentMonth);

  const history = useQuery({
    queryKey: notificationKeys.list(historyMonth),
    queryFn: () => notificationsApi.list(historyMonth || undefined),
  });

  const remove = useMutation({
    mutationFn: (id: string) => notificationsApi.remove(id),
    onSuccess: async () => {
      setPendingDelete(null);
      await queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });

  const create = useMutation({
    mutationFn: () =>
      notificationsApi.create({
        period: period || undefined,
        classCodes: classCodes.length ? classCodes : undefined,
        minDueRupees: Math.trunc(Number(minDueRupees || 0)),
        overdueOnly,
      }),
    onSuccess: async (batch) => {
      setBatchId(batch.id);
      // A batch built now lands in this month, so a history left on an older month would
      // send the admin back to a list the batch they just made is not in.
      setHistoryMonth(currentMonth);
      await queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });

  if (batchId) return <QueueView batchId={batchId} onClose={() => setBatchId(null)} />;

  return (
    <>
      <PageHeader
        title="Fee reminders"
        description="Builds one WhatsApp message per parent, covering all their children."
      />

      <div className="space-y-4 p-4 sm:p-6">
        <Card className="border-amber-300 bg-amber-50">
          <CardBody className="flex items-start gap-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">Each message needs one click to send.</p>
              <p className="mt-1">
                WhatsApp click-to-chat links can only pre-fill text — they cannot attach a PDF and
                cannot send automatically. The app opens each chat with the message ready; you press
                send. Progress is saved, so you can stop and resume.
              </p>
            </div>
          </CardBody>
        </Card>

        {create.error && <ErrorBlock message={(create.error as Error).message} />}

        <Card>
          <CardHeader title="Who to chase" />
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Fee month" hint="Leave blank for all unpaid months">
                <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
              </Field>
              <Field label="Minimum due (₹)" hint="Skip trivial balances">
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={minDueRupees}
                  onChange={(e) => setMinDueRupees(e.target.value)}
                />
              </Field>
              <Field label="Only overdue">
                <label className="flex h-10 items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={overdueOnly}
                    onChange={(e) => setOverdueOnly(e.target.checked)}
                  />
                  Past the due date
                </label>
              </Field>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-slate-700">
                Classes <span className="font-normal text-slate-500">(none = all)</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {CLASS_CODES.map((code) => (
                  <label
                    key={code}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={classCodes.includes(code)}
                      onChange={() =>
                        setClassCodes((current) =>
                          current.includes(code) ? current.filter((c) => c !== code) : [...current, code],
                        )
                      }
                    />
                    {classLabel(code)}
                  </label>
                ))}
              </div>
            </div>

            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending && <Spinner />}
              <MessageSquare className="h-4 w-4" aria-hidden />
              Build reminder list
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Previous batches"
            description={
              historyMonth ? `Built in ${periodLabel(historyMonth)}` : 'Every month, most recent first'
            }
            action={
              // Labelled by the header rather than a Field, which would stack a second
              // heading on top of one. Blank is a real choice here, so it is spelled out.
              <div className="flex items-center gap-2">
                <Input
                  type="month"
                  className="w-40"
                  aria-label="Month the batch was built in"
                  value={historyMonth}
                  onChange={(e) => setHistoryMonth(e.target.value)}
                />
                {historyMonth && (
                  <Button variant="ghost" size="sm" onClick={() => setHistoryMonth('')}>
                    All
                  </Button>
                )}
              </div>
            }
          />
          {history.isPending && <LoadingBlock />}
          {history.error && (
            <CardBody>
              <ErrorBlock message={(history.error as Error).message} />
            </CardBody>
          )}
          {history.data && history.data.items.length === 0 && (
            <CardBody>
              <p className="py-4 text-center text-sm text-slate-500">
                {historyMonth
                  ? `No reminder batches built in ${periodLabel(historyMonth)}.`
                  : 'No reminder batches yet.'}
              </p>
            </CardBody>
          )}
          {history.data && history.data.items.length > 0 && (
            <CardBody className="divide-y divide-slate-100">
              {/* The row is a flex container rather than one big button, because a delete
                  control nested inside a button is invalid markup and the inner click would
                  open the batch it was meant to remove. */}
              {history.data.items.map((batch) => (
                <div key={batch.id} className="flex items-center gap-2 py-3 first:pt-0 last:pb-0">
                  <button
                    type="button"
                    onClick={() => setBatchId(batch.id)}
                    className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-left text-sm hover:text-brand-700"
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{batch.filter.period ?? 'All unpaid months'}</span>
                      <span className="ml-2 text-slate-500">
                        {new Date(batch.createdAt).toLocaleString('en-IN')}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      {/* Full list on hover, since the badge only names the first few. */}
                      <span title={classFilterLabel(batch.filter.classCodes)}>
                        <Badge tone={batch.filter.classCodes?.length ? 'blue' : 'slate'}>
                          {classFilterBadgeLabel(batch.filter.classCodes)}
                        </Badge>
                      </span>
                      <span className="text-slate-600">
                        {batch.sentCount}/{batch.totalCount} sent
                        {batch.skippedCount > 0 && ` · ${batch.skippedCount} skipped`}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 disabled:opacity-50"
                    aria-label={`Delete batch from ${new Date(batch.createdAt).toLocaleString('en-IN')}`}
                    title="Delete batch"
                    disabled={remove.isPending}
                    onClick={() => setPendingDelete(batch)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              ))}
            </CardBody>
          )}
        </Card>
      </div>

      {/* Confirmed rather than deleted on the spot: the delete sits one row-width from the
          control that opens the batch, and what it destroys — which parents have already
          been chased — cannot be rebuilt by running the filter again. */}
      {pendingDelete && (
        <Modal
          open
          onClose={() => setPendingDelete(null)}
          title="Delete this reminder batch?"
          description={`${pendingDelete.filter.period ?? 'All unpaid months'} · ${classFilterLabel(pendingDelete.filter.classCodes)}`}
        >
          <div className="space-y-3 px-5 py-4 text-sm text-slate-600">
            <p>
              Built {new Date(pendingDelete.createdAt).toLocaleString('en-IN')} ·{' '}
              {pendingDelete.sentCount}/{pendingDelete.totalCount} marked sent
              {pendingDelete.skippedCount > 0 && ` · ${pendingDelete.skippedCount} skipped`}.
            </p>
            <p>
              The queue and its progress go for good. Invoices, payments and student records are
              untouched — you can build a fresh batch from the same filters, but it will not
              remember who was already messaged.
            </p>
            {remove.error && <ErrorBlock message={(remove.error as Error).message} />}
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setPendingDelete(null)}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate(pendingDelete.id)}
            >
              {remove.isPending && <Spinner />}
              Delete batch
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function QueueView({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const batch = useQuery({
    queryKey: notificationKeys.batch(batchId),
    queryFn: () => notificationsApi.get(batchId),
  });

  const update = useMutation({
    mutationFn: ({ key, status }: { key: string; status: 'OPENED' | 'SENT' | 'SKIPPED' }) =>
      notificationsApi.setItemStatus(batchId, key, status),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: notificationKeys.batch(batchId) });
      await queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });

  if (batch.isPending) return <LoadingBlock />;
  if (batch.error) return <div className="p-4 sm:p-6"><ErrorBlock message={(batch.error as Error).message} /></div>;

  const data = batch.data;
  const done = data.sentCount + data.skippedCount;
  const nextIndex = data.items.findIndex((item) => item.status === 'PENDING' || item.status === 'OPENED');

  /**
   * Opened inside the click handler so the browser treats it as a user gesture — a
   * window.open from anywhere else gets blocked as a popup.
   */
  function openWhatsApp(key: string, waLink: string) {
    window.open(waLink, '_blank', 'noopener,noreferrer');
    update.mutate({ key, status: 'OPENED' });
  }

  return (
    <>
      <PageHeader
        title="Send reminders"
        description={`${done} of ${data.totalCount} handled · ${data.filter.period ?? 'all unpaid months'} · ${classFilterLabel(data.filter.classCodes)}`}
        action={
          <Button variant="secondary" onClick={onClose}>
            Back to filters
          </Button>
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        <div className="h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={done} aria-valuemax={data.totalCount}>
          <div
            className="h-full rounded-full bg-brand-600 transition-all"
            style={{ width: `${data.totalCount ? (done / data.totalCount) * 100 : 0}%` }}
          />
        </div>

        {update.error && <ErrorBlock message={(update.error as Error).message} />}

        {done === data.totalCount && (
          <Card className="border-emerald-300 bg-emerald-50">
            <CardBody className="flex items-center gap-3 text-sm text-emerald-900">
              <Check className="h-5 w-5" aria-hidden />
              All {data.totalCount} reminders handled.
            </CardBody>
          </Card>
        )}

        {data.unreachable.length > 0 && (
          <Card className="border-amber-300">
            <CardHeader
              title={`${data.unreachable.length} student${data.unreachable.length === 1 ? '' : 's'} could not be contacted`}
              description="No reachable WhatsApp number — fix the guardian details to include them next time."
            />
            <CardBody>
              <ul className="grid gap-1 text-sm sm:grid-cols-2">
                {data.unreachable.map((student) => (
                  <li key={student.studentId}>
                    <Link to={`/students/${student.studentId}/edit`} className="text-brand-700 hover:underline">
                      {student.fullName}
                    </Link>
                    <span className="ml-2 text-xs text-slate-500">
                      {classLabel(student.classCode)} · {student.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        <div className="space-y-3">
          {data.items.map((item, index) => {
            const isNext = index === nextIndex;
            const handled = item.status === 'SENT' || item.status === 'SKIPPED';

            return (
              <Card
                key={item.key}
                className={cn(
                  isNext && 'ring-2 ring-brand-500',
                  handled && 'opacity-60',
                )}
              >
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">
                        {item.guardianName}
                        <span className="ml-2 font-mono text-xs font-normal text-slate-500">
                          {displayPhone(item.guardianPhone)}
                        </span>
                      </p>
                      <p className="text-sm text-slate-600">
                        {item.students.map((s) => `${s.fullName} (${classLabel(s.classCode)})`).join(', ')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold tabular-nums">{formatINR(item.totalDueRupees)}</span>
                      {item.status === 'SENT' && <Badge tone="green">Sent</Badge>}
                      {item.status === 'SKIPPED' && <Badge tone="slate">Skipped</Badge>}
                      {item.status === 'OPENED' && <Badge tone="amber">Opened</Badge>}
                      {isNext && item.status === 'PENDING' && <Badge tone="blue">Next</Badge>}
                    </div>
                  </div>

                  {/* Monospace, because the fee table is aligned with spaces — the admin should see
                      the same columns the parent will. */}
                  <pre className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 font-mono text-xs text-slate-700">
                    {item.renderedMessage}
                  </pre>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant={isNext ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => openWhatsApp(item.key, item.waLink)}
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden />
                      Open WhatsApp
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ key: item.key, status: 'SENT' })}
                    >
                      <Check className="h-4 w-4" aria-hidden />
                      Mark sent
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ key: item.key, status: 'SKIPPED' })}
                    >
                      <SkipForward className="h-4 w-4" aria-hidden />
                      Skip
                    </Button>
                  </div>

                  {/* Deliberately "marked sent": wa.me gives no delivery receipt, so the
                      app cannot know the parent received anything. */}
                  {item.status === 'SENT' && item.sentAt && (
                    <p className="text-xs text-slate-500">
                      Marked sent {new Date(item.sentAt).toLocaleString('en-IN')} — WhatsApp does not
                      report delivery.
                    </p>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      </div>
    </>
  );
}
