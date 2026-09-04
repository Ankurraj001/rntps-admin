import {
  FEE_DEMAND_TEMPLATE_KEY,
  buildFeeSlip,
  buildWaLink,
  fitWaMessage,
  ordinalDay,
  periodLabel,
  renderTemplate,
  toDateKey,
  waUrlFits,
  type CreateBatchPayload,
  type FeeMessageChild,
  type FeeSlipMode,
  type InvoiceWaLinkDto,
  type NotificationBatchDto,
  type NotificationItemStatus,
} from '@rntps/shared';
import { AppError } from '../../lib/AppError.js';
import { getSettings } from '../../lib/ids.js';
import { Invoice, type InvoiceDoc } from '../../models/Invoice.js';
import { Notification, type NotificationDoc, type NotificationItemSub } from '../../models/Notification.js';
import { Student, type StudentDoc } from '../../models/Student.js';

/**
 * Only the table is fenced. WhatsApp renders a ``` block in monospace, which is what makes
 * the amount column line up, but a whole message in monospace reads small and cramped — so
 * the school name, the month and the note stay as normal text.
 */
const DEFAULT_TEMPLATE = [
  '*{{schoolName}}*',
  '{{schoolAddress}}',
  '',
  '*MONTHLY FEE · {{periodLabel}}*',
  '{{slip}}',
  '_{{note}}_',
].join('\n');

function toDto(doc: NotificationDoc): NotificationBatchDto {
  const sentCount = doc.items.filter((i) => i.status === 'SENT').length;
  const skippedCount = doc.items.filter((i) => i.status === 'SKIPPED').length;

  return {
    id: String(doc._id),
    type: doc.type,
    createdAt: doc.createdAt?.toISOString() ?? '',
    filter: {
      ...(doc.filterSnapshot.period ? { period: doc.filterSnapshot.period } : {}),
      ...(doc.filterSnapshot.classCodes?.length ? { classCodes: doc.filterSnapshot.classCodes } : {}),
      minDueRupees: doc.filterSnapshot.minDueRupees,
      overdueOnly: doc.filterSnapshot.overdueOnly,
    },
    totalCount: doc.totalCount,
    sentCount,
    skippedCount,
    items: doc.items.map((item) => ({
      key: item.key,
      guardianName: item.guardianName,
      guardianPhone: item.guardianPhone,
      familyIds: [...item.familyIds],
      students: item.students.map((s) => ({ ...s })),
      invoiceIds: [...item.invoiceIds],
      totalDueRupees: item.totalDueRupees,
      renderedMessage: item.renderedMessage,
      // Derived, never stored: it is `buildWaLink(guardianPhone, renderedMessage)` by
      // construction, and the percent-encoded copy cost ~64% of every batch document.
      waLink: buildWaLink(item.guardianPhone, item.renderedMessage),
      status: item.status,
      sentAt: item.sentAt?.toISOString() ?? null,
    })),
    unreachable: doc.unreachable.map((u) => ({ ...u })),
  };
}

type ReachableStudent = Pick<StudentDoc, '_id' | 'fullName' | 'classCode' | 'familyId' | 'guardians'>;

/** One child's share of a family message, plus what the header needs to label it. */
interface ChildBill {
  studentId: string;
  /** Period of the invoice being itemised — not necessarily the filtered period. */
  period: string;
  bill: FeeMessageChild;
}

/**
 * Builds one message per guardian phone number.
 *
 * Grouping by phone rather than by family is deliberate: the phone is the actual unit of
 * messaging, so a parent with three children in school gets one message listing all
 * three instead of three separate messages. wa.me needs a human click per message, so
 * every duplicate avoided is real work saved.
 *
 * Each child's bill is itemised — a line per fee head and absorbed charge, then the
 * adjustments — because a parent handed a single figure cannot tell what it is made of,
 * and the school ends up answering the phone instead.
 */
export async function createBatch(
  payload: CreateBatchPayload,
  createdBy: string,
): Promise<NotificationBatchDto> {
  const settings = await getSettings();
  const today = toDateKey();

  const invoiceFilter: Record<string, unknown> = { status: { $in: ['DUE', 'PARTIAL'] } };
  if (payload.period) invoiceFilter.period = payload.period;
  if (payload.classCodes?.length) invoiceFilter.classCodeSnapshot = { $in: payload.classCodes };
  if (payload.overdueOnly) invoiceFilter.dueDate = { $lt: today };

  const matched = await Invoice.find(invoiceFilter).select('studentId totalRupees paidRupees').lean<
    Pick<InvoiceDoc, '_id' | 'studentId' | 'totalRupees' | 'paidRupees'>[]
  >();
  const owing = matched.filter((invoice) => invoice.totalRupees - invoice.paidRupees > 0);
  if (owing.length === 0) throw AppError.badRequest('No unpaid invoices match those filters');

  const studentIds = [...new Set(owing.map((invoice) => invoice.studentId))];

  /**
   * The filter decides *who* to chase; the amounts then have to cover everything those
   * students owe, arrears included, or the itemised rows would not add up to the figure
   * the parent is asked to pay.
   *
   * One batched query rather than a `getFeeSlip()` call per student, which would be a
   * round trip each — a couple of hundred of them on a month-end run.
   */
  const unpaid = await Invoice.find({
    studentId: { $in: studentIds },
    status: { $in: ['DUE', 'PARTIAL'] },
  }).lean<InvoiceDoc[]>();

  const billsByStudent = new Map<string, InvoiceDoc[]>();
  for (const invoice of unpaid) {
    if (invoice.totalRupees - invoice.paidRupees <= 0) continue;
    const list = billsByStudent.get(invoice.studentId);
    if (list) list.push(invoice);
    else billsByStudent.set(invoice.studentId, [invoice]);
  }
  for (const list of billsByStudent.values()) list.sort((a, b) => a.period.localeCompare(b.period));

  const students = await Student.find({ _id: { $in: studentIds } })
    .select('fullName classCode familyId guardians')
    .lean<ReachableStudent[]>();

  const unreachable: NotificationDoc['unreachable'] = [];
  const grouped = new Map<
    string,
    {
      guardianName: string;
      guardianPhone: string;
      familyIds: Set<string>;
      children: Map<string, ChildBill>;
      invoiceIds: string[];
    }
  >();

  // Iterating students rather than invoices: a student with three unpaid months is one
  // child on one message, and one entry in `unreachable` if nobody can be reached.
  for (const student of students) {
    const bills = billsByStudent.get(student._id) ?? [];
    const current = bills[bills.length - 1];
    if (!current) continue;

    const guardian =
      student.guardians.find((g) => g.isPrimary && !g.whatsappOptOut) ??
      student.guardians.find((g) => !g.whatsappOptOut);

    if (!guardian) {
      unreachable.push({
        studentId: student._id,
        fullName: student.fullName,
        classCode: student.classCode,
        reason: student.guardians.length === 0 ? 'No guardian on record' : 'All guardians opted out of WhatsApp',
      });
      continue;
    }

    // The newest unpaid bill is the one itemised; everything older collapses into a single
    // "Previous dues" row. Those older invoices still stand on their own — showing them
    // here does not re-charge them, which is the rule the printed fee slip follows too.
    const previousDuesRupees = bills
      .slice(0, -1)
      .reduce((sum, invoice) => sum + (invoice.totalRupees - invoice.paidRupees), 0);
    const balance = current.totalRupees - current.paidRupees;

    let group = grouped.get(guardian.phone);
    if (!group) {
      group = {
        guardianName: guardian.name,
        guardianPhone: guardian.phone,
        familyIds: new Set(),
        children: new Map(),
        invoiceIds: [],
      };
      grouped.set(guardian.phone, group);
    }

    group.familyIds.add(student.familyId);
    group.invoiceIds.push(...bills.map((invoice) => invoice._id));
    group.children.set(student._id, {
      studentId: student._id,
      period: current.period,
      bill: {
        fullName: student.fullName,
        classCode: student.classCode,
        lines: current.lineItems.map((line) => ({ name: line.name, amountRupees: line.amountRupees })),
        concessionRupees: current.concessionRupees,
        previousDuesRupees,
        paidRupees: current.paidRupees,
        totalRupees: balance + previousDuesRupees,
      },
    });
  }

  const template =
    settings.templates.find((t) => t.key === FEE_DEMAND_TEMPLATE_KEY && t.isActive)?.body ?? DEFAULT_TEMPLATE;
  const note = `Fee should be paid from 1st to ${ordinalDay(settings.feeDueDayOfMonth)} of every month.`;

  const items: NotificationItemSub[] = [];
  for (const group of grouped.values()) {
    const children = [...group.children.values()].sort((a, b) =>
      a.bill.fullName.localeCompare(b.bill.fullName),
    );
    const totalDueRupees = children.reduce((sum, child) => sum + child.bill.totalRupees, 0);
    if (totalDueRupees < payload.minDueRupees) continue;

    // Truthful whatever the filter was: name a month only when every child's itemised bill
    // is for that same month. A filter can select July while the newest unpaid bill — the
    // one actually itemised — is August.
    const periods = new Set(children.map((child) => child.period));
    const [onlyPeriod] = [...periods];
    const label = periods.size === 1 && onlyPeriod ? periodLabel(onlyPeriod) : 'Outstanding fees';

    const render = (mode: FeeSlipMode): string =>
      renderTemplate(template, {
        schoolName: settings.schoolName,
        schoolAddress: settings.schoolAddress,
        periodLabel: label,
        slip: buildFeeSlip(
          children.map((child) => child.bill),
          totalDueRupees,
          mode,
        ),
        note,
      })
        // A school with no address on record would otherwise leave a gap under its name.
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    let message = render('full');
    if (!waUrlFits(group.guardianPhone, message)) message = render('compact');
    message = fitWaMessage(group.guardianPhone, message);

    items.push({
      key: group.guardianPhone,
      guardianName: group.guardianName,
      guardianPhone: group.guardianPhone,
      familyIds: [...group.familyIds],
      students: children.map((child) => ({
        studentId: child.studentId,
        fullName: child.bill.fullName,
        classCode: child.bill.classCode,
        dueRupees: child.bill.totalRupees,
      })),
      invoiceIds: group.invoiceIds,
      totalDueRupees,
      renderedMessage: message,
      status: 'PENDING',
      sentAt: null,
      sentBy: null,
    });
  }

  if (items.length === 0) {
    throw AppError.badRequest(
      unreachable.length > 0
        ? 'Every matching student is missing a reachable WhatsApp number'
        : 'Nothing to send — no family owes at least the minimum amount',
    );
  }

  items.sort((a, b) => b.totalDueRupees - a.totalDueRupees);

  const created = await Notification.create({
    type: payload.type,
    createdBy,
    filterSnapshot: {
      ...(payload.period ? { period: payload.period } : {}),
      ...(payload.classCodes?.length ? { classCodes: payload.classCodes } : {}),
      minDueRupees: payload.minDueRupees,
      overdueOnly: payload.overdueOnly,
    },
    totalCount: items.length,
    items,
    unreachable,
  });

  return toDto(created.toObject());
}

/**
 * Builds a wa.me link for one specific invoice — the same message a bulk fee-demand run
 * would produce for this student, but for exactly the bill being looked at rather than
 * whatever period a filter happens to match.
 */
export async function buildInvoiceWaLink(invoiceId: string): Promise<InvoiceWaLinkDto> {
  const invoice = await Invoice.findById(invoiceId).lean<InvoiceDoc>();
  if (!invoice) throw AppError.notFound(`No invoice found with ID ${invoiceId}`);

  const student = await Student.findById(invoice.studentId)
    .select('guardians')
    .lean<Pick<StudentDoc, 'guardians'>>();
  if (!student) throw AppError.notFound(`No student found with ID ${invoice.studentId}`);

  const guardian =
    student.guardians.find((g) => g.isPrimary && !g.whatsappOptOut) ??
    student.guardians.find((g) => !g.whatsappOptOut);
  if (!guardian) {
    throw AppError.badRequest(
      student.guardians.length === 0
        ? 'No guardian on record for this student'
        : 'Every guardian on record has opted out of WhatsApp',
    );
  }

  // Everything still owed on this student's other invoices, rolled into one row — the
  // same "Previous dues" convention createBatch and the printed fee slip both follow, so a
  // single bill sent this way still tells the whole story rather than just this month.
  const others = await Invoice.find({
    studentId: invoice.studentId,
    _id: { $ne: invoice._id },
    status: { $in: ['DUE', 'PARTIAL'] },
  })
    .select('totalRupees paidRupees')
    .lean<Pick<InvoiceDoc, 'totalRupees' | 'paidRupees'>[]>();
  const previousDuesRupees = others.reduce((sum, i) => sum + (i.totalRupees - i.paidRupees), 0);

  // A voided invoice owes nothing of its own, whatever its arithmetic says — the same rule
  // getFeeSlip follows.
  const ownBalance = invoice.status === 'VOID' ? 0 : Math.max(0, invoice.totalRupees - invoice.paidRupees);

  const child: FeeMessageChild = {
    fullName: invoice.studentNameSnapshot,
    classCode: invoice.classCodeSnapshot,
    lines: invoice.lineItems.map((line) => ({ name: line.name, amountRupees: line.amountRupees })),
    concessionRupees: invoice.concessionRupees,
    previousDuesRupees,
    paidRupees: invoice.paidRupees,
    totalRupees: ownBalance + previousDuesRupees,
  };

  const settings = await getSettings();
  const template =
    settings.templates.find((t) => t.key === FEE_DEMAND_TEMPLATE_KEY && t.isActive)?.body ?? DEFAULT_TEMPLATE;
  const note = `Fee should be paid from 1st to ${ordinalDay(settings.feeDueDayOfMonth)} of every month.`;

  const render = (mode: FeeSlipMode): string =>
    renderTemplate(template, {
      schoolName: settings.schoolName,
      schoolAddress: settings.schoolAddress,
      periodLabel: periodLabel(invoice.period),
      slip: buildFeeSlip([child], child.totalRupees, mode),
      note,
    })
      // A school with no address on record would otherwise leave a gap under its name.
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  let message = render('full');
  if (!waUrlFits(guardian.phone, message)) message = render('compact');
  message = fitWaMessage(guardian.phone, message);

  return { guardianName: guardian.name, guardianPhone: guardian.phone, waLink: buildWaLink(guardian.phone, message) };
}

export async function getBatch(batchId: string): Promise<NotificationBatchDto> {
  const doc = await Notification.findById(batchId).lean<NotificationDoc>();
  if (!doc) throw AppError.notFound('Notification batch not found');
  return toDto(doc);
}

export async function listBatches(limit = 20): Promise<Omit<NotificationBatchDto, 'items' | 'unreachable'>[]> {
  const docs = await Notification.find().sort({ createdAt: -1 }).limit(limit).lean<NotificationDoc[]>();
  return docs.map((doc) => {
    const { items: _items, unreachable: _unreachable, ...rest } = toDto(doc);
    return rest;
  });
}

/**
 * Marks one item's progress. Stored server-side so the queue is resumable: close the
 * tab, come back, and continue where you left off.
 */
export async function setItemStatus(
  batchId: string,
  itemKey: string,
  status: NotificationItemStatus,
  actorId: string,
): Promise<NotificationBatchDto> {
  const result = await Notification.updateOne(
    { _id: batchId, 'items.key': itemKey },
    {
      $set: {
        'items.$.status': status,
        'items.$.sentAt': status === 'SENT' ? new Date() : null,
        'items.$.sentBy': status === 'SENT' ? actorId : null,
      },
    },
  );

  if (result.matchedCount === 0) throw AppError.notFound('Notification item not found');
  return getBatch(batchId);
}
