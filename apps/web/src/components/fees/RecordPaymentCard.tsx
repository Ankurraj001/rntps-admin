import {
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  formatINR,
  toDateKey,
  type PaymentMode,
  type RecordPaymentPayload,
} from '@rntps/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ErrorBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Field';

/**
 * Shared by the single-invoice payment flow (InvoiceDetailPage) and the consolidated,
 * pay-everything-a-student-owes flow (StudentFeesTab) — one form, one fix.
 *
 * The amount field is prefilled from `balanceRupees` at mount for the common case (pay in
 * full), but is cleared rather than re-prefilled after a successful submit. Re-prefilling
 * from a prop that only updates once the parent's query refetches is exactly what let a
 * stale, already-paid balance keep failing the "more than the outstanding balance" check —
 * clearing the field instead means there is never a stale number sitting in the box.
 */
export function RecordPaymentCard({
  title = 'Record payment',
  description,
  balanceRupees,
  onSubmit,
  onDone,
}: {
  title?: string;
  description?: string;
  balanceRupees: number;
  onSubmit: (payload: RecordPaymentPayload) => Promise<unknown>;
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
    mutationFn: () => onSubmit({ amountRupees, mode, reference, paidAt, notes }),
    onSuccess: () => {
      setRupees('');
      setReference('');
      setNotes('');
      onDone();
    },
  });

  return (
    <Card>
      <CardHeader title={title} description={description ?? `Outstanding ${formatINR(balanceRupees)}`} />
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
