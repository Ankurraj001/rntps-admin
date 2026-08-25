import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { adminAuth, seedSettings, studentInput, teacherAuth } from '../../test/factories.js';

/**
 * Charges live on the student and are absorbed by the next monthly invoice, so a student
 * never holds more than one invoice for a month.
 *
 * The property that carries the weight: a charge is billed when some non-void invoice
 * carries its id, and that is the *only* record of it being billed. There is no separate
 * flag to fall out of step, so it cannot be billed twice.
 */

let app: Express;
let adminHeader: string;

const YEAR = '2026-27';

const as = {
  get: (p: string) => request(app).get(p).set('Authorization', adminHeader),
  post: (p: string) => request(app).post(p).set('Authorization', adminHeader),
  put: (p: string) => request(app).put(p).set('Authorization', adminHeader),
  del: (p: string) => request(app).delete(p).set('Authorization', adminHeader),
};

async function setTuition(classCode = '5', amountRupees = 1_000) {
  return as
    .put(`/api/v1/fees/structures/${classCode}/${YEAR}`)
    .send({ heads: [{ code: 'TUITION', name: 'Tuition Fee', amountRupees, appliesTo: 'ALL' }] })
    .expect(200);
}

async function newStudent(overrides: Record<string, unknown> = {}) {
  const res = await as.post('/api/v1/students').send(studentInput({ classCode: '5', ...overrides })).expect(201);
  return res.body.studentId as string;
}

const addCharge = (studentId: string, name: string, amountRupees: number) =>
  as.post(`/api/v1/students/${studentId}/charges`).send({ name, amountRupees });

const invoicesOf = (studentId: string) => as.get(`/api/v1/fees/students/${studentId}/invoices`);

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('managing charges on a student', () => {
  it('adds a charge that is pending, not an invoice', async () => {
    const studentId = await newStudent();
    const res = await addCharge(studentId, 'Annual exam fee', 450).expect(201);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      name: 'Annual exam fee',
      amountRupees: 450,
      billedOnInvoiceId: null,
      billedPeriod: null,
    });

    // Crucially: no invoice was created.
    const invoices = await invoicesOf(studentId).expect(200);
    expect(invoices.body.items).toHaveLength(0);
  });

  it('keeps several pending charges in the order they were entered', async () => {
    const studentId = await newStudent();
    await addCharge(studentId, 'First', 100).expect(201);
    await addCharge(studentId, 'Second', 200).expect(201);
    const res = await as.get(`/api/v1/students/${studentId}/charges`).expect(200);

    expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(['First', 'Second']);
  });

  it('removes a charge that has not been billed', async () => {
    const studentId = await newStudent();
    const added = await addCharge(studentId, 'Mistake', 100).expect(201);
    const chargeId = added.body.items[0].id;

    const res = await as.del(`/api/v1/students/${studentId}/charges/${chargeId}`).expect(200);
    expect(res.body.items).toEqual([]);
  });

  it('rejects a zero, negative or fractional amount', async () => {
    const studentId = await newStudent();
    for (const amountRupees of [0, -50, 100.5]) {
      await addCharge(studentId, 'Bad amount', amountRupees).expect(400);
    }
  });

  it('404s an unknown student', async () => {
    await addCharge('RNTPS-26-999', 'Ghost', 100).expect(404);
  });

  it('is closed to teachers, like every other money route', async () => {
    const studentId = await newStudent();
    const { header } = await teacherAuth(['5']);
    await request(app)
      .post(`/api/v1/students/${studentId}/charges`)
      .set('Authorization', header)
      .send({ name: 'Fine', amountRupees: 50 })
      .expect(403);
    await request(app)
      .get(`/api/v1/students/${studentId}/charges`)
      .set('Authorization', header)
      .expect(403);
  });
});

describe('the invoice run absorbs pending charges', () => {
  it('produces one invoice containing fees, transport and charges', async () => {
    await as
      .put(`/api/v1/fees/structures/5/${YEAR}`)
      .send({
        heads: [
          { code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_000, appliesTo: 'ALL' },
          { code: 'TRANSPORT', name: 'Transport fee', amountRupees: 500, appliesTo: 'TRANSPORT_OPTED' },
        ],
      })
      .expect(200);
    const studentId = await newStudent({ transportOpted: true, transportFareOverrideRupees: 700 });
    await addCharge(studentId, 'Dues carried forward', 4_000).expect(201);
    await addCharge(studentId, 'Annual exam fee', 450).expect(201);

    const preview = await as.post('/api/v1/fees/runs/preview').send({ period: '2026-08' }).expect(200);
    expect(preview.body.rows[0]).toMatchObject({ chargeCount: 2, chargeRupees: 4_450, totalRupees: 6_150 });

    await as.post('/api/v1/fees/runs/commit').send({ period: '2026-08' }).expect(200);

    const invoices = await invoicesOf(studentId).expect(200);
    // One invoice for the month, everything on it.
    expect(invoices.body.items).toHaveLength(1);
    const invoice = invoices.body.items[0];
    expect(invoice.lineItems.map((l: { name: string; amountRupees: number }) => [l.name, l.amountRupees])).toEqual([
      ['Tuition Fee', 1_000],
      ['Transport fee', 700],
      ['Dues carried forward', 4_000],
      ['Annual exam fee', 450],
    ]);
    expect(invoice.totalRupees).toBe(6_150);
  });

  it('marks the charges billed and points at the invoice', async () => {
    await setTuition();
    const studentId = await newStudent();
    await addCharge(studentId, 'Picnic', 300).expect(201);
    await as.post('/api/v1/fees/runs/commit').send({ period: '2026-08' }).expect(200);

    const res = await as.get(`/api/v1/students/${studentId}/charges`).expect(200);
    expect(res.body.items[0]).toMatchObject({
      billedOnInvoiceId: `${studentId}:2026-08`,
      billedPeriod: '2026-08',
    });
  });

  it('never bills the same charge twice, across months', async () => {
    await setTuition();
    const studentId = await newStudent();
    await addCharge(studentId, 'Picnic', 300).expect(201);

    await as.post('/api/v1/fees/runs/commit').send({ period: '2026-08' }).expect(200);
    // September: the charge is already on August's invoice and must not reappear.
    const preview = await as.post('/api/v1/fees/runs/preview').send({ period: '2026-09' }).expect(200);
    expect(preview.body.rows[0]).toMatchObject({ chargeCount: 0, totalRupees: 1_000 });

    await as.post('/api/v1/fees/runs/commit').send({ period: '2026-09' }).expect(200);
    const invoices = await invoicesOf(studentId).expect(200);
    const allLines = (invoices.body.items as { lineItems: { name: string }[] }[]).flatMap((i) =>
      i.lineItems.map((l) => l.name),
    );
    expect(allLines.filter((n) => n === 'Picnic')).toHaveLength(1);
  });

  it('carries a charge added after the run into the next month', async () => {
    await setTuition();
    const studentId = await newStudent();
    await as.post('/api/v1/fees/runs/commit').send({ period: '2026-08' }).expect(200);

    // Entered after August was billed.
    await addCharge(studentId, 'Late fine', 50).expect(201);

    // August's invoice is untouched.
    const august = await as.get(`/api/v1/fees/invoices/${studentId}:2026-08`).expect(200);
    expect(august.body.totalRupees).toBe(1_000);

    // September picks it up.
    await as.post('/api/v1/fees/runs/commit').send({ period: '2026-09' }).expect(200);
    const september = await as.get(`/api/v1/fees/invoices/${studentId}:2026-09`).expect(200);
    expect(september.body.totalRupees).toBe(1_050);
    expect(september.body.lineItems.map((l: { name: string }) => l.name)).toContain('Late fine');
  });

  it('refuses to remove a charge once it is billed', async () => {
    await setTuition();
    const studentId = await newStudent();
    const added = await addCharge(studentId, 'Picnic', 300).expect(201);
    const chargeId = added.body.items[0].id;
    await as.post('/api/v1/fees/runs/commit').send({ period: '2026-08' }).expect(200);

    const res = await as.del(`/api/v1/students/${studentId}/charges/${chargeId}`).expect(400);
    expect(res.body.error.message).toContain('already billed');
  });

  it('frees a charge again if its invoice is voided', async () => {
    await setTuition();
    const studentId = await newStudent();
    await addCharge(studentId, 'Picnic', 300).expect(201);
    await as.post('/api/v1/fees/runs/commit').send({ period: '2026-08' }).expect(200);

    await as
      .post(`/api/v1/fees/invoices/${studentId}:2026-08/void`)
      .send({ reason: 'Billed in error' })
      .expect(200);

    // A voided invoice bills nothing, so the charge is owed again and September takes it.
    const charges = await as.get(`/api/v1/students/${studentId}/charges`).expect(200);
    expect(charges.body.items[0].billedOnInvoiceId).toBeNull();

    const preview = await as.post('/api/v1/fees/runs/preview').send({ period: '2026-09' }).expect(200);
    expect(preview.body.rows[0]).toMatchObject({ chargeCount: 1, totalRupees: 1_300 });
  });

  it('applies the concession to fees only, not to charges', async () => {
    await setTuition();
    const studentId = await newStudent({
      concession: { type: 'PERCENT', value: 50, reason: 'Staff child' },
    });
    await addCharge(studentId, 'Picnic', 300).expect(201);

    const preview = await as.post('/api/v1/fees/runs/preview').send({ period: '2026-08' }).expect(200);
    // 50% off the ₹1,000 tuition only. A trip the family signed up for is not discounted,
    // and arrears are already net of whatever concession applied at the time.
    expect(preview.body.rows[0]).toMatchObject({
      grossRupees: 1_300,
      concessionRupees: 500,
      totalRupees: 800,
    });
  });

  it('bills charges even when the class has no fee structure', async () => {
    // Otherwise real money owed would sit unbilled until someone configures the class.
    const studentId = await newStudent({ classCode: '3' });
    await addCharge(studentId, 'Dues carried forward', 2_000).expect(201);

    const preview = await as.post('/api/v1/fees/runs/preview').send({ period: '2026-08' }).expect(200);
    const row = (preview.body.rows as { studentId: string }[]).find((r) => r.studentId === studentId);
    expect(row).toMatchObject({ chargeCount: 1, totalRupees: 2_000 });
    expect(preview.body.classesWithoutStructure).toContain('3');
  });

  it('leaves a student with no charges and no structure out of the run', async () => {
    await newStudent({ classCode: '3' });
    const preview = await as.post('/api/v1/fees/runs/preview').send({ period: '2026-08' }).expect(200);
    expect(preview.body.rows).toHaveLength(0);
    expect(preview.body.classesWithoutStructure).toContain('3');
  });
});
