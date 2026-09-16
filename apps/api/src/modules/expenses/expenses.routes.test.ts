import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { AuditLog } from '../../models/AuditLog.js';
import { adminAuth, seedSettings, studentInput, teacherAuth } from '../../test/factories.js';
import { createStudent } from '../students/student.service.js';

let app: Express;
let adminHeader: string;

const MONTH = '2026-08';
const HEADS = [{ code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200, appliesTo: 'ALL' }];

const as = {
  get: (p: string) => request(app).get(p).set('Authorization', adminHeader),
  post: (p: string) => request(app).post(p).set('Authorization', adminHeader),
  put: (p: string) => request(app).put(p).set('Authorization', adminHeader),
  del: (p: string) => request(app).delete(p).set('Authorization', adminHeader),
};

async function addExpense(name: string, amountRupees: number, period = MONTH) {
  const res = await as
    .post('/api/v1/expenses')
    .send({ dateKey: `${period}-05`, name, amountRupees })
    .expect(201);
  return res.body as { id: string; dateKey: string; name: string; amountRupees: number };
}

async function addGain(name: string, amountRupees: number, period = MONTH) {
  const res = await as
    .post('/api/v1/expenses')
    .send({ dateKey: `${period}-05`, name, direction: 'INCOME', amountRupees })
    .expect(201);
  return res.body as { id: string; direction: string; amountRupees: number };
}

/** Bills one student for MONTH, so there is something collected to compare against. */
async function billAndInvoice(fullName: string) {
  await as.put('/api/v1/fees/structures/5/2026-27').send({ heads: HEADS }).expect(200);
  const student = await createStudent(studentInput({ fullName, classCode: '5' as never }));
  await as.post('/api/v1/fees/runs/commit').send({ period: MONTH }).expect(200);
  return student;
}

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('POST /expenses', () => {
  it('records an expense and totals it for the month', async () => {
    await addExpense('Teacher salary — Sunita', 15_000);
    await addExpense('Petrol', 800);

    const res = await as.get(`/api/v1/expenses?month=${MONTH}`).expect(200);

    expect(res.body.items).toHaveLength(2);
    expect(res.body.totalRupees).toBe(15_800);
  });

  it('files it under the month its own date falls in', async () => {
    const created = await addExpense('Petrol', 800, '2026-09');

    expect(created.dateKey).toBe('2026-09-05');
    // The month is derived on the server and never sent, so a row cannot claim one month
    // while its date says another.
    const september = await as.get('/api/v1/expenses?month=2026-09').expect(200);
    expect(september.body.items).toHaveLength(1);
  });

  it('refuses a fractional amount rather than rounding it', async () => {
    await as
      .post('/api/v1/expenses')
      .send({ dateKey: '2026-08-05', name: 'Petrol', amountRupees: 800.5 })
      .expect(400);
  });

  it('refuses zero and negative amounts, which Number.isInteger alone would allow', async () => {
    const at = (amountRupees: number) =>
      as.post('/api/v1/expenses').send({ dateKey: '2026-08-05', name: 'Nothing', amountRupees });

    await at(0).expect(400);
    await at(-500).expect(400);
  });

  it('rejects a malformed date', async () => {
    await as
      .post('/api/v1/expenses')
      .send({ dateKey: '2026-8-5', name: 'Petrol', amountRupees: 800 })
      .expect(400);
  });
});

describe('GET /expenses', () => {
  it('shows only the month asked for', async () => {
    await addExpense('August petrol', 800, '2026-08');
    await addExpense('September petrol', 900, '2026-09');

    const august = await as.get('/api/v1/expenses?month=2026-08').expect(200);
    expect(august.body.items).toHaveLength(1);
    expect(august.body.totalRupees).toBe(800);

    const september = await as.get('/api/v1/expenses?month=2026-09').expect(200);
    expect(september.body.totalRupees).toBe(900);
  });

  it('reports what was collected and invoiced in the same month', async () => {
    const student = await billAndInvoice('Aarav Sharma');
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${MONTH}/payments`)
      .send({ amountRupees: 500, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);

    const res = await as.get(`/api/v1/expenses?month=${MONTH}`).expect(200);

    expect(res.body.collectedRupees).toBe(500);
    expect(res.body.invoicedRupees).toBe(1_200);
    expect(res.body.outstanding).toMatchObject({ balanceRupees: 700, students: 1 });
  });

  it('ignores a payment made in another month', async () => {
    const student = await billAndInvoice('Aarav Sharma');
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${MONTH}/payments`)
      .send({ amountRupees: 500, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);

    const res = await as.get('/api/v1/expenses?month=2026-09').expect(200);
    expect(res.body.collectedRupees).toBe(0);
  });

  it('rejects a malformed month', async () => {
    await as.get('/api/v1/expenses?month=August').expect(400);
  });

  it('still shows a row written before expenses carried a date or a direction', async () => {
    // Inserted through the driver rather than the model, because the schema now requires
    // dateKey and defaults direction — this is what a row created before those fields
    // existed actually looks like.
    await mongoose.connection.collection('expenses').insertOne({
      period: MONTH,
      name: 'Legacy petrol',
      amountRupees: 800,
      recordedBy: 'someone',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await as.get(`/api/v1/expenses?month=${MONTH}`).expect(200);

    // Falls back to the first of its month: keeping it in the list and the total matters
    // more than a day nobody recorded, and the 1st is visibly a fallback rather than a
    // plausible-looking guess.
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ dateKey: `${MONTH}-01`, amountRupees: 800 });
    // A missing direction reads as spending, which is all there was when the row was
    // written. Read as income it would move the net by twice its value, in the wrong
    // direction.
    expect(res.body.items[0].direction).toBe('EXPENSE');
    expect(res.body.totalRupees).toBe(800);
    expect(res.body.gainRupees).toBe(0);
  });
});

describe('recorded income', () => {
  it('defaults to an expense when the direction is not sent', async () => {
    const created = await addExpense('Petrol', 800);
    expect(created.direction).toBe('EXPENSE');
  });

  it('keeps income out of the expense total and counts it as money in', async () => {
    const student = await billAndInvoice('Aarav Sharma');
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${MONTH}/payments`)
      .send({ amountRupees: 500, mode: 'CASH', paidAt: `${MONTH}-05` })
      .expect(201);
    await addExpense('Petrol', 800);
    await addGain('SSA grant', 20_000);

    const res = await as.get(`/api/v1/expenses?month=${MONTH}`).expect(200);

    expect(res.body.totalRupees).toBe(800);
    expect(res.body.gainRupees).toBe(20_000);
    expect(res.body.items).toHaveLength(2);
  });

  it('keeps "collected" meaning fees, with the grant in moneyInRupees instead', async () => {
    const student = await billAndInvoice('Aarav Sharma');
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${MONTH}/payments`)
      .send({ amountRupees: 500, mode: 'CASH', paidAt: `${MONTH}-05` })
      .expect(201);
    await addGain('SSA grant', 20_000);

    const res = await as.get(`/api/v1/expenses?month=${MONTH}`).expect(200);

    // The invariant that makes the breakdown real rather than a label: collected is still
    // exactly what the collection report would reconcile against the receipt book, and the
    // whole of the difference is the recorded income.
    expect(res.body.collectedRupees).toBe(500);
    expect(res.body.moneyInRupees).toBe(20_500);
    expect(res.body.moneyInRupees - res.body.collectedRupees).toBe(res.body.gainRupees);
  });

  it('does not let a grant reduce what a family still owes', async () => {
    await billAndInvoice('Aarav Sharma');
    await addGain('SSA grant', 20_000);

    const res = await as.get(`/api/v1/expenses?month=${MONTH}`).expect(200);
    expect(res.body.outstanding).toMatchObject({ balanceRupees: 1_200, students: 1 });
  });

  it('allows an income above the expense ceiling, but not an expense', async () => {
    await as
      .post('/api/v1/expenses')
      .send({ dateKey: `${MONTH}-05`, name: 'Government fund', direction: 'INCOME', amountRupees: 2_000_000 })
      .expect(201);

    await as
      .post('/api/v1/expenses')
      .send({ dateKey: `${MONTH}-05`, name: 'Suspicious salary', amountRupees: 2_000_000 })
      .expect(400);
  });

  it('records the direction in the delete audit trail', async () => {
    const grant = await addGain('SSA grant', 20_000);
    await as.del(`/api/v1/expenses/${grant.id}`).expect(200);

    const log = await AuditLog.findOne({ action: 'expense.delete' }).lean();
    // A hard delete leaves only this line. Without the direction, a ₹20,000 row here is
    // indistinguishable between a salary and a grant.
    expect(log?.before).toMatchObject({ direction: 'INCOME', amountRupees: 20_000 });
  });

  it('is admin-only, like the rest of the ledger', async () => {
    const teacherHeader = (await teacherAuth()).header;
    await request(app)
      .post('/api/v1/expenses')
      .set('Authorization', teacherHeader)
      .send({ dateKey: `${MONTH}-05`, name: 'Donation', direction: 'INCOME', amountRupees: 500 })
      .expect(403);
  });
});

describe('all-time totals', () => {
  it('is null until an expense exists, so a school that has not started is not shown a profit', async () => {
    const student = await billAndInvoice('Aarav Sharma');
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${MONTH}/payments`)
      .send({ amountRupees: 500, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);

    const res = await as.get(`/api/v1/expenses?month=${MONTH}`).expect(200);
    expect(res.body.allTime).toBeNull();
  });

  it('counts collection from before the first expense, which is what makes it all-time', async () => {
    const student = await billAndInvoice('Aarav Sharma');
    // Collected in August, before anyone was recording what the school spent.
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${MONTH}/payments`)
      .send({ amountRupees: 500, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);
    await addExpense('September petrol', 900, '2026-09');

    const res = await as.get('/api/v1/expenses?month=2026-09').expect(200);

    // August's ₹500 is included even though expense tracking only began in September —
    // the figure is all-time on both sides, and this is the asymmetry that inflates it.
    expect(res.body.allTime).toMatchObject({ collectedRupees: 500, expenseRupees: 900 });
  });

  it('sums expenses across every month, whichever month is being viewed', async () => {
    await addExpense('August petrol', 800, '2026-08');
    await addExpense('September petrol', 900, '2026-09');

    const august = await as.get('/api/v1/expenses?month=2026-08').expect(200);
    expect(august.body.allTime).toMatchObject({ expenseRupees: 1_700 });

    const september = await as.get('/api/v1/expenses?month=2026-09').expect(200);
    expect(september.body.allTime).toMatchObject({ expenseRupees: 1_700 });
  });

  it('stays null when only income has been recorded, since there is nothing to offset', async () => {
    const student = await billAndInvoice('Aarav Sharma');
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${MONTH}/payments`)
      .send({ amountRupees: 500, mode: 'CASH', paidAt: `${MONTH}-05` })
      .expect(201);
    await addGain('SSA grant', 20_000);

    // A grant makes the unoffset side larger, not smaller. Opening the gate on it would
    // report a profit consisting of the school's entire fee income plus the grant.
    const res = await as.get(`/api/v1/expenses?month=${MONTH}`).expect(200);
    expect(res.body.allTime).toBeNull();
  });

  it('adds recorded income to money in, on both sides of the month being viewed', async () => {
    await addExpense('August petrol', 800, '2026-08');
    await addGain('September grant', 5_000, '2026-09');

    const res = await as.get('/api/v1/expenses?month=2026-08').expect(200);
    expect(res.body.allTime).toMatchObject({
      collectedRupees: 0,
      gainRupees: 5_000,
      moneyInRupees: 5_000,
      expenseRupees: 800,
    });
  });

  it('leaves a reversed payment out, as every other collected figure does', async () => {
    const student = await billAndInvoice('Aarav Sharma');
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${MONTH}/payments`)
      .send({ amountRupees: 500, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${MONTH}/payments/RCPT-26-0001/reverse`)
      .send({ reason: 'Bounced' })
      .expect(200);
    await addExpense('Petrol', 900);

    const res = await as.get(`/api/v1/expenses?month=${MONTH}`).expect(200);
    expect(res.body.allTime).toMatchObject({ collectedRupees: 0, expenseRupees: 900 });
  });
});

describe('DELETE /expenses/:id', () => {
  it('removes it from the list and the total', async () => {
    const petrol = await addExpense('Petrol', 800);
    await addExpense('Electricity', 600);

    await as.del(`/api/v1/expenses/${petrol.id}`).expect(200);

    const res = await as.get(`/api/v1/expenses?month=${MONTH}`).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.totalRupees).toBe(600);
  });

  it('records the deleted values, since nothing else survives the delete', async () => {
    const petrol = await addExpense('Petrol', 800);

    await as.del(`/api/v1/expenses/${petrol.id}`).expect(200);

    const entry = await AuditLog.findOne({ action: 'expense.delete' }).lean();
    expect(entry?.before).toMatchObject({
      name: 'Petrol',
      amountRupees: 800,
      dateKey: `${MONTH}-05`,
    });
  });

  it('404s for an id that is not there', async () => {
    await as.del('/api/v1/expenses/64b7f9c2e4b0a1a2b3c4d5e6').expect(404);
  });

  it('400s on a malformed id rather than 500ing', async () => {
    await as.del('/api/v1/expenses/not-an-id').expect(400);
  });
});

describe('access', () => {
  it('is closed to teachers on every route', async () => {
    const teacher = await teacherAuth();
    const asTeacher = (r: request.Test) => r.set('Authorization', teacher.header);

    await asTeacher(request(app).get(`/api/v1/expenses?month=${MONTH}`)).expect(403);
    await asTeacher(
      request(app)
        .post('/api/v1/expenses')
        .send({ dateKey: `${MONTH}-05`, name: 'Petrol', amountRupees: 800 }),
    ).expect(403);
    await asTeacher(request(app).delete('/api/v1/expenses/64b7f9c2e4b0a1a2b3c4d5e6')).expect(403);
  });
});
