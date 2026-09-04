import {
  toDateKey,
  toPeriod,
  type CreateExpensePayload,
  type ExpenseDto,
  type ExpenseMonthDto,
} from '@rntps/shared';
import { monthBounds } from '../../lib/dateRange.js';
import { Expense, type ExpenseDoc } from '../../models/Expense.js';
// The one place a feature module reaches into another's service, deliberately: these
// functions already encode what "collected" and "outstanding" mean here — reversed payments
// excluded, a missing isReversed on an old document read as false. Re-deriving those totals
// from Invoice directly would duplicate that logic and let this tab drift away from the
// dashboard and the collection report, which is exactly what nobody would notice.
import { getCollectionReport, getDuesReport, invoicedInPeriod } from '../reports/reports.service.js';

function toDto(doc: ExpenseDoc): ExpenseDto {
  return {
    id: String(doc._id),
    // Rows written before expenses carried a day have only a month. Falling back to the
    // first of it keeps them in the list and in the totals, which matters more than showing
    // a day nobody recorded — and it is visibly the 1st rather than a plausible-looking
    // guess. Delete the fallback once no such rows remain.
    dateKey: doc.dateKey ?? `${doc.period}-01`,
    period: doc.period,
    name: doc.name,
    amountRupees: doc.amountRupees,
  };
}

/**
 * Floor for an all-time collection query. Payments carry a `paidAt` dateKey, which sorts as
 * a string, so any date before the first school existed catches everything.
 */
const BEGINNING_OF_TIME = '1900-01-01';

/**
 * Everything collected against everything recorded as spent, over the whole history.
 *
 * **These two sides do not start from the same date, and the number flatters the school
 * because of it.** Fee collection reaches back to the first invoice ever raised; expenses
 * only exist from the day someone began entering them. Every month billed before then adds
 * collection with no spending to offset it, so the profit shown includes salaries and bills
 * that were really paid but never written down. Reported this way deliberately — it is the
 * plain all-time figure that was asked for — but it is not a P&L.
 *
 * Null until an expense exists, so a school that has not started recording is not shown a
 * profit consisting of its entire fee income.
 */
async function getAllTime(): Promise<ExpenseMonthDto['allTime']> {
  const anyExpense = await Expense.exists({});
  if (!anyExpense) return null;

  const [collection, spent] = await Promise.all([
    // Reuses getCollectionReport rather than summing payments here, so "collected" has one
    // definition across the dashboard, the collection report and this tab — reversed
    // payments excluded, a missing isReversed on an old document read as false. It builds a
    // rows array this caller discards; at a few thousand receipts that costs less than a
    // second copy of the reversal rule free to drift from the first.
    getCollectionReport(BEGINNING_OF_TIME, toDateKey()),
    Expense.aggregate<{ total: number }>([
      { $group: { _id: null, total: { $sum: '$amountRupees' } } },
    ]),
  ]);

  return {
    collectedRupees: collection.totals.amountRupees,
    expenseRupees: spent[0]?.total ?? 0,
  };
}

/** Everything the Expenses tab shows for one month, in a single round trip. */
export async function getMonth(month: string): Promise<ExpenseMonthDto> {
  const { from, to } = monthBounds(month);

  const [items, collection, invoicedRupees, dues, allTime] = await Promise.all([
    Expense.find({ period: month }).sort({ dateKey: -1, createdAt: -1 }).lean<ExpenseDoc[]>(),
    getCollectionReport(from, to),
    invoicedInPeriod(month),
    getDuesReport({}),
    getAllTime(),
  ]);

  return {
    month,
    items: items.map(toDto),
    totalRupees: items.reduce((sum, item) => sum + item.amountRupees, 0),
    collectedRupees: collection.totals.amountRupees,
    invoicedRupees,
    outstanding: { balanceRupees: dues.totals.balanceRupees, students: dues.totals.students },
    allTime,
  };
}

export async function createExpense(
  payload: CreateExpensePayload,
  recordedBy: string,
): Promise<ExpenseDto> {
  // The month is derived here, never taken from the request, so an expense cannot be filed
  // under a month its own date contradicts.
  const created = await Expense.create({
    ...payload,
    period: toPeriod(payload.dateKey),
    recordedBy,
  });
  return toDto(created.toObject<ExpenseDoc>());
}

/**
 * Removes an expense outright.
 *
 * The one hard delete among this system's money records — invoices are voided and payments
 * reversed, because a receipt is in a parent's hands and the trail has to survive. An
 * expense has no counterpart holding a copy and nothing pointing at it, so there is nothing
 * to preserve except the fact that it happened. The caller records the deleted values in the
 * audit log, which is why this returns them rather than a bare boolean.
 */
export async function deleteExpense(id: string): Promise<ExpenseDto | null> {
  const removed = await Expense.findByIdAndDelete(id).lean<ExpenseDoc>();
  return removed ? toDto(removed) : null;
}
