import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { adminAuth, seedSettings, studentInput } from '../../test/factories.js';

/**
 * End-to-end proof of how a monthly invoice is calculated, in order:
 *
 *   1. read the student record   — class, transportOpted, transport fare, concession
 *   2. load that class's fee structure for the academic year
 *   3. keep only the heads that apply to this student (transport only if opted in)
 *   4. substitute the student's own transport fare where one is set
 *   5. sum to gross, then subtract the student's concession
 *
 * Dues and one-off charges are deliberately NOT folded into this invoice — they are their
 * own invoices, and the student's total outstanding is the sum across all of them. Adding
 * them as line items here would bill the same money twice, since the original invoice
 * still stands.
 */

let app: Express;
let adminHeader: string;

const YEAR = '2026-27';
const PERIOD = '2026-08';

const as = {
  get: (p: string) => request(app).get(p).set('Authorization', adminHeader),
  post: (p: string) => request(app).post(p).set('Authorization', adminHeader),
  put: (p: string) => request(app).put(p).set('Authorization', adminHeader),
  patch: (p: string) => request(app).patch(p).set('Authorization', adminHeader),
};

const HEADS = [
  { code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_000, appliesTo: 'ALL' },
  { code: 'TRANSPORT', name: 'Transport fee', amountRupees: 500, appliesTo: 'TRANSPORT_OPTED' },
];

async function newStudent(overrides: Record<string, unknown>) {
  const res = await as.post('/api/v1/students').send(studentInput({ classCode: '5', ...overrides })).expect(201);
  return res.body.studentId as string;
}

async function rowFor(studentId: string) {
  const res = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
  return (res.body.rows as { studentId: string }[]).find((r) => r.studentId === studentId) as Record<
    string,
    unknown
  >;
}

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
  await as.put(`/api/v1/fees/structures/5/${YEAR}`).send({ heads: HEADS }).expect(200);
});

describe('transport follows the choice made at onboarding', () => {
  it('bills tuition only when the student did not opt in', async () => {
    const id = await newStudent({ fullName: 'No Bus', transportOpted: false });
    const row = await rowFor(id);

    expect(row.lineItems).toEqual([{ code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_000 }]);
    expect(row).toMatchObject({ grossRupees: 1_000, totalRupees: 1_000, transportOverridden: false });
  });

  it('adds the class transport fee as soon as the box is ticked at onboarding', async () => {
    const id = await newStudent({ fullName: 'Class Default Bus', transportOpted: true });
    const row = await rowFor(id);

    expect(row.lineItems).toEqual([
      { code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_000 },
      { code: 'TRANSPORT', name: 'Transport fee', amountRupees: 500 },
    ]);
    expect(row).toMatchObject({ totalRupees: 1_500, transportOverridden: false });
  });

  it("uses the student's own fare when one is set, keeping the head's name", async () => {
    const id = await newStudent({
      fullName: 'Far Stop',
      transportOpted: true,
      transportFareOverrideRupees: 750,
    });
    const row = await rowFor(id);

    expect(row.lineItems).toEqual([
      { code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_000 },
      { code: 'TRANSPORT', name: 'Transport fee', amountRupees: 750 },
    ]);
    expect(row).toMatchObject({ totalRupees: 1_750, transportOverridden: true });
  });

  it('drops transport entirely when the student opts out, even with a fare on record', async () => {
    const id = await newStudent({
      fullName: 'Fare But No Bus',
      transportOpted: false,
      transportFareOverrideRupees: 750,
    });
    const row = await rowFor(id);

    expect(row.lineItems).toHaveLength(1);
    expect(row).toMatchObject({ totalRupees: 1_000, transportFareIgnored: true });
  });

  it('follows a change made after onboarding', async () => {
    const id = await newStudent({ fullName: 'Changed Mind', transportOpted: false });
    expect(await rowFor(id)).toMatchObject({ totalRupees: 1_000 });

    await as.patch(`/api/v1/students/${id}`).send({ transportOpted: true }).expect(200);
    expect(await rowFor(id)).toMatchObject({ totalRupees: 1_500 });
  });
});

describe('the concession applies last, to the summed total', () => {
  it('takes a percentage off tuition and transport together', async () => {
    const id = await newStudent({
      fullName: 'Staff Child',
      transportOpted: true,
      concession: { type: 'PERCENT', value: 20, reason: 'Staff child' },
    });
    const row = await rowFor(id);

    // (1000 + 500) = 1500 gross, 20% = 300 off, 1200 payable.
    expect(row).toMatchObject({ grossRupees: 1_500, concessionRupees: 300, totalRupees: 1_200 });
  });

  it('applies to the overridden transport fare, not the class default', async () => {
    const id = await newStudent({
      fullName: 'Staff Far Stop',
      transportOpted: true,
      transportFareOverrideRupees: 1_000,
      concession: { type: 'PERCENT', value: 50, reason: 'Staff child' },
    });
    const row = await rowFor(id);

    // Gross uses the student's ₹1,000 fare, not the class's ₹500.
    expect(row).toMatchObject({ grossRupees: 2_000, concessionRupees: 1_000, totalRupees: 1_000 });
  });
});

describe('the committed invoice matches the preview exactly', () => {
  it('writes what the preview showed', async () => {
    const id = await newStudent({
      fullName: 'Committed',
      transportOpted: true,
      transportFareOverrideRupees: 800,
      concession: { type: 'PERCENT', value: 25, reason: 'Sibling' },
    });
    const row = await rowFor(id);
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);

    const invoice = await as.get(`/api/v1/fees/invoices/${id}:${PERIOD}`).expect(200);
    expect(invoice.body).toMatchObject({
      kind: 'MONTHLY',
      lineItems: row.lineItems,
      grossRupees: row.grossRupees,
      concessionRupees: row.concessionRupees,
      totalRupees: row.totalRupees,
    });
    // 1000 + 800 = 1800 gross, 25% = 450 off, 1350 payable.
    expect(invoice.body).toMatchObject({ grossRupees: 1_800, concessionRupees: 450, totalRupees: 1_350 });
  });
});

describe('charges are folded into the one monthly invoice', () => {
  it('produces a single invoice covering fees, transport and charges', async () => {
    const id = await newStudent({ fullName: 'Has Arrears', transportOpted: true });

    await as
      .post(`/api/v1/students/${id}/charges`)
      .send({ name: 'Dues carried forward', amountRupees: 4_000 })
      .expect(201);
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);

    const list = await as.get(`/api/v1/fees/students/${id}/invoices`).expect(200);
    // One invoice for the month, not one per thing owed.
    expect(list.body.items).toHaveLength(1);

    const invoice = list.body.items[0];
    expect(invoice.lineItems.map((l: { name: string; amountRupees: number }) => [l.name, l.amountRupees])).toEqual([
      ['Tuition Fee', 1_000],
      ['Transport fee', 500],
      ['Dues carried forward', 4_000],
    ]);
    expect(invoice.totalRupees).toBe(5_500);

    // The dues report agrees, counting the money once.
    const dues = await as.get('/api/v1/reports/dues').expect(200);
    expect(dues.body.totals.balanceRupees).toBe(5_500);
  });
});
