import { toDateKey, toPeriod } from '@rntps/shared';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { sendMail } from '../../lib/mailer.js';
import { monthlyExpensesEmail } from '../../lib/mailTemplates.js';
import { getMonth } from './expenses.service.js';

export interface MonthlyExpenseMailResult {
  /** False when the report is switched off, so nothing was even queried. */
  attempted: boolean;
  sent: boolean;
  error?: string;
  month: string;
  rowCount: number;
  totalRupees: number;
}

/**
 * Emails one month's expenses to whoever `DAILY_REPORT_TO` names — the same list as the
 * daily collection report, because it is the same office asking both questions.
 *
 * Sends **even when nothing was recorded**, on the same reasoning as the daily report: an
 * empty inbox cannot distinguish "we spent nothing" from "the job has been dead since
 * March", and the email arriving at all is the proof the schedule still runs.
 *
 * Never throws — it is called from a scheduled function, where a rejected promise buys
 * nothing but a platform retry and a duplicate email.
 */
export async function sendMonthlyExpenseReport(
  options: { month?: string; to?: string | string[] } = {},
): Promise<MonthlyExpenseMailResult> {
  const month = options.month ?? toPeriod(toDateKey());
  const configured = options.to ?? env.DAILY_REPORT_TO;
  const to = (Array.isArray(configured) ? configured : [configured]).filter(Boolean);

  if (to.length === 0) {
    logger.info('DAILY_REPORT_TO is not set — monthly expense report is off');
    return { attempted: false, sent: false, month, rowCount: 0, totalRupees: 0 };
  }

  // The same function the Expenses tab reads, so the email and the screen cannot disagree.
  const report = await getMonth(month);
  const result = await sendMail({
    to,
    ...monthlyExpensesEmail({
      month,
      items: report.items,
      totalRupees: report.totalRupees,
      collectedRupees: report.collectedRupees,
    }),
    // Keyed to the month, so a scheduler firing twice on the same date does not mail twice.
    // Honoured by Resend only; the SMTP path ignores it, so on Brevo this pays out only if
    // the transport ever changes.
    idempotencyKey: `monthly-expenses-${month}`,
  });

  const outcome: MonthlyExpenseMailResult = {
    attempted: true,
    sent: result.sent,
    ...(result.error ? { error: result.error } : {}),
    month,
    rowCount: report.items.length,
    totalRupees: report.totalRupees,
  };

  if (result.sent) logger.info(outcome, 'monthly expense report sent');
  else logger.error(outcome, 'monthly expense report could not be sent');

  return outcome;
}
