import { lastDayOfPeriod, toDateKey, toPeriod } from '@rntps/shared';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { logger } from './config/logger.js';
import { sendMonthlyExpenseReport } from './modules/expenses/expensesMail.js';

/**
 * True when today, in IST, is the last day of its own month.
 *
 * **This guard is what makes the schedule correct, not an optimisation.** Cron has no way
 * to say "the last day of the month", so the function is scheduled on days 28–31 and throws
 * away the firings that are not month-end. Without this, February would mail once and
 * January four times.
 */
function isLastDayOfMonth(dateKey: string): boolean {
  return lastDayOfPeriod(toPeriod(dateKey)) === dateKey;
}

/**
 * The month-end expense report, as a job rather than a request.
 *
 * Like the daily report it avoids Express entirely — a scheduled task routes nothing — and
 * does not reuse `netlify.ts`'s cached pool, since running once a month means every
 * invocation is a cold start and caching buys nothing.
 *
 * @returns true when there is nothing to investigate: the report went out, it is switched
 * off on purpose, or today simply is not month-end.
 */
export async function runMonthlyExpenseReport(): Promise<boolean> {
  const today = toDateKey();

  // Checked before connecting: on three firings out of four there is nothing to do, and
  // opening a database pool to discover that would be waste on a timer.
  if (!isLastDayOfMonth(today)) {
    logger.info({ today }, 'not the last day of the month — monthly expense report skipped');
    return true;
  }

  try {
    await connectDatabase();
  } catch (error) {
    // Deliberately does not fall through to sending. An email reading "no expenses
    // recorded" because the query never ran is worse than no email: it is indistinguishable
    // from a real month of nothing, and it would be believed.
    logger.error({ err: error }, 'monthly expense report: database unavailable');
    return false;
  }

  try {
    const result = await sendMonthlyExpenseReport();
    logger.info({ result }, 'monthly expense report');
    return !result.attempted || result.sent;
  } finally {
    await disconnectDatabase();
  }
}
