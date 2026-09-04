import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import * as mailer from '../../lib/mailer.js';
import { dailyCollectionEmail } from '../../lib/mailTemplates.js';
import { adminAuth, seedSettings, studentInput } from '../../test/factories.js';
import { createStudent } from '../students/student.service.js';
import { sendDailyCollectionReport } from './dailyCollectionMail.js';

let app: Express;
let adminHeader: string;
let sendMail: ReturnType<typeof vi.spyOn>;

const PERIOD = '2026-08';
const DAY = '2026-08-05';
const TO = 'reports@example.test';
const HEADS = [{ code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200, appliesTo: 'ALL' }];

const as = {
  post: (p: string) => request(app).post(p).set('Authorization', adminHeader),
  put: (p: string) => request(app).put(p).set('Authorization', adminHeader),
};

async function billAndInvoice(classCode: string, fullName: string) {
  await as.put(`/api/v1/fees/structures/${classCode}/2026-27`).send({ heads: HEADS }).expect(200);
  const student = await createStudent(studentInput({ fullName, classCode: classCode as never }));
  await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
  return student;
}

async function pay(studentId: string, amountRupees: number, paidAt: string) {
  await as
    .post(`/api/v1/fees/invoices/${studentId}:${PERIOD}/payments`)
    .send({ amountRupees, mode: 'CASH', paidAt })
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

describe('sendDailyCollectionReport', () => {
  it('reports the day’s payments with a total', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    await pay(student.studentId, 500, DAY);

    const result = await sendDailyCollectionReport({ dateKey: DAY, to: TO });

    expect(result).toMatchObject({ attempted: true, sent: true, rowCount: 1, totalRupees: 500 });
    expect(sentMail().subject).toContain('5 Aug 2026');
    expect(sentMail().text).toContain('Aarav Sharma');
    expect(sentMail().text).toMatch(/Total: ₹500/);
  });

  it('leaves out a payment made on another day', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    await pay(student.studentId, 500, '2026-08-04');

    const result = await sendDailyCollectionReport({ dateKey: DAY, to: TO });

    // The cut-off is the point of a *daily* report: yesterday's money was already reported.
    expect(result).toMatchObject({ rowCount: 0, totalRupees: 0 });
    expect(sentMail().subject).toContain('nothing recorded');
  });

  it('lists a reversed receipt but keeps it out of the total', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    await pay(student.studentId, 500, DAY);
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${PERIOD}/payments/RCPT-26-0001/reverse`)
      .send({ reason: 'Bounced' })
      .expect(200);

    const result = await sendDailyCollectionReport({ dateKey: DAY, to: TO });

    // Visible, because the parent is holding that receipt — but not money the school kept.
    expect(result).toMatchObject({ rowCount: 1, totalRupees: 0 });
    expect(sentMail().text).toContain('RCPT-26-0001');
    expect(sentMail().text).toContain('(reversed)');
    expect(sentMail().text).toMatch(/Total: ₹0/);
  });

  it('still sends on a day with no collection at all', async () => {
    const result = await sendDailyCollectionReport({ dateKey: DAY, to: TO });

    // A silent evening cannot be told apart from a job that died three weeks ago.
    expect(result).toMatchObject({ attempted: true, sent: true, rowCount: 0 });
    expect(sentMail().text).toContain('No payments were recorded');
  });

  it('sends nothing, and does not fail, when no recipient is configured', async () => {
    const result = await sendDailyCollectionReport({ dateKey: DAY });

    expect(result.attempted).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('still builds the email with no transport, so it can be read from the log', async () => {
    // sendMail logs the body rather than sending when nothing is configured — outside
    // production that is the delivery, and the only local preview of this table.
    sendMail.mockResolvedValue({ sent: false, error: 'no mail transport configured' });

    const result = await sendDailyCollectionReport({ dateKey: DAY, to: TO });

    expect(result).toMatchObject({ attempted: true, sent: false });
    expect(sentMail().subject).toContain('5 Aug 2026');
  });

  it('puts every configured recipient on one email', async () => {
    const both = ['office@example.test', 'accountant@example.test'];

    await sendDailyCollectionReport({ dateKey: DAY, to: both });

    // One send, not one per address: it stays inside the daily cap, and two people reading
    // the report should be reading the same one.
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({ to: both });
  });

  it('keys idempotency to the day, so a repeated firing is one email', async () => {
    await sendDailyCollectionReport({ dateKey: DAY, to: TO });

    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({
      to: [TO],
      idempotencyKey: `daily-collection-${DAY}`,
    });
  });

  it('reports a failed send rather than throwing', async () => {
    sendMail.mockResolvedValue({ sent: false, error: 'smtp refused' });

    const result = await sendDailyCollectionReport({ dateKey: DAY, to: TO });

    expect(result).toMatchObject({ attempted: true, sent: false, error: 'smtp refused' });
  });
});

describe('dailyCollectionEmail', () => {
  it('escapes a student name so it cannot break the markup', () => {
    const body = dailyCollectionEmail({
      dateKey: DAY,
      rows: [
        {
          receiptNo: 'RCPT-26-0001',
          studentName: '<script>alert("x")</script>',
          classCode: '5',
          mode: 'CASH',
          amountRupees: 500,
          isReversed: false,
        },
      ],
      totals: { count: 1, amountRupees: 500 },
    });

    expect(body.html).not.toContain('<script>');
    expect(body.html).toContain('&lt;script&gt;');
  });
});
