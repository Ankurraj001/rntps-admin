import {
  CLASS_CODES,
  INVOICE_KINDS,
  INVOICE_STATUSES,
  PAYMENT_MODES,
  type ClassCode,
  type InvoiceKind,
  type InvoiceStatus,
  type PaymentMode,
} from '@rntps/shared';
import { Schema, model } from 'mongoose';

export interface PaymentSub {
  receiptNo: string;
  amountRupees: number;
  mode: PaymentMode;
  reference: string;
  /** IST calendar day the money was received, which may differ from when it was entered. */
  paidAt: string;
  collectedBy: string;
  notes: string;
  isReversed: boolean;
  reversalReason: string;
  reversedAt: Date | null;
  createdAt: Date;
}

export interface InvoiceLineItemSub {
  code: string;
  name: string;
  amountRupees: number;
  /** Present when the line came from a charge on the student's record. */
  chargeId?: string;
}

export interface InvoiceDoc {
  /**
   * `{studentId}:{period}`, e.g. "RNTPS-26-001:2026-08".
   *
   * Keying on the pair makes double-billing structurally impossible: a second run for
   * the same month fails on the primary key rather than quietly creating a duplicate.
   */
  _id: string;
  studentId: string;
  /** Snapshots, so a promotion or rename does not rewrite history. */
  studentNameSnapshot: string;
  classCodeSnapshot: ClassCode;
  familyId: string;
  academicYear: string;
  period: string;
  /** MONTHLY from the fee-structure run, ADHOC raised by hand for one student. */
  kind: InvoiceKind;
  lineItems: InvoiceLineItemSub[];
  grossRupees: number;
  concessionRupees: number;
  totalRupees: number;
  paidRupees: number;
  status: InvoiceStatus;
  dueDate: string;
  /** Embedded, so recording a payment is a single atomic document write. */
  payments: PaymentSub[];
  voidReason: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<PaymentSub>(
  {
    receiptNo: { type: String, required: true },
    amountRupees: { type: Number, required: true, min: 1, validate: Number.isInteger },
    mode: { type: String, enum: PAYMENT_MODES, required: true },
    reference: { type: String, default: '' },
    paidAt: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    collectedBy: { type: String, required: true },
    notes: { type: String, default: '' },
    // Reversal is a flag, never a delete: the receipt was handed to a parent and the
    // trail has to survive.
    isReversed: { type: Boolean, default: false },
    reversalReason: { type: String, default: '' },
    reversedAt: { type: Date, default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const lineItemSchema = new Schema<InvoiceLineItemSub>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    amountRupees: { type: Number, required: true, min: 0, validate: Number.isInteger },
    chargeId: { type: String, default: undefined },
  },
  { _id: false },
);

const invoiceSchema = new Schema<InvoiceDoc>(
  {
    _id: { type: String, required: true },
    studentId: { type: String, required: true },
    studentNameSnapshot: { type: String, required: true },
    classCodeSnapshot: { type: String, enum: CLASS_CODES, required: true },
    familyId: { type: String, required: true },
    academicYear: { type: String, required: true },
    period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    // Defaults to MONTHLY so invoices written before this field existed read correctly.
    kind: { type: String, enum: INVOICE_KINDS, default: 'MONTHLY', required: true },
    lineItems: { type: [lineItemSchema], required: true },
    grossRupees: { type: Number, required: true, min: 0 },
    concessionRupees: { type: Number, required: true, min: 0 },
    totalRupees: { type: Number, required: true, min: 0 },
    paidRupees: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: INVOICE_STATUSES, default: 'DUE', required: true },
    dueDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    payments: { type: [paymentSchema], default: [] },
    voidReason: { type: String, default: '' },
    createdBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, _id: false },
);

invoiceSchema.index({ status: 1, dueDate: 1 });
invoiceSchema.index({ period: 1, classCodeSnapshot: 1 });
invoiceSchema.index({ studentId: 1, period: -1 });
invoiceSchema.index({ familyId: 1, status: 1 });
invoiceSchema.index({ 'payments.receiptNo': 1 });
invoiceSchema.index({ 'payments.paidAt': 1 });
// The monthly run's "already invoiced?" lookup, which must not see ad-hoc charges.
invoiceSchema.index({ period: 1, kind: 1, studentId: 1 });
// Answers "which of this student's charges have already been billed?" — the query that
// makes double-billing a charge impossible.
invoiceSchema.index({ studentId: 1, 'lineItems.chargeId': 1 });

export const Invoice = model<InvoiceDoc>('Invoice', invoiceSchema);

export function invoiceId(studentId: string, period: string): string {
  return `${studentId}:${period}`;
}

