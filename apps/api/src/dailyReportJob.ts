import { connectDatabase, disconnectDatabase } from './config/db.js';
import { logger } from './config/logger.js';
import { sendDailyCollectionReport } from './modules/reports/dailyCollectionMail.js';

/**
 * The 7pm IST daily collection report, as a job rather than a request.
 *
 * Deliberately not wired through Express: a scheduled task routes nothing, so
 * `serverless-http` and the whole app would be scaffolding around one function call. The
 * Netlify shim in `netlify/functions/daily-report.mjs` wraps this in a `Response`; keeping
 * that here would put a platform detail in the only part of this feature that is testable
 * without one.
 *
 * Nor does it reuse `netlify.ts`'s cached connection pool. That exists because the API
 * function is invoked constantly and a warm container should not open a second pool. This
 * runs once every 24 hours and is therefore always a cold start, so caching buys nothing,
 * and disconnecting explicitly means the container has no reason to linger.
 *
 * @returns true when there is nothing to investigate — the report went out, or it is
 * switched off on purpose.
 */
export async function runDailyReport(): Promise<boolean> {
  try {
    await connectDatabase();
  } catch (error) {
    // Deliberately does not fall through to sending. An email reading "₹0 collected"
    // because the query never ran is worse than no email at all: it is indistinguishable
    // from a real quiet day, and it would be believed.
    logger.error({ err: error }, 'daily collection report: database unavailable');
    return false;
  }

  try {
    const result = await sendDailyCollectionReport();
    return !result.attempted || result.sent;
  } finally {
    await disconnectDatabase();
  }
}
