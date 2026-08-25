import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { adminAuth, seedSettings, studentInput } from '../../test/factories.js';

/**
 * The fee slip is the bill handed to a parent: this month's invoice, plus whatever earlier
 * invoices are still unpaid, ending in one figure that clears everything.
 *
 * The property that matters is that showing an older debt never charges it again. Each
 * earlier invoice keeps its own balance, and the school's receivables must not double.
 */

let app: Express;
let adminHeader: string;

const YEAR = '2026-27';

const as = {
  get: (p: string) => request(app).get(p).set('Authorization', adminHeader),
  post: (p: string) => request(app).post(p).set('Authorization', adminHeader),
  put: (p: string) => request(app).put(p).set('Authorization', adminHeader),
};

const slipFor = (id: string) => as.get(`/api/v1/fees/invoices/${encodeURIComponent(id)}/slip`);
const runFor = (period: string) => as.post('/api/v1/fees/runs/commit').send({ period }).expect(200);
const payOn = (id: string, amountRupees: number) =>
  as
    .post(`/api/v1/fees/invoices/${encodeURIComponent(id)}/payments`)
    .send({ amountRupees, mode: 'CASH', paidAt: '2026-08-05' });

async function setup() {
  await as
    .put(`/api/v1/fees/structures/5/${YEAR}`)
    .send({ heads: [{ code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200, appliesTo: 'ALL' }] })
    .expect(200);
  const student = await as.post('/api/v1/students').send(studentInput({ classCode: '5' })).expect(201);
  return student.body.studentId as string;
}

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('GET /fees/invoices/:id/slip', () => {
  it('shows nothing brought forward when there is no older debt', async () => {
    const studentId = await setup();
    await runFor('2026-08');

    const res = await slipFor(`${studentId}:2026-08`).expect(200);
    expect(res.body).toMatchObject({
      previousDues: [],
      previousDuesRupees: 0,
      thisInvoiceBalanceRupees: 1_200,
      totalPayableRupees: 1_200,
    });
  });

  it('brings an unpaid earlier month forward without changing this invoice', async () => {
    const studentId = await setup();
    await runFor('2026-07');
    await runFor('2026-08');

    const res = await slipFor(`${studentId}:2026-08`).expect(200);

    expect(res.body.previousDues).toEqual([
      expect.objectContaining({ period: '2026-07', label: 'Monthly fees', balanceRupees: 1_200 }),
    ]);
    expect(res.body).toMatchObject({
      previousDuesRupees: 1_200,
      thisInvoiceBalanceRupees: 1_200,
      totalPayableRupees: 2_400,
    });

    // August still charges only August — July is shown, not re-billed.
    expect(res.body.invoice).toMatchObject({ totalRupees: 1_200, balanceRupees: 1_200 });
    expect(res.body.invoice.lineItems).toHaveLength(1);
  });

  it('does not inflate the dues report, which is the whole point', async () => {
    const studentId = await setup();
    await runFor('2026-07');
    await runFor('2026-08');

    const slip = await slipFor(`${studentId}:2026-08`).expect(200);
    const dues = await as.get('/api/v1/reports/dues').expect(200);

    // ₹2,400 owed, reported once — not ₹4,800.
    expect(slip.body.totalPayableRupees).toBe(2_400);
    expect(dues.body.totals.balanceRupees).toBe(2_400);
  });

  it('counts only what is still unpaid', async () => {
    const studentId = await setup();
    await runFor('2026-07');
    await runFor('2026-08');
    await payOn(`${studentId}:2026-07`, 500).expect(201);

    const res = await slipFor(`${studentId}:2026-08`).expect(200);
    expect(res.body.previousDuesRupees).toBe(700);
    expect(res.body.totalPayableRupees).toBe(1_900);
  });

  it('drops a settled earlier invoice from the slip entirely', async () => {
    const studentId = await setup();
    await runFor('2026-07');
    await runFor('2026-08');
    await payOn(`${studentId}:2026-07`, 1_200).expect(201);

    const res = await slipFor(`${studentId}:2026-08`).expect(200);
    expect(res.body.previousDues).toEqual([]);
    expect(res.body.totalPayableRupees).toBe(1_200);
  });

  it('ignores a voided earlier invoice', async () => {
    const studentId = await setup();
    await runFor('2026-07');
    await runFor('2026-08');
    await as
      .post(`/api/v1/fees/invoices/${studentId}:2026-07/void`)
      .send({ reason: 'Raised in error' })
      .expect(200);

    const res = await slipFor(`${studentId}:2026-08`).expect(200);
    expect(res.body.previousDues).toEqual([]);
    expect(res.body.totalPayableRupees).toBe(1_200);
  });

  it('owes nothing on a voided invoice, even with arrears outstanding', async () => {
    const studentId = await setup();
    await runFor('2026-07');
    await runFor('2026-08');
    await as
      .post(`/api/v1/fees/invoices/${studentId}:2026-08/void`)
      .send({ reason: 'Billed in error' })
      .expect(200);

    const res = await slipFor(`${studentId}:2026-08`).expect(200);
    expect(res.body.thisInvoiceBalanceRupees).toBe(0);
    expect(res.body.totalPayableRupees).toBe(1_200);
  });

  it('lists several earlier months oldest first', async () => {
    const studentId = await setup();
    for (const period of ['2026-06', '2026-05', '2026-07']) await runFor(period);
    await runFor('2026-08');

    const res = await slipFor(`${studentId}:2026-08`).expect(200);
    expect(res.body.previousDues.map((d: { period: string }) => d.period)).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
    ]);
    expect(res.body.totalPayableRupees).toBe(1_200 * 4);
  });

  it('names a charge absorbed into an earlier invoice through that invoice', async () => {
    const studentId = await setup();
    await as
      .post(`/api/v1/students/${studentId}/charges`)
      .send({ name: 'Dues carried forward', amountRupees: 4_000 })
      .expect(201);
    await runFor('2026-07');
    await runFor('2026-08');

    const res = await slipFor(`${studentId}:2026-08`).expect(200);
    // July's invoice absorbed the arrears, so it is brought forward as one line.
    expect(res.body.previousDues).toEqual([
      expect.objectContaining({ period: '2026-07', balanceRupees: 5_200 }),
    ]);
    expect(res.body.totalPayableRupees).toBe(6_400);
  });

  it('404s an unknown invoice', async () => {
    await slipFor('RNTPS-26-999:2026-08').expect(404);
  });
});
