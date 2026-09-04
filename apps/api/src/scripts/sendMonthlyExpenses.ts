import { PERIOD_PATTERN } from '@rntps/shared';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../config/logger.js';
import { sendMonthlyExpenseReport } from '../modules/expenses/expensesMail.js';

/**
 * Sends the monthly expense report by hand.
 *
 * The scheduled function cannot be triggered locally, so this is how the email gets checked
 * before anyone trusts the month-end run — and how a month is re-sent afterwards, which is
 * the only recourse for an expense entered after the report had already gone.
 *
 *   npm run report:expenses                # this month
 *   npm run report:expenses -- 2026-09     # any month
 *
 * Unlike the scheduled job this does NOT require today to be month-end: running it on the
 * 3rd to see what last month looked like is the normal way to use it.
 *
 * With no mail transport configured the body is logged instead of sent, so the table can be
 * read locally without credentials.
 */

async function main(): Promise<void> {
  const [month] = process.argv.slice(2);

  // Rejected rather than quietly treated as this month: a mistyped month that reports the
  // wrong one is worse than an error, because the email still looks right.
  if (month !== undefined && !PERIOD_PATTERN.test(month)) {
    throw new Error(`Usage: npm run report:expenses -- [YYYY-MM]  (got "${month}")`);
  }

  await connectDatabase();
  const result = await sendMonthlyExpenseReport(month ? { month } : {});

  if (!result.attempted) {
    logger.warn(result, 'nothing sent — set DAILY_REPORT_TO');
    return;
  }
  logger.info(result, result.sent ? 'report sent' : 'report could not be sent');
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, 'monthly expense report failed');
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
