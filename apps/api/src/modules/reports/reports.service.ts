import {
  IST_TIME_ZONE,
  agingBucket,
  attendancePercentage,
  countsAsPresent,
  countsAsWorkingDay,
  netRupees,
  toDateKey,
  type ClassCode,
} from '@rntps/shared';
import { monthBounds } from '../../lib/dateRange.js';
import { getSettings } from '../../lib/ids.js';
import { Attendance, type AttendanceDoc } from '../../models/Attendance.js';
import { Invoice, type InvoiceDoc } from '../../models/Invoice.js';
import { Student } from '../../models/Student.js';
import { getUnmarkedClasses, holidayFor } from '../attendance/attendance.service.js';
// The ledger, not the expenses service: that service imports this file, so reaching back to
// it would close a cycle. The ledger imports only its model, which is what makes it safe to
// read from both sides.
import { monthTotals } from '../expenses/expenseLedger.js';

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
 * IDs of every student currently on school transport.
 *
 * Both money reports snapshot the student onto the invoice, so transport cannot be read
 * off the invoice — it isn't there, and a snapshot would answer "did they use transport
 * when this was billed?" rather than "do they use it now", which is the question the
 * office is asking when it filters. At ~200 students the id list is small enough to hand
 * straight to an `$in`.
 */
async function transportStudentIds(): Promise<string[]> {
  const students = await Student.find({ transportOpted: true })
    .select('_id')
    .lean<{ _id: string }[]>();
  return students.map((student) => student._id);
}

/**
 * Everything currently owed, one row per student, with an aging bucket taken from the
 * oldest unpaid invoice — which is what tells the office who to chase first.
 */
export async function getDuesReport(filters: {
  classCode?: ClassCode;
  period?: string;
  transportOnly?: boolean;
}): Promise<DuesReport> {
  const today = toDateKey();
  const filter: Record<string, unknown> = { status: { $in: ['DUE', 'PARTIAL'] } };
  if (filters.classCode) filter.classCodeSnapshot = filters.classCode;
  if (filters.period) filter.period = filters.period;
  if (filters.transportOnly) filter.studentId = { $in: await transportStudentIds() };

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
  rows.sort(
    (a, b) => a.oldestDueDate.localeCompare(b.oldestDueDate) || b.balanceRupees - a.balanceRupees,
  );

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
  /** Listed for the trail, but not money the school kept. */
  isReversed: boolean;
  reversalReason: string;
  /** IST calendar day the reversal was recorded, which is not the day of payment. */
  reversedAt: string | null;
}

export interface CollectionReport {
  from: string;
  to: string;
  rows: CollectionRow[];
  totals: {
    count: number;
    amountRupees: number;
    byMode: Record<string, number>;
    /** Reversals in the range, reported separately so they are visible but never added in. */
    reversedCount: number;
    reversedRupees: number;
  };
}

/**
 * Money received in a date range, newest receipt first.
 *
 * **Reversed payments are listed but never counted.** A bounced cheque still had a receipt
 * handed to a parent, so hiding it makes a real receipt number vanish from the record and
 * leaves whoever is reconciling against the bank with an unexplained gap. Counting it would
 * be worse — it would inflate the day's collection. So it appears as a row, flagged, and
 * `totals` sees only what the school actually kept.
 *
 * A reversal is dated independently of the payment: a receipt taken on the 5th and reversed
 * on the 20th still belongs to a 1st-to-10th report, shown as reversed. Matching on the
 * reversal date instead would make the money appear collected in any report that closed
 * before the cheque bounced.
 */
export async function getCollectionReport(
  from: string,
  to: string,
  filters: { transportOnly?: boolean } = {},
): Promise<CollectionReport> {
  const match: Record<string, unknown> = { 'payments.paidAt': { $gte: from, $lte: to } };
  if (filters.transportOnly) match.studentId = { $in: await transportStudentIds() };

  const rows = await Invoice.aggregate<CollectionRow>([
    { $match: match },
    { $unwind: '$payments' },
    { $match: { 'payments.paidAt': { $gte: from, $lte: to } } },
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
        // Documents written before reversal existed have no field at all, which must read
        // as "not reversed" rather than as null.
        isReversed: { $eq: [{ $ifNull: ['$payments.isReversed', false] }, true] },
        reversalReason: { $ifNull: ['$payments.reversalReason', ''] },
        // Formatted here rather than sent as a Date: every other day in this system is an
        // IST dateKey string, and a raw Date would shift by a day on a client west of UTC.
        reversedAt: {
          $cond: [
            { $ifNull: ['$payments.reversedAt', false] },
            {
              $dateToString: {
                date: '$payments.reversedAt',
                format: '%Y-%m-%d',
                timezone: IST_TIME_ZONE,
              },
            },
            null,
          ],
        },
      },
    },
    // Newest first: the receipts an admin needs are the ones just taken, and a month-end
    // range otherwise buries them under three hundred older rows.
    { $sort: { paidAt: -1, receiptNo: -1 } },
  ]);

  const byMode: Record<string, number> = {};
  let amountRupees = 0;
  let reversedCount = 0;
  let reversedRupees = 0;

  for (const row of rows) {
    if (row.isReversed) {
      reversedCount += 1;
      reversedRupees += row.amountRupees;
      continue;
    }
    byMode[row.mode] = (byMode[row.mode] ?? 0) + row.amountRupees;
    amountRupees += row.amountRupees;
  }

  return {
    from,
    to,
    rows,
    // `count` counts receipts kept, so it always explains `amountRupees`.
    totals: {
      count: rows.length - reversedCount,
      amountRupees,
      byMode,
      reversedCount,
      reversedRupees,
    },
  };
}

export interface DashboardSummary {
  /**
   * Carried here so teachers never need GET /settings, which also exposes the ID prefix
   * and the school's student and receipt counters.
   */
  school: { name: string; academicYear: string };
  activeStudents: number;
  studentsByClass: { classCode: string; count: number }[];
  today: {
    dateKey: string;
    marked: number;
    present: number;
    percentage: number;
    unmarkedClasses: string[];
    /** Set when the school is closed today, which is why nothing is unmarked. */
    holiday: { dateKey: string; label: string } | null;
  };
  month: { period: string; collectedRupees: number; invoicedRupees: number };
  /**
   * What the school spent and took in outside fees this month — **admin only**, `null` for a
   * teacher.
   *
   * Gated in the payload rather than in the UI because this is the one report a teacher may
   * read, and `/expenses` is admin-only for a reason ("what the school spends is not a
   * teacher's business"). Hiding these figures with a frontend check would leave them one
   * devtools tab away.
   */
  finance: {
    gainRupees: number;
    expenseRupees: number;
    /** Fee receipts plus recorded income, so no consumer has to add the two itself. */
    moneyInRupees: number;
    netRupees: number;
  } | null;
  outstanding: {
    balanceRupees: number;
    students: number;
    aging: { 'not-due': number; '0-30': number; '31-60': number; '60+': number };
  };
  studentsWithoutWhatsapp: number;
}

/** Everything the dashboard needs, in one round trip. */
/**
 * What a month was billed, excluding voided invoices.
 *
 * Extracted rather than inlined because the Expenses tab needs the same figure for an
 * arbitrary month: two copies of this pipeline would be two definitions of "invoiced",
 * free to drift apart the first time one of them learns about a new status.
 */
export async function invoicedInPeriod(period: string): Promise<number> {
  const rows = await Invoice.aggregate<{ total: number }>([
    { $match: { period, status: { $ne: 'VOID' } } },
    { $group: { _id: null, total: { $sum: '$totalRupees' } } },
  ]);
  return rows[0]?.total ?? 0;
}

export async function getDashboard(
  options: { includeFinance?: boolean } = {},
): Promise<DashboardSummary> {
  const today = toDateKey();
  const period = today.slice(0, 7);
  const { from, to } = monthBounds(period);

  const [
    settings,
    byClassRaw,
    storedToday,
    unmarkedClasses,
    dues,
    collection,
    invoicedThisMonth,
    recorded,
    noWhatsapp,
  ] = await Promise.all([
    getSettings(),
    Student.aggregate<{ _id: string; count: number }>([
      { $match: { status: 'ACTIVE' } },
      { $group: { _id: '$classCode', count: { $sum: 1 } } },
    ]),
    Attendance.find({ dateKey: today }).lean<AttendanceDoc[]>(),
    // Asked of the attendance module rather than re-derived here. Inlining the same
    // filter is what let this banner nag every Sunday while GET /attendance/unmarked,
    // which knew about the school calendar, quietly returned nothing.
    getUnmarkedClasses(today),
    getDuesReport({}),
    getCollectionReport(from, to),
    invoicedInPeriod(period),
    // Not queried at all for a teacher: the cheapest way to be sure a figure cannot leak is
    // never to fetch it.
    options.includeFinance ? monthTotals(period) : null,
    Student.countDocuments({
      status: 'ACTIVE',
      $or: [
        { guardians: { $size: 0 } },
        { guardians: { $not: { $elemMatch: { isPrimary: true, whatsappOptOut: false } } } },
      ],
    }),
  ]);

  // A holiday ignores whatever is stored, exactly as the register and the monthly sheet
  // do — otherwise a mark left behind by a day later declared a holiday would still show
  // up as "60% present today".
  const todayHoliday = holidayFor(today, settings.holidays);
  const todayRecords = todayHoliday ? [] : storedToday;
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
      unmarkedClasses: [...unmarkedClasses].sort(),
      holiday: todayHoliday,
    },
    month: {
      period,
      collectedRupees: collection.totals.amountRupees,
      invoicedRupees: invoicedThisMonth,
    },
    finance: recorded
      ? {
          gainRupees: recorded.gainRupees,
          expenseRupees: recorded.expenseRupees,
          moneyInRupees: collection.totals.amountRupees + recorded.gainRupees,
          netRupees: netRupees({
            collectedRupees: collection.totals.amountRupees,
            gainRupees: recorded.gainRupees,
            expenseRupees: recorded.expenseRupees,
          }),
        }
      : null,
    outstanding: {
      balanceRupees: dues.totals.balanceRupees,
      students: dues.totals.students,
      aging: dues.totals.aging,
    },
    studentsWithoutWhatsapp: noWhatsapp,
  };
}
