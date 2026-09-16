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
import {
  getCollectionReport,
  getDuesReport,
  invoicedInPeriod,
} from '../reports/reports.service.js';
import {
  allTimeTotals,
  anyExpenseRecorded,
  monthRows,
  splitByDirection,
  toDto,
} from './expenseLedger.js';

/**
 * Floor for an all-time collection query. Payments carry a `paidAt` dateKey, which sorts as
 * a string, so any date before the first school existed catches everything.
 */
const BEGINNING_OF_TIME = '1900-01-01';

/**
 * Everything received against everything recorded as spent, over the whole history.
 *
 * **These two sides do not start from the same date, and the number flatters the school
 * because of it.** Fee collection reaches back to the first invoice ever raised; expenses and
 * recorded income only exist from the day someone began entering them. Every month billed
 * before then adds collection with no spending to offset it, so the profit shown includes
 * salaries and bills that were really paid but never written down. Reported this way
 * deliberately — it is the plain all-time figure that was asked for — but it is not a P&L.
 *
 * Null until an *expense* exists, so a school that has not started recording is not shown a
 * profit consisting of its entire fee income. A donation on its own does not open the gate:
 * it would make the number worse, not better, by adding to the unoffset side.
 */
async function getAllTime(): Promise<ExpenseMonthDto['allTime']> {
  if (!(await anyExpenseRecorded())) return null;

  const [collection, recorded] = await Promise.all([
    // Reuses getCollectionReport rather than summing payments here, so "collected" has one
    // definition across the dashboard, the collection report and this tab — reversed
    // payments excluded, a missing isReversed on an old document read as false. It builds a
    // rows array this caller discards; at a few thousand receipts that costs less than a
    // second copy of the reversal rule free to drift from the first.
    getCollectionReport(BEGINNING_OF_TIME, toDateKey()),
    allTimeTotals(),
  ]);

  const collectedRupees = collection.totals.amountRupees;
  return {
    collectedRupees,
    gainRupees: recorded.gainRupees,
    moneyInRupees: collectedRupees + recorded.gainRupees,
    expenseRupees: recorded.expenseRupees,
  };
}

/** Everything the Expenses tab shows for one month, in a single round trip. */
export async function getMonth(month: string): Promise<ExpenseMonthDto> {
  const { from, to } = monthBounds(month);

  const [items, collection, invoicedRupees, dues, allTime] = await Promise.all([
    monthRows(month),
    getCollectionReport(from, to),
    invoicedInPeriod(month),
    getDuesReport({}),
    getAllTime(),
  ]);

  // Folded from the rows the tab is about to render rather than queried separately, so the
  // cards cannot state a total the list below them does not add up to.
  const { expenseRupees, gainRupees } = splitByDirection(items);
  const collectedRupees = collection.totals.amountRupees;

  return {
    month,
    items,
    totalRupees: expenseRupees,
    gainRupees,
    collectedRupees,
    moneyInRupees: collectedRupees + gainRupees,
    invoicedRupees,
    outstanding: { balanceRupees: dues.totals.balanceRupees, students: dues.totals.students },
    allTime,
  };
}

export async function createExpense(
  payload: CreateExpensePayload,
  recordedBy: string,
): Promise<ExpenseDto> {
  // The month is derived here, never taken from the request, so an entry cannot be filed
  // under a month its own date contradicts.
  const created = await Expense.create({
    ...payload,
    period: toPeriod(payload.dateKey),
    recordedBy,
  });
  return toDto(created.toObject<ExpenseDoc>());
}

/**
 * Removes an entry outright.
 *
 * One of the two hard deletes among this system's money records — the other being an invoice
 * nobody ever paid against. Payments are always reversed rather than removed, and an invoice
 * with any payment on it is voided rather than deleted, because a receipt is in a parent's
 * hands and the trail has to survive. An expense has no counterpart holding a copy and nothing
 * pointing at it, so there is nothing to preserve except the fact that it happened. The caller
 * records the deleted values in the audit log, which is why this returns them rather than a
 * bare boolean.
 */
export async function deleteExpense(id: string): Promise<ExpenseDto | null> {
  const removed = await Expense.findByIdAndDelete(id).lean<ExpenseDoc>();
  return removed ? toDto(removed) : null;
}
