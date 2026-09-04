import { z } from 'zod';
import { DATE_KEY_PATTERN, PERIOD_PATTERN } from '../date.js';

/**
 * Same integer-rupees rule as everywhere else: `.int()` rejects `1200.50` at the edge, and
 * the lower bound rejects a zero or negative expense, which is never a real entry.
 */
const rupees = z.number().int().min(1, 'Enter an amount').max(1_000_000);

/**
 * One thing the school paid for, on one day.
 *
 * Only the date is sent. The month an expense belongs to is derived from it on the server,
 * so a row can never claim one month while its date says another.
 */
export const createExpenseSchema = z.object({
  dateKey: z.string().regex(DATE_KEY_PATTERN, 'Enter a valid date'),
  name: z.string().trim().min(2, 'Say what it was for').max(80),
  amountRupees: rupees,
});

export type CreateExpensePayload = z.output<typeof createExpenseSchema>;

export const expensesQuerySchema = z.object({
  month: z.string().regex(PERIOD_PATTERN, 'Use the form 2026-08'),
});

export type ExpensesQuery = z.output<typeof expensesQuerySchema>;

export interface ExpenseDto {
  id: string;
  /** The day it was paid, IST. */
  dateKey: string;
  period: string;
  name: string;
  amountRupees: number;
}

/**
 * Every rupee collected against every rupee recorded as spent, over the whole history.
 *
 * Read the profit here with the two sides' different starting points in mind: fee
 * collection reaches back to the school's first invoice, while expenses only exist from the
 * day someone began entering them. Any month billed before expense tracking started
 * contributes collection with no spending to offset it, so this figure flatters the school
 * by however much was spent before anyone was writing it down.
 *
 * Null until the first expense exists — before that there is nothing to compare against.
 */
export interface ExpenseAllTimeDto {
  collectedRupees: number;
  expenseRupees: number;
}

/** Everything the Expenses tab renders, in one response. */
export interface ExpenseMonthDto {
  month: string;
  items: ExpenseDto[];
  totalRupees: number;
  collectedRupees: number;
  invoicedRupees: number;
  /**
   * As of today, not as of the month being viewed — it is the same all-time balance the
   * dashboard shows, and no historical version of it exists.
   */
  outstanding: { balanceRupees: number; students: number };
  allTime: ExpenseAllTimeDto | null;
}
