import { toPeriod, type ExpenseDto } from '@rntps/shared';
import { Expense, type ExpenseDoc } from '../../models/Expense.js';

/**
 * Reading the hand-entered money ledger: the rows, and the two totals derived from them.
 *
 * Separate from `expenses.service.ts` so that `reports.service.ts` and the daily digest can
 * read this collection without importing the service — the service already imports
 * `reports.service.ts` on purpose, and reaching back the other way would close a cycle.
 * Nothing here imports anything but the model, which is what keeps that true.
 */

export interface DirectionTotals {
  expenseRupees: number;
  gainRupees: number;
}

export function toDto(doc: ExpenseDoc): ExpenseDto {
  return {
    id: String(doc._id),
    // Rows written before expenses carried a day have only a month. Falling back to the
    // first of it keeps them in the list and in the totals, which matters more than showing
    // a day nobody recorded — and it is visibly the 1st rather than a plausible-looking
    // guess. Delete the fallback once no such rows remain.
    dateKey: doc.dateKey ?? `${doc.period}-01`,
    period: doc.period,
    name: doc.name,
    // Rows written before income existed are spending, which is all there was.
    direction: doc.direction ?? 'EXPENSE',
    amountRupees: doc.amountRupees,
  };
}

/**
 * Splits already-fetched rows into the two totals.
 *
 * A fold over the array rather than a second aggregation, wherever the caller is holding the
 * rows anyway: the Expenses tab renders that exact array under the cards, and a sum of what
 * is on screen cannot contradict what is on screen. An aggregation computed alongside it
 * could, the first time anyone adds a filter or a limit to the query.
 */
export function splitByDirection(items: ExpenseDto[]): DirectionTotals {
  let expenseRupees = 0;
  let gainRupees = 0;

  for (const item of items) {
    if (item.direction === 'INCOME') gainRupees += item.amountRupees;
    else expenseRupees += item.amountRupees;
  }

  return { expenseRupees, gainRupees };
}

/**
 * The same totals where there is no row array to fold — an arbitrary slice of the collection.
 *
 * `$ifNull` rather than a `direction` equality: a row written before the field existed has no
 * `direction` at all, and must count as spending rather than falling out of both sides.
 */
async function sumByDirection(match: Record<string, unknown>): Promise<DirectionTotals> {
  const rows = await Expense.aggregate<{ _id: string; total: number }>([
    { $match: match },
    {
      $group: {
        _id: { $ifNull: ['$direction', 'EXPENSE'] },
        total: { $sum: '$amountRupees' },
      },
    },
  ]);

  const find = (direction: string) => rows.find((row) => row._id === direction)?.total ?? 0;
  return { expenseRupees: find('EXPENSE'), gainRupees: find('INCOME') };
}

/** Newest day first, then newest entry within the day — the order the tab lists them in. */
export async function monthRows(period: string): Promise<ExpenseDto[]> {
  const docs = await Expense.find({ period })
    .sort({ dateKey: -1, createdAt: -1 })
    .lean<ExpenseDoc[]>();
  return docs.map(toDto);
}

/**
 * One day's rows in one direction, for the daily digest.
 *
 * Matches `period` as well as `dateKey` so the query is two equalities against
 * `{period: -1, dateKey: -1}` rather than an unindexed scan on `dateKey` alone. A legacy row
 * with no `dateKey` therefore never appears here, which is right — nobody recorded its day —
 * but it does mean a day's rows are not a partition of the month's.
 */
export async function dayRows(
  dateKey: string,
  direction: 'EXPENSE' | 'INCOME',
): Promise<ExpenseDto[]> {
  const docs = await Expense.find({
    period: toPeriod(dateKey),
    dateKey,
    ...(direction === 'EXPENSE'
      ? { $or: [{ direction: 'EXPENSE' }, { direction: { $exists: false } }] }
      : { direction: 'INCOME' }),
  })
    .sort({ createdAt: 1 })
    .lean<ExpenseDoc[]>();
  return docs.map(toDto);
}

/**
 * One month's totals without its rows, for the dashboard.
 *
 * The Expenses tab folds `splitByDirection` over the rows it is already rendering instead —
 * use this only where there is no such array to fold.
 */
export function monthTotals(period: string): Promise<DirectionTotals> {
  return sumByDirection({ period });
}

export function dayTotals(dateKey: string): Promise<DirectionTotals> {
  return sumByDirection({ period: toPeriod(dateKey), dateKey });
}

export function allTimeTotals(): Promise<DirectionTotals> {
  return sumByDirection({});
}

/**
 * Whether any *spending* has ever been recorded.
 *
 * Gates the all-time figures, and deliberately ignores income: a school that has entered a
 * donation and no expenses has nothing to offset against, and showing it a net would mean
 * showing a profit made of its entire fee income. Absent `direction` counts, since every row
 * written before the field existed was spending.
 */
export async function anyExpenseRecorded(): Promise<boolean> {
  const found = await Expense.exists({
    $or: [{ direction: 'EXPENSE' }, { direction: { $exists: false } }],
  });
  return found !== null;
}
