import {
  agingBucket,
  buildLineItems,
  concessionFor,
  describeConcession,
  STUDENT_CHARGE_CODE,
  formatINR,
  toDateKey,
  type ClassCode,
  type FeeSlipDto,
  type FeeStructureDto,
  type InvoiceDto,
  type InvoiceRunPreview,
  type InvoiceRunPreviewRow,
  type InvoiceRunResult,
  type ListInvoicesQuery,
  type Paginated,
  type RecordPaymentPayload,
  type UpsertFeeStructurePayload,
} from '@rntps/shared';
import { AppError } from '../../lib/AppError.js';
import { getSettings, nextReceiptNo } from '../../lib/ids.js';
import { isDuplicateKeyError } from '../../lib/mongoErrors.js';
import { FeeStructure, feeStructureId, type FeeStructureDoc } from '../../models/FeeStructure.js';
import { Invoice, invoiceId, type InvoiceDoc } from '../../models/Invoice.js';
import { Student, type StudentDoc } from '../../models/Student.js';
import { billedChargeIdsFor } from '../students/student.service.js';

// ---------------------------------------------------------------------------
// Fee structures
// ---------------------------------------------------------------------------

function structureToDto(doc: FeeStructureDoc): FeeStructureDto {
  return {
    id: doc._id,
    classCode: doc.classCode,
    academicYear: doc.academicYear,
    heads: doc.heads.map((h) => ({ ...h })),
    // Indicative only — a student without transport pays less than this.
    monthlyTotalRupees: doc.heads.reduce((sum, head) => sum + head.amountRupees, 0),
    updatedAt: doc.updatedAt?.toISOString() ?? '',
  };
}

export async function listFeeStructures(academicYear?: string): Promise<FeeStructureDto[]> {
  const settings = await getSettings();
  const year = academicYear ?? settings.activeAcademicYear;
  const docs = await FeeStructure.find({ academicYear: year }).lean<FeeStructureDoc[]>();
  return docs.map(structureToDto).sort((a, b) => a.id.localeCompare(b.id));
}

export async function upsertFeeStructure(
  classCode: ClassCode,
  academicYear: string,
  payload: UpsertFeeStructurePayload,
): Promise<FeeStructureDto> {
  const doc = await FeeStructure.findByIdAndUpdate(
    feeStructureId(classCode, academicYear),
    { $set: { classCode, academicYear, heads: payload.heads } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean<FeeStructureDoc>();

  return structureToDto(doc as FeeStructureDoc);
}

export async function getFeeStructure(
  classCode: ClassCode,
  academicYear: string,
): Promise<FeeStructureDto | null> {
  const doc = await FeeStructure.findById(feeStructureId(classCode, academicYear)).lean<FeeStructureDoc>();
  return doc ? structureToDto(doc) : null;
}

/** Copies a whole year's structures forward, so April is not a day of retyping. */
export async function cloneFeeStructures(
  fromYear: string,
  toYear: string,
): Promise<{ copied: number; skipped: number }> {
  if (fromYear === toYear) throw AppError.badRequest('Choose two different academic years');

  const source = await FeeStructure.find({ academicYear: fromYear }).lean<FeeStructureDoc[]>();
  if (source.length === 0) throw AppError.badRequest(`No fee structures found for ${fromYear}`);

  const operations = source.map((doc) => ({
    insertOne: {
      document: {
        _id: feeStructureId(doc.classCode, toYear),
        classCode: doc.classCode,
        academicYear: toYear,
        heads: doc.heads,
      },
    },
  }));

  // ordered:false so an existing target year's class is skipped rather than aborting.
  const copied = await FeeStructure.bulkWrite(operations, { ordered: false })
    .then((result) => result.insertedCount)
    .catch((error: unknown) => {
      /**
       * An unordered bulk write still inserts everything it can and reports the classes
       * that already existed as duplicate-key errors. The successful inserts are counted on
       * the error's own result, so discarding it reported "copied 0, skipped all" for a
       * clone that had in fact worked — which reads as a failure to whoever ran it.
       */
      if (isDuplicateKeyError(error)) {
        return (error as { result?: { insertedCount?: number } }).result?.insertedCount ?? 0;
      }
      throw error;
    });

  return { copied, skipped: source.length - copied };
}

// ---------------------------------------------------------------------------
// Invoice generation
// ---------------------------------------------------------------------------

/** Due date for a period, from the configured day of the month. */
function dueDateFor(period: string, dayOfMonth: number): string {
  return `${period}-${String(dayOfMonth).padStart(2, '0')}`;
}

type BillableStudent = Pick<
  StudentDoc,
  | '_id'
  | 'fullName'
  | 'classCode'
  | 'familyId'
  | 'transportOpted'
  | 'transportFareOverrideRupees'
  | 'concession'
  | 'charges'
>;

async function buildRunRows(
  period: string,
  classCodes: ClassCode[] | undefined,
): Promise<{ rows: InvoiceRunPreviewRow[]; academicYear: string; dueDate: string; classesWithoutStructure: string[] }> {
  const settings = await getSettings();
  const academicYear = settings.activeAcademicYear;
  const dueDate = dueDateFor(period, settings.feeDueDayOfMonth);

  const studentFilter: Record<string, unknown> = { status: 'ACTIVE' };
  if (classCodes?.length) studentFilter.classCode = { $in: classCodes };

  const [students, structures] = await Promise.all([
    Student.find(studentFilter)
      .select('fullName classCode familyId transportOpted transportFareOverrideRupees concession charges')
      .lean<BillableStudent[]>(),
    FeeStructure.find({ academicYear }).lean<FeeStructureDoc[]>(),
  ]);

  const structureByClass = new Map(structures.map((s) => [s.classCode, s]));

  // Charges already carried by some invoice. Anything not in here is still waiting, and
  // this run will absorb it — which is what keeps a student to one invoice per month.
  const billedCharges = await billedChargeIdsFor(students.map((s) => s._id));

  // Existing invoices for this period, so the preview can show what will be skipped.
  //
  // Excluding ad-hoc charges is essential, not a refinement. Without it a ₹50 fine raised
  // for August counts as "already invoiced", the run skips that student, and their tuition
  // is never billed at all — a silent under-charge nobody would notice until the year's
  // collection came up short.
  //
  // Written as `$ne: 'ADHOC'` rather than `kind: 'MONTHLY'` so invoices predating the
  // field, which have no `kind` at all, still count as monthly. `kind: 'MONTHLY'` would
  // not match them, and the run would offer to bill that month a second time.
  const existing = new Set(
    (
      await Invoice.find({
        period,
        kind: { $ne: 'ADHOC' },
        studentId: { $in: students.map((s) => s._id) },
      })
        .select('studentId')
        .lean<Pick<InvoiceDoc, 'studentId'>[]>()
    ).map((i) => i.studentId),
  );

  const rows: InvoiceRunPreviewRow[] = [];
  const missing = new Set<string>();

  for (const student of students) {
    const structure = structureByClass.get(student.classCode);

    // Charges waiting on this student, oldest first, in the order they were entered.
    const pendingCharges = (student.charges ?? [])
      .filter((charge) => !billedCharges.has(charge.id))
      .sort((a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime());

    if (!structure) {
      missing.add(student.classCode);
      // With no fee structure there is nothing recurring to bill. Charges are still real
      // money owed, though, so bill those rather than stranding them until someone
      // remembers to configure the class.
      if (pendingCharges.length === 0) continue;
    }

    const built = structure
      ? buildLineItems(structure.heads, student)
      : { lineItems: [], transportOverridden: false, transportUnpriced: false };
    const { transportOverridden, transportUnpriced } = built;

    const lineItems = [
      ...built.lineItems,
      ...pendingCharges.map((charge) => ({
        code: STUDENT_CHARGE_CODE,
        name: charge.name,
        amountRupees: charge.amountRupees,
        chargeId: charge.id,
      })),
    ];

    const grossRupees = lineItems.reduce((sum, item) => sum + item.amountRupees, 0);
    // A concession is a discount on the school's own fees, not on a fine or a trip a
    // family signed up for, and certainly not on arrears already net of it. So it applies
    // to the fee-structure lines only.
    const concessionBase = built.lineItems.reduce((sum, item) => sum + item.amountRupees, 0);
    const concessionRupees = concessionFor(concessionBase, student.concession);

    rows.push({
      studentId: student._id,
      fullName: student.fullName,
      classCode: student.classCode,
      lineItems,
      grossRupees,
      concessionRupees,
      totalRupees: grossRupees - concessionRupees,
      concessionLabel: describeConcession(student.concession),
      transportOverridden,
      // A fare left on a student whose transport was switched off does nothing. Say so.
      transportFareIgnored:
        (student.transportFareOverrideRupees ?? null) !== null && !student.transportOpted,
      transportUnpriced,
      chargeCount: pendingCharges.length,
      chargeRupees: pendingCharges.reduce((sum, charge) => sum + charge.amountRupees, 0),
      alreadyInvoiced: existing.has(student._id),
    });
  }

  rows.sort((a, b) => a.classCode.localeCompare(b.classCode) || a.fullName.localeCompare(b.fullName));
  return { rows, academicYear, dueDate, classesWithoutStructure: [...missing].sort() };
}

/**
 * Dry run. Always shown before a commit: this writes one document per student, and
 * getting the month or a fee amount wrong is expensive to unpick.
 */
export async function previewInvoiceRun(
  period: string,
  classCodes?: ClassCode[],
): Promise<InvoiceRunPreview> {
  const { rows, academicYear, dueDate, classesWithoutStructure } = await buildRunRows(period, classCodes);
  const pending = rows.filter((row) => !row.alreadyInvoiced);

  return {
    period,
    academicYear,
    dueDate,
    rows,
    classesWithoutStructure,
    totals: {
      students: rows.length,
      toCreate: pending.length,
      alreadyInvoiced: rows.length - pending.length,
      totalRupees: pending.reduce((sum, row) => sum + row.totalRupees, 0),
    },
  };
}

export async function commitInvoiceRun(
  period: string,
  classCodes: ClassCode[] | undefined,
  actorId: string,
): Promise<InvoiceRunResult> {
  const { rows, academicYear, dueDate } = await buildRunRows(period, classCodes);
  const pending = rows.filter((row) => !row.alreadyInvoiced);

  if (pending.length === 0) {
    return { period, created: 0, skipped: rows.length, totalRupees: 0 };
  }

  const studentsById = new Map(
    (
      await Student.find({ _id: { $in: pending.map((r) => r.studentId) } })
        .select('familyId')
        .lean<Pick<StudentDoc, '_id' | 'familyId'>[]>()
    ).map((s) => [s._id, s.familyId]),
  );

  const operations = pending.map((row) => ({
    insertOne: {
      document: {
        _id: invoiceId(row.studentId, period),
        studentId: row.studentId,
        studentNameSnapshot: row.fullName,
        classCodeSnapshot: row.classCode,
        familyId: studentsById.get(row.studentId) ?? '',
        academicYear,
        period,
        kind: 'MONTHLY' as const,
        lineItems: row.lineItems,
        grossRupees: row.grossRupees,
        concessionRupees: row.concessionRupees,
        totalRupees: row.totalRupees,
        paidRupees: 0,
        status: 'DUE' as const,
        dueDate,
        payments: [],
        createdBy: actorId,
      },
    },
  }));

  // ordered:false so a duplicate _id (a concurrent run) is skipped rather than aborting
  // the rest. The primary key is what makes this safe to retry.
  let created = 0;
  try {
    const result = await Invoice.bulkWrite(operations, { ordered: false });
    created = result.insertedCount;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const written = (error as { result?: { insertedCount?: number } }).result?.insertedCount;
    created = written ?? 0;
  }

  return {
    period,
    created,
    skipped: rows.length - created,
    totalRupees: pending.slice(0, created).reduce((sum, row) => sum + row.totalRupees, 0),
  };
}

// ---------------------------------------------------------------------------
// Invoices and payments
// ---------------------------------------------------------------------------

export function invoiceToDto(doc: InvoiceDoc, today: string = toDateKey()): InvoiceDto {
  const balanceRupees = Math.max(0, doc.totalRupees - doc.paidRupees);
  return {
    id: doc._id,
    studentId: doc.studentId,
    studentName: doc.studentNameSnapshot,
    classCode: doc.classCodeSnapshot,
    familyId: doc.familyId,
    academicYear: doc.academicYear,
    period: doc.period,
    kind: doc.kind ?? 'MONTHLY',
    lineItems: doc.lineItems.map((i) => ({ ...i })),
    grossRupees: doc.grossRupees,
    concessionRupees: doc.concessionRupees,
    totalRupees: doc.totalRupees,
    paidRupees: doc.paidRupees,
    balanceRupees,
    status: doc.status,
    dueDate: doc.dueDate,
    isOverdue: doc.status !== 'PAID' && doc.status !== 'VOID' && doc.dueDate < today,
    payments: doc.payments.map((p) => ({
      receiptNo: p.receiptNo,
      amountRupees: p.amountRupees,
      mode: p.mode,
      reference: p.reference,
      paidAt: p.paidAt,
      collectedBy: p.collectedBy,
      notes: p.notes,
      isReversed: p.isReversed,
      reversalReason: p.reversalReason,
    })),
    voidReason: doc.voidReason,
    createdAt: doc.createdAt?.toISOString() ?? '',
  };
}

export async function listInvoices(query: ListInvoicesQuery): Promise<Paginated<InvoiceDto>> {
  const today = toDateKey();
  const filter: Record<string, unknown> = {};

  if (query.status) filter.status = query.status;
  if (query.classCode) filter.classCodeSnapshot = query.classCode;
  if (query.period) filter.period = query.period;
  if (query.studentId) filter.studentId = query.studentId;
  if (query.q) {
    const pattern = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ studentNameSnapshot: pattern }, { studentId: pattern }];
  }
  if (query.overdueOnly) {
    filter.status = { $in: ['DUE', 'PARTIAL'] };
    filter.dueDate = { $lt: today };
  }

  const [items, total] = await Promise.all([
    Invoice.find(filter)
      .sort({ period: -1, classCodeSnapshot: 1, studentNameSnapshot: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<InvoiceDoc[]>(),
    Invoice.countDocuments(filter),
  ]);

  return {
    items: items.map((doc) => invoiceToDto(doc, today)),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export async function getInvoice(id: string): Promise<InvoiceDto> {
  const doc = await Invoice.findById(id).lean<InvoiceDoc>();
  if (!doc) throw AppError.notFound(`No invoice found with ID ${id}`);
  return invoiceToDto(doc);
}

/**
 * Re-derives paidRupees and status from the embedded payments, inside a single-document
 * update pipeline. Because it targets one document, MongoDB makes it atomic without a
 * transaction — which is what lets this run on standalone mongod and on Netlify.
 */
function recalculationStages() {
  return [
    {
      $set: {
        paidRupees: {
          $reduce: {
            input: '$payments',
            initialValue: 0,
            in: {
              $add: [
                '$$value',
                { $cond: [{ $eq: ['$$this.isReversed', true] }, 0, '$$this.amountRupees'] },
              ],
            },
          },
        },
      },
    },
    {
      $set: {
        status: {
          $switch: {
            branches: [
              // A voided invoice stays void regardless of payment activity.
              { case: { $eq: ['$status', 'VOID'] }, then: 'VOID' },
              { case: { $gte: ['$paidRupees', '$totalRupees'] }, then: 'PAID' },
              { case: { $gt: ['$paidRupees', 0] }, then: 'PARTIAL' },
            ],
            default: 'DUE',
          },
        },
      },
    },
  ];
}

export async function recordPayment(
  invoiceIdValue: string,
  payload: RecordPaymentPayload,
  collectedBy: string,
): Promise<InvoiceDto> {
  const existing = await Invoice.findById(invoiceIdValue).lean<InvoiceDoc>();
  if (!existing) throw AppError.notFound(`No invoice found with ID ${invoiceIdValue}`);
  if (existing.status === 'VOID') throw AppError.badRequest('This invoice has been voided');

  const balance = existing.totalRupees - existing.paidRupees;
  if (balance <= 0) throw AppError.badRequest('This invoice is already settled');
  if (payload.amountRupees > balance) {
    throw AppError.badRequest(
      `That is more than the outstanding balance of ${formatINR(balance)}`,
    );
  }

  const receiptNo = await nextReceiptNo();
  const payment = {
    receiptNo,
    amountRupees: payload.amountRupees,
    mode: payload.mode,
    reference: payload.reference,
    paidAt: payload.paidAt,
    collectedBy,
    notes: payload.notes,
    isReversed: false,
    reversalReason: '',
    reversedAt: null,
    createdAt: new Date(),
  };

  // The $expr guard makes the overpayment check atomic: if a concurrent payment landed
  // between the read above and this write, this update simply does not match.
  const result = await Invoice.updateOne(
    {
      _id: invoiceIdValue,
      status: { $ne: 'VOID' },
      $expr: { $lte: [{ $add: ['$paidRupees', payload.amountRupees] }, '$totalRupees'] },
    },
    [{ $set: { payments: { $concatArrays: ['$payments', [payment]] } } }, ...recalculationStages()],
  );

  if (result.matchedCount === 0) {
    throw AppError.conflict('The invoice changed while you were paying — reload and try again');
  }

  return getInvoice(invoiceIdValue);
}

export async function reversePayment(
  invoiceIdValue: string,
  receiptNo: string,
  reason: string,
): Promise<InvoiceDto> {
  const invoice = await Invoice.findById(invoiceIdValue).lean<InvoiceDoc>();
  if (!invoice) throw AppError.notFound(`No invoice found with ID ${invoiceIdValue}`);

  const payment = invoice.payments.find((p) => p.receiptNo === receiptNo);
  if (!payment) throw AppError.notFound(`No payment found with receipt ${receiptNo}`);
  if (payment.isReversed) throw AppError.badRequest('That payment has already been reversed');

  // Flagged, never removed: the receipt is in a parent's hands and the trail must survive.
  const result = await Invoice.updateOne({ _id: invoiceIdValue }, [
    {
      $set: {
        payments: {
          $map: {
            input: '$payments',
            as: 'p',
            in: {
              $cond: [
                { $eq: ['$$p.receiptNo', receiptNo] },
                {
                  $mergeObjects: [
                    '$$p',
                    { isReversed: true, reversalReason: reason, reversedAt: new Date() },
                  ],
                },
                '$$p',
              ],
            },
          },
        },
      },
    },
    ...recalculationStages(),
  ]);

  if (result.matchedCount === 0) throw AppError.notFound('Invoice not found');
  return getInvoice(invoiceIdValue);
}

export async function voidInvoice(invoiceIdValue: string, reason: string): Promise<InvoiceDto> {
  const invoice = await Invoice.findById(invoiceIdValue).lean<InvoiceDoc>();
  if (!invoice) throw AppError.notFound(`No invoice found with ID ${invoiceIdValue}`);
  if (invoice.status === 'VOID') throw AppError.badRequest('This invoice is already void');

  const settled = invoice.payments.filter((p) => !p.isReversed);
  if (settled.length > 0) {
    throw AppError.badRequest(
      'Reverse the recorded payments before voiding, so the collection report stays correct',
    );
  }

  await Invoice.updateOne({ _id: invoiceIdValue }, { $set: { status: 'VOID', voidReason: reason } });
  return getInvoice(invoiceIdValue);
}

/**
 * Everything a parent needs on one slip: this month's charges, plus whatever is still
 * outstanding from before, and a single figure that clears both.
 *
 * The earlier amounts are read from their own invoices and only displayed. They are not
 * copied onto this invoice — the original bills still stand, so duplicating them here
 * would double the school's reported receivables.
 */
export async function getFeeSlip(invoiceIdValue: string): Promise<FeeSlipDto> {
  const invoice = await getInvoice(invoiceIdValue);

  const others = await Invoice.find({
    studentId: invoice.studentId,
    _id: { $ne: invoiceIdValue },
    // DUE and PARTIAL only: settled and voided invoices are owed nothing.
    status: { $in: ['DUE', 'PARTIAL'] },
  })
    .select('period kind lineItems totalRupees paidRupees dueDate')
    .lean<InvoiceDoc[]>();

  const previousDues = others
    .map((doc) => ({
      invoiceId: doc._id,
      period: doc.period,
      // A monthly bill is self-describing; a charge is not, so use what it was raised for.
      label: doc.kind === 'ADHOC' ? (doc.lineItems[0]?.name ?? 'Charge') : 'Monthly fees',
      dueDate: doc.dueDate,
      balanceRupees: doc.totalRupees - doc.paidRupees,
    }))
    .filter((line) => line.balanceRupees > 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const previousDuesRupees = previousDues.reduce((sum, line) => sum + line.balanceRupees, 0);
  // A voided invoice owes nothing, whatever its arithmetic says.
  const thisInvoiceBalanceRupees = invoice.status === 'VOID' ? 0 : invoice.balanceRupees;

  return {
    invoice,
    previousDues,
    previousDuesRupees,
    thisInvoiceBalanceRupees,
    totalPayableRupees: previousDuesRupees + thisInvoiceBalanceRupees,
  };
}

export async function getStudentInvoices(studentId: string): Promise<InvoiceDto[]> {
  const docs = await Invoice.find({ studentId: studentId.toUpperCase() })
    .sort({ period: -1 })
    .lean<InvoiceDoc[]>();
  const today = toDateKey();
  return docs.map((doc) => invoiceToDto(doc, today));
}

export { agingBucket };
