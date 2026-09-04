import { lastDayOfPeriod, toDateKey, toPeriod } from '@rntps/shared';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import * as mailer from '../../lib/mailer.js';
import { monthlyExpensesEmail } from '../../lib/mailTemplates.js';
import { AuditLog } from '../../models/AuditLog.js';
import { adminAuth, seedSettings, teacherAuth } from '../../test/factories.js';
import { sendMonthlyExpenseReport } from './expensesMail.js';

let app: Express;
let adminHeader: string;
let sendMail: ReturnType<typeof vi.spyOn>;

const MONTH = '2026-08';
const TO = 'reports@example.test';

async function addExpense(name: string, amountRupees: number, period = MONTH) {
  await request(app)
    .post('/api/v1/expenses')
    .set('Authorization', adminHeader)
    .send({ dateKey: `${period}-05`, name, amountRupees })
    .expect(201);
}

/** The body the report would have sent, as the transport would have received it. */
function sentMail() {
  return sendMail.mock.calls[0]?.[0] as { subject: string; text: string; html: string };
}

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
  sendMail = vi.spyOn(mailer, 'sendMail').mockResolvedValue({ sent: true });
});

describe('sendMonthlyExpenseReport', () => {
  it('lists the month’s expenses with a total', async () => {
    await addExpense('Teacher salary', 15_000);
    await addExpense('Petrol', 800);

    const result = await sendMonthlyExpenseReport({ month: MONTH, to: TO });

    expect(result).toMatchObject({ attempted: true, sent: true, rowCount: 2, totalRupees: 15_800 });
    expect(sentMail().subject).toContain('August 2026');
    expect(sentMail().text).toContain('Teacher salary');
    expect(sentMail().text).toMatch(/Total spent: ₹15,800/);
  });

  it('leaves out another month’s expenses', async () => {
    await addExpense('August petrol', 800, '2026-08');
    await addExpense('September petrol', 900, '2026-09');

    const result = await sendMonthlyExpenseReport({ month: MONTH, to: TO });

    expect(result.totalRupees).toBe(800);
    expect(sentMail().text).not.toContain('September petrol');
  });

  it('sends even when nothing was recorded, so silence is never ambiguous', async () => {
    const result = await sendMonthlyExpenseReport({ month: MONTH, to: TO });

    expect(result).toMatchObject({ attempted: true, sent: true, rowCount: 0 });
    expect(sentMail().text).toContain('No expenses were recorded');
  });

  it('sends nothing, and does not fail, when no recipient is configured', async () => {
    const result = await sendMonthlyExpenseReport({ month: MONTH });

    expect(result.attempted).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('goes to every configured recipient on one email', async () => {
    const both = ['office@example.test', 'accountant@example.test'];

    await sendMonthlyExpenseReport({ month: MONTH, to: both });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({
      to: both,
      idempotencyKey: `monthly-expenses-${MONTH}`,
    });
  });

  it('reports a failed send rather than throwing', async () => {
    sendMail.mockResolvedValue({ sent: false, error: 'smtp refused' });

    const result = await sendMonthlyExpenseReport({ month: MONTH, to: TO });

    expect(result).toMatchObject({ attempted: true, sent: false, error: 'smtp refused' });
  });

  it('defaults to the month that is ending', async () => {
    const thisMonth = toPeriod(toDateKey());
    await addExpense('Petrol', 800, thisMonth);

    const result = await sendMonthlyExpenseReport({ to: TO });

    expect(result.month).toBe(thisMonth);
    expect(result.totalRupees).toBe(800);
  });
});

describe('POST /expenses/email', () => {
  const send = (month: string) =>
    request(app).post('/api/v1/expenses/email').set('Authorization', adminHeader).send({ month });

  // The route takes its recipient from DAILY_REPORT_TO and deliberately offers no way to
  // override it — an endpoint that mailed wherever the caller asked would be an open relay
  // behind an admin login. So the config itself is what the test has to set.
  // vitest.config.ts blanks the variable so a developer's own .env cannot leak in.
  beforeEach(() => {
    env.DAILY_REPORT_TO = [TO];
  });
  afterEach(() => {
    env.DAILY_REPORT_TO = [];
  });

  it('emails the month as it stands right now', async () => {
    await addExpense('Petrol', 800);

    const res = await send(MONTH).expect(200);

    expect(res.body).toMatchObject({ attempted: true, sent: true, rowCount: 1, totalRupees: 800 });
    expect(sentMail().subject).toContain('August 2026');
  });

  it('picks up an expense added a moment earlier, not a cached figure', async () => {
    await send(MONTH).expect(200);
    await addExpense('Petrol', 800);

    const res = await send(MONTH).expect(200);
    expect(res.body.totalRupees).toBe(800);
  });

  it('answers 200 with the reason when the mail could not go out', async () => {
    sendMail.mockResolvedValue({ sent: false, error: 'smtp refused' });

    // Not an error status: the caller needs to tell "refused" from "nobody configured",
    // and a 500 would flatten both into the same red box.
    const res = await send(MONTH).expect(200);
    expect(res.body).toMatchObject({ attempted: true, sent: false, error: 'smtp refused' });
  });

  it('rejects a malformed month', async () => {
    await send('August').expect(400);
  });

  it('is closed to teachers', async () => {
    const teacher = await teacherAuth();
    await request(app)
      .post('/api/v1/expenses/email')
      .set('Authorization', teacher.header)
      .send({ month: MONTH })
      .expect(403);
  });

  it('records who sent what', async () => {
    await addExpense('Petrol', 800);
    await send(MONTH).expect(200);

    const entry = await AuditLog.findOne({ action: 'expense-report.email' }).lean();
    expect(entry).toMatchObject({ entityId: MONTH });
    expect(entry?.after).toMatchObject({ sent: true, rowCount: 1, totalRupees: 800 });
  });
});

/**
 * The schedule fires on the 28th through the 31st because cron cannot say "last day of
 * month"; the job discards the firings that are not month-end. Getting this wrong is
 * invisible until it mails four times in a 31-day month, so the rule is pinned directly.
 */
describe('month-end detection', () => {
  const isLastDay = (dateKey: string) => lastDayOfPeriod(toPeriod(dateKey)) === dateKey;

  it('accepts the last day of long, short and leap months', () => {
    expect(isLastDay('2026-01-31')).toBe(true);
    expect(isLastDay('2026-04-30')).toBe(true);
    expect(isLastDay('2026-02-28')).toBe(true);
    // 2028 is a leap year, so February runs to the 29th.
    expect(isLastDay('2028-02-29')).toBe(true);
  });

  it('rejects the other days the schedule fires on', () => {
    expect(isLastDay('2026-01-28')).toBe(false);
    expect(isLastDay('2026-01-29')).toBe(false);
    expect(isLastDay('2026-01-30')).toBe(false);
    // The 28th is month-end only in a non-leap February.
    expect(isLastDay('2028-02-28')).toBe(false);
    expect(isLastDay('2026-04-31')).toBe(false);
  });
});

describe('monthlyExpensesEmail', () => {
  it('escapes an expense name so it cannot break the markup', () => {
    const body = monthlyExpensesEmail({
      month: MONTH,
      items: [{ dateKey: '2026-08-05', name: '<script>alert("x")</script>', amountRupees: 500 }],
      totalRupees: 500,
      collectedRupees: 900,
    });

    expect(body.html).not.toContain('<script>');
    expect(body.html).toContain('&lt;script&gt;');
  });

  it('names a loss as a loss rather than leaving it to a minus sign', () => {
    const body = monthlyExpensesEmail({
      month: MONTH,
      items: [{ dateKey: '2026-08-05', name: 'Salaries', amountRupees: 10_000 }],
      totalRupees: 10_000,
      collectedRupees: 900,
    });

    expect(body.text).toContain('loss ₹9,100');
    expect(body.text).not.toContain('profit');
  });
});
