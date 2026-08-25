import {
  MAX_MESSAGE_LENGTH,
  buildWaLink,
  formatINR,
  renderTemplate,
  toDateKey,
  type CreateBatchPayload,
  type NotificationBatchDto,
  type NotificationItemStatus,
} from '@rntps/shared';
import { AppError } from '../../lib/AppError.js';
import { getSettings } from '../../lib/ids.js';
import { Invoice, type InvoiceDoc } from '../../models/Invoice.js';
import { Notification, type NotificationDoc, type NotificationItemSub } from '../../models/Notification.js';
import { Student, type StudentDoc } from '../../models/Student.js';

const DEFAULT_TEMPLATE = [
  'Dear {{guardianName}},',
  'Fee due at {{schoolName}} for {{period}}:',
  '{{studentLines}}',
  'Total: {{familyTotal}}',
  'Kindly pay by {{dueDate}}.',
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
      waLink: item.waLink,
      status: item.status,
      sentAt: item.sentAt?.toISOString() ?? null,
    })),
    unreachable: doc.unreachable.map((u) => ({ ...u })),
  };
}

type ReachableStudent = Pick<StudentDoc, '_id' | 'fullName' | 'classCode' | 'familyId' | 'guardians'>;

/**
 * Builds one message per guardian phone number.
 *
 * Grouping by phone rather than by family is deliberate: the phone is the actual unit of
 * messaging, so a parent with three children in school gets one message listing all
 * three instead of three separate messages. wa.me needs a human click per message, so
 * every duplicate avoided is real work saved.
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

  const invoices = await Invoice.find(invoiceFilter).lean<InvoiceDoc[]>();
  if (invoices.length === 0) throw AppError.badRequest('No unpaid invoices match those filters');

  const students = await Student.find({ _id: { $in: [...new Set(invoices.map((i) => i.studentId))] } })
    .select('fullName classCode familyId guardians')
    .lean<ReachableStudent[]>();
  const studentById = new Map(students.map((s) => [s._id, s]));

  const unreachable: NotificationDoc['unreachable'] = [];
  const grouped = new Map<
    string,
    {
      guardianName: string;
      guardianPhone: string;
      familyIds: Set<string>;
      students: Map<string, { studentId: string; fullName: string; classCode: string; dueRupees: number }>;
      invoiceIds: string[];
    }
  >();

  for (const invoice of invoices) {
    const balance = invoice.totalRupees - invoice.paidRupees;
    if (balance <= 0) continue;

    const student = studentById.get(invoice.studentId);
    if (!student) continue;

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

    let group = grouped.get(guardian.phone);
    if (!group) {
      group = {
        guardianName: guardian.name,
        guardianPhone: guardian.phone,
        familyIds: new Set(),
        students: new Map(),
        invoiceIds: [],
      };
      grouped.set(guardian.phone, group);
    }

    group.familyIds.add(student.familyId);
    group.invoiceIds.push(invoice._id);

    // One student can owe across several months; the message shows a single total.
    const existing = group.students.get(student._id);
    if (existing) existing.dueRupees += balance;
    else {
      group.students.set(student._id, {
        studentId: student._id,
        fullName: student.fullName,
        classCode: student.classCode,
        dueRupees: balance,
      });
    }
  }

  const template =
    settings.templates.find((t) => t.key === 'FEE_DUE' && t.isActive)?.body ?? DEFAULT_TEMPLATE;

  const items: NotificationItemSub[] = [];
  for (const group of grouped.values()) {
    const students = [...group.students.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
    const totalDueRupees = students.reduce((sum, s) => sum + s.dueRupees, 0);
    if (totalDueRupees < payload.minDueRupees) continue;

    const periodLabel = payload.period ?? 'outstanding fees';
    const dueDates = group.invoiceIds
      .map((id) => invoices.find((i) => i._id === id)?.dueDate)
      .filter((d): d is string => Boolean(d))
      .sort();

    const message = renderTemplate(template, {
      guardianName: group.guardianName,
      schoolName: settings.schoolName,
      period: periodLabel,
      studentLines: students
        .map((s) => `- ${s.fullName} (${s.classCode}): ${formatINR(s.dueRupees)}`)
        .join('\n'),
      familyTotal: formatINR(totalDueRupees),
      dueDate: dueDates[0] ?? '',
    }).slice(0, MAX_MESSAGE_LENGTH);

    items.push({
      key: group.guardianPhone,
      guardianName: group.guardianName,
      guardianPhone: group.guardianPhone,
      familyIds: [...group.familyIds],
      students,
      invoiceIds: group.invoiceIds,
      totalDueRupees,
      renderedMessage: message,
      waLink: buildWaLink(group.guardianPhone, message),
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
