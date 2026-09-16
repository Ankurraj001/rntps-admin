import { z } from 'zod';
import { DATE_KEY_PATTERN, PERIOD_PATTERN } from '../date.js';

/**
 * Which way the money went.
 *
 * Income lives in the same collection as spending rather than in its own, because every
 * figure that matters is the two sides read together: a month's net, the running total, the
 * one table in the month-end email. Splitting them would mean assembling that pair from two
 * places every time, and two places is where they drift apart.
 */
export const EXPENSE_DIRECTIONS = ['EXPENSE', 'INCOME'] as const;
export type ExpenseDirection = (typeof EXPENSE_DIRECTIONS)[number];

/**
 * Same integer-rupees rule as everywhere else: `.int()` rejects `1200.50` at the edge, and
 * the lower bound rejects a zero or negative entry, which is never real.
 */
const MIN_RUPEES = 1;

/**
 * The two ceilings differ because the two things do.
 *
 * An expense is a salary, a tank of petrol, a bill — ₹10,00,000 is far above any of them, so
 * the cap is really a typo guard against a stray zero. A grant or a government fund arrives
 * as one payment that can genuinely run to lakhs, so the same cap would reject the real
 * thing. Both are still bounded: an unbounded amount field is how a fat-fingered entry ends
 * up in a report nobody can explain.
 */
const MAX_EXPENSE_RUPEES = 1_000_000;
const MAX_INCOME_RUPEES = 10_000_000;

/**
 * One thing the school paid for or received, on one day.
 *
 * Only the date is sent. The month an entry belongs to is derived from it on the server, so a
 * row can never claim one month while its date says another.
 */
const createExpenseObject = z.object({
  dateKey: z.string().regex(DATE_KEY_PATTERN, 'Enter a valid date'),
  name: z.string().trim().min(2, 'Say what it was for').max(80),
  /**
   * Defaulted rather than required, so a caller written before income existed still sends a
   * valid body and means what it always meant.
   */
  direction: z.enum(EXPENSE_DIRECTIONS).default('EXPENSE'),
  amountRupees: z
    .number()
    .int()
    .min(MIN_RUPEES, 'Enter an amount')
    .max(MAX_INCOME_RUPEES, 'That is above the ₹1,00,00,000 limit for income'),
});

export const createExpenseSchema = createExpenseObject.refine(
  (entry) => entry.direction === 'INCOME' || entry.amountRupees <= MAX_EXPENSE_RUPEES,
  {
    // Pathed on purpose: `validate()` maps `issue.path` to the field name the form highlights,
    // so an unpathed refine produces an error with nothing to attach it to.
    path: ['amountRupees'],
    message: 'That is above the ₹10,00,000 limit for an expense',
  },
);

export type CreateExpensePayload = z.output<typeof createExpenseSchema>;

export const expensesQuerySchema = z.object({
  month: z.string().regex(PERIOD_PATTERN, 'Use the form 2026-08'),
});

export type ExpensesQuery = z.output<typeof expensesQuerySchema>;

export interface ExpenseDto {
  id: string;
  /** The day it was paid or received, IST. */
  dateKey: string;
  period: string;
  name: string;
  direction: ExpenseDirection;
  amountRupees: number;
}

/**
 * Every rupee received against every rupee recorded as spent, over the whole history.
 *
 * Read the net here with the two sides' different starting points in mind: fee collection
 * reaches back to the school's first invoice, while expenses and recorded income only exist
 * from the day someone began entering them. Any month billed before that started contributes
 * collection with no spending to offset it, so this figure flatters the school by however
 * much was spent before anyone was writing it down.
 *
 * Null until the first *expense* exists. Deliberately not "the first entry": a school that
 * has recorded a donation and no spending has nothing to offset against, and would otherwise
 * be shown a profit consisting of its entire fee income.
 */
export interface ExpenseAllTimeDto {
  /** Student fee receipts, reversals excluded. */
  collectedRupees: number;
  /** Funds, grants and donations recorded by hand. */
  gainRupees: number;
  /** `collectedRupees + gainRupees` — everything that came in, however it came in. */
  moneyInRupees: number;
  expenseRupees: number;
}

/** Everything the Expenses tab renders, in one response. */
export interface ExpenseMonthDto {
  month: string;
  /**
   * Both directions, newest first. `direction` discriminates them — a consumer that means
   * "expenses" has to filter, or it will count a donation as a cost.
   */
  items: ExpenseDto[];
  /** Spending only, so it still explains the expense rows. */
  totalRupees: number;
  /** Recorded income only. */
  gainRupees: number;
  /**
   * Student fee receipts for the month, reversals excluded — the same figure the dashboard
   * and the collection report show, because it comes from the same function.
   */
  collectedRupees: number;
  /**
   * `collectedRupees + gainRupees`. Named for what it is rather than as a kind of "collected":
   * in this system "collected" means fees, and a name built on it would invite the two to be
   * used interchangeably. Pairs with nothing invoiced — see `invoicedRupees`.
   */
  moneyInRupees: number;
  /**
   * What was billed for the month. Compares against `collectedRupees` only: a grant was never
   * invoiced to anyone, so measuring it against a billed total says nothing.
   */
  invoicedRupees: number;
  /**
   * As of today, not as of the month being viewed — it is the same all-time balance the
   * dashboard shows, and no historical version of it exists.
   *
   * Recorded income never touches this. A donation is not owed by anyone, so it cannot reduce
   * what a family still has to pay.
   */
  outstanding: { balanceRupees: number; students: number };
  allTime: ExpenseAllTimeDto | null;
}
