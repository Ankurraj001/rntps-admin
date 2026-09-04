import { runMonthlyExpenseReport } from '../../apps/api/dist/monthlyExpenseJob.js';

// Netlify's modern function format, like daily-report.mjs — scheduling is documented
// against this shape, and Lambda-compatibility mode is on its way out.
//
// The schedule fires on days 28-31 because cron cannot say "last day of month"; the job
// itself discards the firings that are not month-end.
export default async () => {
  const ok = await runMonthlyExpenseReport();
  return new Response(ok ? 'ok' : 'failed', { status: ok ? 200 : 500 });
};
