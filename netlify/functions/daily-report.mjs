import { runDailyReport } from '../../apps/api/dist/dailyReportJob.js';

// Netlify's modern function format, unlike the classic `handler` export in api.mjs, which
// only stays classic because serverless-http needs the Lambda event shape. Scheduling is
// documented against this format, and Lambda-compatibility mode is on its way out.
//
// The schedule itself lives in netlify.toml, beside the rest of the deploy config.
export default async () => {
  const ok = await runDailyReport();
  // Nothing reads this body — a scheduled function has no caller. The status is for the
  // function log, so a failed send is visible without opening the log lines themselves.
  return new Response(ok ? 'ok' : 'failed', { status: ok ? 200 : 500 });
};
