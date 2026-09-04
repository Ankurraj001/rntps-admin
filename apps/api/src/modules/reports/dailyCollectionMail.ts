import { toDateKey } from '@rntps/shared';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { sendMail } from '../../lib/mailer.js';
import { dailyCollectionEmail } from '../../lib/mailTemplates.js';
import { getCollectionReport } from './reports.service.js';

export interface DailyCollectionMailResult {
  /** False when the report is switched off or undeliverable, so nothing was even queried. */
  attempted: boolean;
  sent: boolean;
  error?: string;
  dateKey: string;
  rowCount: number;
  totalRupees: number;
}

/**
 * Emails one day's collection to whoever `DAILY_REPORT_TO` names.
 *
 * Sends **even when nothing was collected**. A silent evening is ambiguous — "nobody paid
 * today" and "the scheduled job died three weeks ago" look identical from an empty inbox —
 * so a zero is stated rather than implied, and the email arriving at all is the proof that
 * the schedule is still alive.
 *
 * Never throws: it is called from a scheduled function where the only audience for an
 * exception is a log nobody reads, and where a rejected promise risks a platform retry and
 * a duplicate email.
 */
export async function sendDailyCollectionReport(
  options: { dateKey?: string; to?: string | string[] } = {},
): Promise<DailyCollectionMailResult> {
  const dateKey = options.dateKey ?? toDateKey();
  const configured = options.to ?? env.DAILY_REPORT_TO;
  // Everyone named goes on one email rather than getting their own: a single send stays
  // inside any daily cap, and a report read by two people should be the same report.
  const to = (Array.isArray(configured) ? configured : [configured]).filter(Boolean);

  // The only guard, and it comes before the query: with nobody to send to, reading a day's
  // collection off the database is work done for no one.
  //
  // Deliberately does NOT also guard on canSendMail(). With no transport configured
  // sendMail logs the whole body instead — which outside production is not a failure but
  // the documented way to read an email locally, and the only way to preview this table
  // without credentials. Short-circuiting here would make that unreachable.
  if (to.length === 0) {
    logger.info('DAILY_REPORT_TO is not set — daily collection report is off');
    return { attempted: false, sent: false, dateKey, rowCount: 0, totalRupees: 0 };
  }

  const report = await getCollectionReport(dateKey, dateKey);
  const result = await sendMail({
    to,
    ...dailyCollectionEmail({ dateKey, rows: report.rows, totals: report.totals }),
    // Keyed to the day rather than the run, so a scheduler that fires twice for the same
    // date does not mail twice. Honoured by Resend only — the SMTP path ignores it, so on
    // Brevo this is insurance that pays out only if the transport ever changes.
    idempotencyKey: `daily-collection-${dateKey}`,
  });

  const outcome: DailyCollectionMailResult = {
    attempted: true,
    sent: result.sent,
    ...(result.error ? { error: result.error } : {}),
    dateKey,
    rowCount: report.rows.length,
    totalRupees: report.totals.amountRupees,
  };

  if (result.sent) logger.info(outcome, 'daily collection report sent');
  else logger.error(outcome, 'daily collection report could not be sent');

  return outcome;
}
