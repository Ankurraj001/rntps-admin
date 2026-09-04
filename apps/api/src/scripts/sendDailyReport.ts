import { isValidDateKey } from '@rntps/shared';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../config/logger.js';
import { sendDailyCollectionReport } from '../modules/reports/dailyCollectionMail.js';

/**
 * Sends the daily fee-collection report by hand.
 *
 * The scheduled function on Netlify cannot be triggered locally, so this is how the email
 * gets checked before anyone trusts the 7pm run — and how a day is re-sent afterwards,
 * which is the only recourse for a payment backdated after its digest had already gone.
 *
 *   npm run report:daily                  # today, in IST
 *   npm run report:daily -- 2026-09-04    # any past day
 *
 * With no mail transport configured the body is logged instead of sent, so the table can
 * be read locally without credentials.
 */

async function main(): Promise<void> {
  const [dateKey] = process.argv.slice(2);

  // Rejected rather than silently treated as today: a mistyped date that quietly reports
  // the wrong day is worse than an error, because the email still looks right.
  if (dateKey !== undefined && !isValidDateKey(dateKey)) {
    throw new Error(`Usage: npm run report:daily -- [YYYY-MM-DD]  (got "${dateKey}")`);
  }

  await connectDatabase();
  const result = await sendDailyCollectionReport(dateKey ? { dateKey } : {});

  if (!result.attempted) {
    logger.warn(result, 'nothing sent — set DAILY_REPORT_TO');
    return;
  }
  logger.info(result, result.sent ? 'report sent' : 'report could not be sent');
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, 'daily collection report failed');
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
