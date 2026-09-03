import { z } from 'zod';
import {
  CLASS_CODES,
  FEE_HEAD_SCOPES,
  INVOICE_STATUSES,
  PAYMENT_MODES,
  type ConcessionType,
  type FeeHeadScope,
  type InvoiceKind,
  type InvoiceStatus,
  type PaymentMode,
} from '../constants.js';
import { ACADEMIC_YEAR_PATTERN, DATE_KEY_PATTERN, PERIOD_PATTERN } from '../date.js';
import { paginationSchema } from './common.js';

/**
 * Money always crosses the wire as integer rupees — ₹10 lakh is the per-amount ceiling.
 * `.int()` is the load-bearing part: it rejects `1200.50` at the edge, so a fractional
 * amount can never reach the database and start compounding rounding errors.
 */
const rupees = z.number().int().min(0).max(1_000_000);

export const feeHeadSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{2,20}$/, 'Use letters, digits and underscores'),
  name: z.string().trim().min(2).max(60),
  amountRupees: rupees,
  appliesTo: z.enum(FEE_HEAD_SCOPES).default('ALL'),
});

export const upsertFeeStructureSchema = z
  .object({
    heads: z.array(feeHeadSchema).min(1, 'Add at least one fee head').max(20),
  })
  .superRefine((body, ctx) => {
    const codes = body.heads.map((h) => h.code);
    if (new Set(codes).size !== codes.length) {
      ctx.addIssue({ code: 'custom', path: ['heads'], message: 'Fee head codes must be unique' });
    }
  });

export const feeStructureParamsSchema = z.object({
  classCode: z.enum(CLASS_CODES),
  academicYear: z.string().regex(ACADEMIC_YEAR_PATTERN, 'Use the form 2026-27'),
});

export const invoiceRunSchema = z.object({
  period: z.string().regex(PERIOD_PATTERN, 'Use the form 2026-08'),
  /** Omit to include every class that has a fee structure. */
  classCodes: z.array(z.enum(CLASS_CODES)).min(1).optional(),
});

export const listInvoicesQuerySchema = paginationSchema.extend({
  status: z.enum(INVOICE_STATUSES).optional(),
  classCode: z.enum(CLASS_CODES).optional(),
  period: z.string().regex(PERIOD_PATTERN).optional(),
  studentId: z.string().trim().toUpperCase().optional(),
  /** Only invoices past their due date and not settled. */
  overdueOnly: z.coerce.boolean().optional(),
  q: z.string().trim().max(80).optional(),
});

export const recordPaymentSchema = z.object({
  amountRupees: rupees.refine((value) => value > 0, 'Enter an amount'),
  mode: z.enum(PAYMENT_MODES),
  reference: z.string().trim().max(60).default(''),
  paidAt: z.string().regex(DATE_KEY_PATTERN, 'Enter a valid date'),
  notes: z.string().trim().max(200).default(''),
});

/**
 * Line-item code for a balance carried forward from before the school started using this
 * system. A distinct code means these can be told apart from real monthly charges in any
 * report — "how much of our outstanding is legacy debt?" is a question worth answering.
 */
export const OPENING_BALANCE_CODE = 'OPENING_BALANCE';

/** Line-item code for any charge absorbed from a student's record. */
export const STUDENT_CHARGE_CODE = 'CHARGE';

export const reversePaymentSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason — this stays on the record').max(200),
});

export const voidInvoiceSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason — this stays on the record').max(200),
});

export const collectionReportQuerySchema = z.object({
  from: z.string().regex(DATE_KEY_PATTERN),
  to: z.string().regex(DATE_KEY_PATTERN),
  /** Declared so validation does not strip it before the route can act on it. */
  format: z.enum(['json', 'csv']).optional(),
});

export const duesReportQuerySchema = z.object({
  classCode: z.enum(CLASS_CODES).optional(),
  period: z.string().regex(PERIOD_PATTERN).optional(),
  format: z.enum(['json', 'csv']).optional(),
});

export type FeeHead = z.output<typeof feeHeadSchema>;
export type UpsertFeeStructurePayload = z.output<typeof upsertFeeStructureSchema>;
export type InvoiceRunPayload = z.output<typeof invoiceRunSchema>;
export type ListInvoicesQuery = z.output<typeof listInvoicesQuerySchema>;
export type RecordPaymentPayload = z.output<typeof recordPaymentSchema>;

export interface FeeStructureDto {
  id: string;
  classCode: string;
  academicYear: string;
  heads: FeeHead[];
  monthlyTotalRupees: number;
  updatedAt: string;
}

export interface InvoiceLineItem {
  code: string;
  name: string;
  amountRupees: number;
  /**
   * Set when this line came from a charge on the student's record.
   *
   * It is what makes double-billing a charge impossible: a charge counts as billed
   * precisely when some non-void invoice carries its id, so there is no separate flag to
   * fall out of step with reality.
   */
  chargeId?: string;
}

export interface PaymentDto {
  receiptNo: string;
  amountRupees: number;
  mode: PaymentMode;
  reference: string;
  paidAt: string;
  collectedBy: string;
  notes: string;
  isReversed: boolean;
  reversalReason: string;
}

export interface InvoiceDto {
  id: string;
  studentId: string;
  studentName: string;
  classCode: string;
  familyId: string;
  academicYear: string;
  period: string;
  kind: InvoiceKind;
  lineItems: InvoiceLineItem[];
  grossRupees: number;
  concessionRupees: number;
  totalRupees: number;
  paidRupees: number;
  balanceRupees: number;
  status: InvoiceStatus;
  dueDate: string;
  isOverdue: boolean;
  payments: PaymentDto[];
  voidReason: string;
  createdAt: string;
}

/**
 * Result of paying a student's outstanding invoices in one go (oldest due date first),
 * rather than one specific invoice. Each invoice actually touched keeps its own payment
 * and its own receipt number — this never merges invoices, it only allocates one amount
 * across however many of them the payment reaches.
 */
export interface RecordStudentPaymentResult {
  totalAppliedRupees: number;
  invoices: InvoiceDto[];
}

export interface FamilyChildBalanceDto {
  studentId: string;
  fullName: string;
  classCode: string;
  outstandingRupees: number;
  /** Non-void invoices for this child — matches how "Total outstanding" counts invoices. */
  invoiceCount: number;
}

/** A family's total outstanding and its per-child split, for the Fees tab's family card. */
export interface FamilyBalanceDto {
  familyId: string;
  totalOutstandingRupees: number;
  children: FamilyChildBalanceDto[];
}

/** One earlier unpaid bill, listed on a fee slip so the parent can see what it is. */
export interface FeeSlipDueLine {
  invoiceId: string;
  period: string;
  label: string;
  dueDate: string;
  balanceRupees: number;
}

/**
 * A fee slip: what to pay, as opposed to a receipt, which proves what was paid.
 *
 * The invoice itself only ever charges its own month. Anything owed from earlier is
 * *shown* alongside it, never re-charged — those amounts are still billed on their own
 * invoices, and adding them here as line items would count the same money twice.
 */
export interface FeeSlipDto {
  invoice: InvoiceDto;
  previousDues: FeeSlipDueLine[];
  previousDuesRupees: number;
  thisInvoiceBalanceRupees: number;
  /** What clears this invoice and everything older in one payment. */
  totalPayableRupees: number;
}

export interface InvoiceRunPreviewRow {
  studentId: string;
  fullName: string;
  classCode: string;
  lineItems: InvoiceLineItem[];
  grossRupees: number;
  concessionRupees: number;
  totalRupees: number;
  concessionLabel: string;
  /** True when this student's own fare was billed rather than a class amount. */
  transportOverridden: boolean;
  /**
   * A fare is on record but transport is switched off for this student, so it is not
   * billed. Surfaced rather than silently ignored — usually a leftover after the service
   * was cancelled.
   */
  transportFareIgnored: boolean;
  /**
   * The student uses transport but no amount exists — no fare of their own, and no
   * transport head on their class. This is the one case that cannot be billed, and it
   * needs fixing rather than reporting.
   */
  transportUnpriced: boolean;
  /** Charges from the student's record that this invoice will absorb. */
  chargeCount: number;
  chargeRupees: number;
  /** Already invoiced for this period — the commit will skip it. */
  alreadyInvoiced: boolean;
}

export interface InvoiceRunPreview {
  period: string;
  academicYear: string;
  dueDate: string;
  rows: InvoiceRunPreviewRow[];
  /** Classes with students but no fee structure — nothing can be billed for them. */
  classesWithoutStructure: string[];
  totals: { students: number; toCreate: number; alreadyInvoiced: number; totalRupees: number };
}

export interface InvoiceRunResult {
  period: string;
  created: number;
  skipped: number;
  totalRupees: number;
}

/**
 * Concession applied to a gross amount.
 *
 * A percentage rounds to the nearest rupee, so a half-rupee remainder goes the student's
 * way (10% of ₹1,255 is ₹126, not ₹125.50). A flat concession can never exceed the amount
 * owed, which is what stops a stale ₹2,000 waiver from turning a ₹1,200 invoice negative.
 */
export function concessionFor(
  grossRupees: number,
  concession: { type: ConcessionType; value: number },
): number {
  if (concession.type === 'PERCENT') {
    return Math.min(grossRupees, Math.round((grossRupees * concession.value) / 100));
  }
  if (concession.type === 'FLAT') return Math.min(grossRupees, concession.value);
  return 0;
}

export function describeConcession(concession: { type: ConcessionType; value: number }): string {
  if (concession.type === 'PERCENT') return `${concession.value}%`;
  if (concession.type === 'FLAT') return `flat ₹${concession.value}`;
  return '—';
}

/** Which fee heads apply to a given student. */
export function headApplies(scope: FeeHeadScope, student: { transportOpted: boolean }): boolean {
  return scope === 'ALL' || (scope === 'TRANSPORT_OPTED' && student.transportOpted);
}

export function isTransportHead(head: { appliesTo: FeeHeadScope }): boolean {
  return head.appliesTo === 'TRANSPORT_OPTED';
}

/**
 * Code and label for a transport line billed from a student's own fare when their class
 * structure has no transport head of its own.
 */
export const TRANSPORT_HEAD_CODE = 'TRANSPORT';
export const TRANSPORT_HEAD_NAME = 'Transport fee';

export interface BuiltLineItems {
  lineItems: InvoiceLineItem[];
  /** The student's own fare was billed rather than a class amount. */
  transportOverridden: boolean;
  /**
   * The student uses transport but no amount exists anywhere — no fare of their own and
   * no transport head on their class. Nothing can be billed until one is set.
   */
  transportUnpriced: boolean;
}

export interface BillableStudentForLines {
  transportOpted: boolean;
  transportFareOverrideRupees: number | null;
}

/**
 * Builds a student's invoice lines from their class's fee heads.
 *
 * Transport is the interesting part. The student's own record decides *whether* they are
 * charged for it (`transportOpted`) and, when a fare is set, *how much* — because fares
 * vary by distance and stop. The class fee structure only supplies the default amount.
 *
 * So a transport head in the class structure is **not** a prerequisite for billing
 * transport. If a student opted in and carries their own fare, that fare is billed even
 * when their class has no transport head at all. Requiring the head first meant a student
 * who had clearly signed up for the bus was silently not charged for it.
 *
 * The one case that genuinely cannot be billed is a student who opted in with no fare of
 * their own *and* no class default — there is no amount to charge. That is reported as
 * `transportUnpriced` rather than passed over in silence.
 *
 * A class with more than one transport head collapses into a single overridden line —
 * splitting one fare across several heads would be a guess. One transport head is the
 * normal case.
 */
export function buildLineItems(
  heads: FeeHead[],
  student: BillableStudentForLines,
): BuiltLineItems {
  const applicable = heads.filter((head) => headApplies(head.appliesTo, student));
  // `?? null` guards documents written before this field existed, which read back as
  // undefined. Without it `undefined !== null` is true, the override branch is taken,
  // and the invoice bills an amount of undefined — a NaN total.
  const fare = student.transportFareOverrideRupees ?? null;
  const hasTransportHead = applicable.some(isTransportHead);

  const plain = (head: FeeHead): InvoiceLineItem => ({
    code: head.code,
    name: head.name,
    amountRupees: head.amountRupees,
  });

  // Opted in, own fare, but the class structure says nothing about transport. Bill the
  // fare: the student's record is the authority on whether they use the service.
  if (student.transportOpted && fare !== null && !hasTransportHead) {
    // Only synthesise when the code is free. A class that already charges everyone under
    // this code is describing something else, and duplicating it would double-bill.
    const codeTaken = applicable.some((head) => head.code === TRANSPORT_HEAD_CODE);
    if (!codeTaken) {
      return {
        lineItems: [
          ...applicable.map(plain),
          { code: TRANSPORT_HEAD_CODE, name: TRANSPORT_HEAD_NAME, amountRupees: fare },
        ],
        transportOverridden: true,
        transportUnpriced: false,
      };
    }
  }

  const useOverride = fare !== null && hasTransportHead;

  let transportEmitted = false;
  const lineItems = applicable.flatMap<InvoiceLineItem>((head) => {
    if (!isTransportHead(head) || !useOverride) return [plain(head)];
    if (transportEmitted) return [];
    transportEmitted = true;
    return [{ code: head.code, name: head.name, amountRupees: fare }];
  });

  return {
    lineItems,
    transportOverridden: useOverride,
    // Nothing to charge: they use the bus, but neither they nor their class names a price.
    transportUnpriced: student.transportOpted && fare === null && !hasTransportHead,
  };
}

/** Aging bucket for an unpaid invoice, measured from its due date. */
export function agingBucket(dueDate: string, today: string): '0-30' | '31-60' | '60+' | 'not-due' {
  if (dueDate >= today) return 'not-due';
  const days = Math.floor(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000,
  );
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  return '60+';
}
