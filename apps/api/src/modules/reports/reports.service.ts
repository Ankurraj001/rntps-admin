import {
  agingBucket,
  attendancePercentage,
  countsAsPresent,
  countsAsWorkingDay,
  toDateKey,
  type ClassCode,
} from '@rntps/shared';
import { monthBounds } from '../../lib/dateRange.js';
import { getSettings } from '../../lib/ids.js';
import { Attendance, type AttendanceDoc } from '../../models/Attendance.js';
import { Invoice, type InvoiceDoc } from '../../models/Invoice.js';
import { Student } from '../../models/Student.js';

export interface DuesRow {
  studentId: string;
  studentName: string;
  classCode: string;
  familyId: string;
  invoiceCount: number;
  oldestDueDate: string;
  totalRupees: number;
  paidRupees: number;
  balanceRupees: number;
  bucket: '0-30' | '31-60' | '60+' | 'not-due';
}

export interface DuesReport {
  generatedAt: string;
  rows: DuesRow[];
  totals: {
    students: number;
    balanceRupees: number;
    aging: { 'not-due': number; '0-30': number; '31-60': number; '60+': number };
  };
}

/**
 * Everything currently owed, one row per student, with an aging bucket taken from the
 * oldest unpaid invoice — which is what tells the office who to chase first.
 */
export async function getDuesReport(filters: {
  classCode?: ClassCode;
  period?: string;
}): Promise<DuesReport> {
  const today = toDateKey();
  const filter: Record<string, unknown> = { status: { $in: ['DUE', 'PARTIAL'] } };
  if (filters.classCode) filter.classCodeSnapshot = filters.classCode;
  if (filters.period) filter.period = filters.period;

  const invoices = await Invoice.find(filter).lean<InvoiceDoc[]>();

  const byStudent = new Map<string, DuesRow>();
  for (const invoice of invoices) {
    const balance = invoice.totalRupees - invoice.paidRupees;
    if (balance <= 0) continue;

    let row = byStudent.get(invoice.studentId);
    if (!row) {
      row = {
        studentId: invoice.studentId,
        studentName: invoice.studentNameSnapshot,
        classCode: invoice.classCodeSnapshot,
        familyId: invoice.familyId,
        invoiceCount: 0,
        oldestDueDate: invoice.dueDate,
        totalRupees: 0,
        paidRupees: 0,
        balanceRupees: 0,
        bucket: 'not-due',
      };
      byStudent.set(invoice.studentId, row);
    }

    row.invoiceCount += 1;
    row.totalRupees += invoice.totalRupees;
    row.paidRupees += invoice.paidRupees;
    row.balanceRupees += balance;
    if (invoice.dueDate < row.oldestDueDate) row.oldestDueDate = invoice.dueDate;
  }

  const aging = { 'not-due': 0, '0-30': 0, '31-60': 0, '60+': 0 };
  const rows = [...byStudent.values()];
  for (const row of rows) {
    row.bucket = agingBucket(row.oldestDueDate, today);
    aging[row.bucket] += row.balanceRupees;
  }

  // Worst first: oldest debt, then largest.
  rows.sort((a, b) => a.oldestDueDate.localeCompare(b.oldestDueDate) || b.balanceRupees - a.balanceRupees);

  return {
    generatedAt: new Date().toISOString(),
    rows,
    totals: {
      students: rows.length,
      balanceRupees: rows.reduce((sum, row) => sum + row.balanceRupees, 0),
      aging,
    },
  };
}

export interface CollectionRow {
  receiptNo: string;
  paidAt: string;
  studentId: string;
  studentName: string;
  classCode: string;
  period: string;
  mode: string;
  reference: string;
  amountRupees: number;
}

export interface CollectionReport {
  from: string;
  to: string;
  rows: CollectionRow[];
  totals: { count: number; amountRupees: number; byMode: Record<string, number> };
}

/**
 * Money actually received in a date range. Reversed payments are excluded from the
 * totals — otherwise a bounced cheque would inflate the day's collection.
 */
export async function getCollectionReport(from: string, to: string): Promise<CollectionReport> {
  const rows = await Invoice.aggregate<CollectionRow>([
    { $match: { 'payments.paidAt': { $gte: from, $lte: to } } },
    { $unwind: '$payments' },
    {
      $match: {
        'payments.paidAt': { $gte: from, $lte: to },
        'payments.isReversed': { $ne: true },
      },
    },
    {
      $project: {
        _id: 0,
        receiptNo: '$payments.receiptNo',
        paidAt: '$payments.paidAt',
        studentId: '$studentId',
        studentName: '$studentNameSnapshot',
        classCode: '$classCodeSnapshot',
        period: '$period',
        mode: '$payments.mode',
        reference: '$payments.reference',
        amountRupees: '$payments.amountRupees',
      },
    },
    { $sort: { paidAt: 1, receiptNo: 1 } },
  ]);

  const byMode: Record<string, number> = {};
  let amountRupees = 0;
  for (const row of rows) {
    byMode[row.mode] = (byMode[row.mode] ?? 0) + row.amountRupees;
    amountRupees += row.amountRupees;
  }

  return { from, to, rows, totals: { count: rows.length, amountRupees, byMode } };
}

export interface DashboardSummary {
  /**
   * Carried here so teachers never need GET /settings, which also exposes the ID prefix
   * and the school's student and receipt counters.
   */
  school: { name: string; academicYear: string };
  activeStudents: number;
  studentsByClass: { classCode: string; count: number }[];
  today: { dateKey: string; marked: number; present: number; percentage: number; unmarkedClasses: string[] };
  month: { period: string; collectedRupees: number; invoicedRupees: number };
  outstanding: {
    balanceRupees: number;
    students: number;
    aging: { 'not-due': number; '0-30': number; '31-60': number; '60+': number };
  };
  studentsWithoutWhatsapp: number;
}

/** Everything the dashboard needs, in one round trip. */
export async function getDashboard(): Promise<DashboardSummary> {
  const today = toDateKey();
  const period = today.slice(0, 7);
  const { from, to } = monthBounds(period);

  const [settings, byClassRaw, todayRecords, classesWithStudents, dues, collection, invoicedThisMonth, noWhatsapp] =
    await Promise.all([
      getSettings(),
      Student.aggregate<{ _id: string; count: number }>([
        { $match: { status: 'ACTIVE' } },
        { $group: { _id: '$classCode', count: { $sum: 1 } } },
      ]),
      Attendance.find({ dateKey: today }).lean<AttendanceDoc[]>(),
      Student.distinct('classCode', { status: 'ACTIVE' }) as Promise<string[]>,
      getDuesReport({}),
      getCollectionReport(from, to),
      Invoice.aggregate<{ total: number }>([
        { $match: { period, status: { $ne: 'VOID' } } },
        { $group: { _id: null, total: { $sum: '$totalRupees' } } },
      ]),
      Student.countDocuments({
        status: 'ACTIVE',
        $or: [
          { guardians: { $size: 0 } },
          { guardians: { $not: { $elemMatch: { isPrimary: true, whatsappOptOut: false } } } },
        ],
      }),
    ]);

  const markedClasses = new Set<string>(todayRecords.map((r) => r.classCode));
  const workingToday = todayRecords.filter((r) => countsAsWorkingDay(r.status)).length;
  const presentToday = todayRecords.filter((r) => countsAsPresent(r.status)).length;

  return {
    school: { name: settings.schoolName, academicYear: settings.activeAcademicYear },
    activeStudents: byClassRaw.reduce((sum, row) => sum + row.count, 0),
    studentsByClass: byClassRaw.map((row) => ({ classCode: row._id, count: row.count })),
    today: {
      dateKey: today,
      marked: todayRecords.length,
      present: presentToday,
      percentage: attendancePercentage(presentToday, workingToday),
      unmarkedClasses: classesWithStudents.filter((code) => !markedClasses.has(code)).sort(),
    },
    month: {
      period,
      collectedRupees: collection.totals.amountRupees,
      invoicedRupees: invoicedThisMonth[0]?.total ?? 0,
    },
    outstanding: {
      balanceRupees: dues.totals.balanceRupees,
      students: dues.totals.students,
      aging: dues.totals.aging,
    },
    studentsWithoutWhatsapp: noWhatsapp,
  };
}
