import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { Invoice } from '../../models/Invoice.js';
import { SETTINGS_ID, Settings } from '../../models/Settings.js';
import { adminAuth, seedSettings, studentInput, teacherAuth } from '../../test/factories.js';
import { createStudent } from '../students/student.service.js';

let app: Express;
let adminHeader: string;

const YEAR = '2026-27';
const PERIOD = '2026-08';

const as = {
  get: (p: string) => request(app).get(p).set('Authorization', adminHeader),
  post: (p: string) => request(app).post(p).set('Authorization', adminHeader),
  put: (p: string) => request(app).put(p).set('Authorization', adminHeader),
};

/** Tuition ₹1,200 for everyone, transport ₹600 only for opted-in students. */
const HEADS = [
  { code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200, appliesTo: 'ALL' },
  { code: 'TRANSPORT', name: 'Transport', amountRupees: 600, appliesTo: 'TRANSPORT_OPTED' },
];

async function setStructure(classCode: string, heads = HEADS) {
  return as.put(`/api/v1/fees/structures/${classCode}/${YEAR}`).send({ heads }).expect(200);
}

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('fee structures', () => {
  it('stores heads keyed by class and year', async () => {
    const res = await setStructure('5');
    expect(res.body.id).toBe(`5:${YEAR}`);
    expect(res.body.monthlyTotalRupees).toBe(1_800);
  });

  it('overwrites rather than duplicating on a second save', async () => {
    await setStructure('5');
    const res = await setStructure('5', [{ ...HEADS[0], amountRupees: 1_500 }] as never);
    expect(res.body.heads).toHaveLength(1);
    expect(res.body.monthlyTotalRupees).toBe(1_500);
  });

  it('rejects duplicate head codes', async () => {
    await as
      .put(`/api/v1/fees/structures/5/${YEAR}`)
      .send({ heads: [HEADS[0], HEADS[0]] })
      .expect(400);
  });

  it('rejects a fractional amount, since money is integer rupees', async () => {
    await as
      .put(`/api/v1/fees/structures/5/${YEAR}`)
      .send({ heads: [{ ...HEADS[0], amountRupees: 1_200.50 }] })
      .expect(400);
  });

  it('clones a year forward without touching classes that already exist', async () => {
    await setStructure('5');
    await setStructure('6');

    const res = await as
      .post('/api/v1/fees/structures/clone')
      .send({ fromAcademicYear: YEAR, toAcademicYear: '2027-28' })
      .expect(200);

    expect(res.body).toEqual({ copied: 2, skipped: 0 });

    const again = await as
      .post('/api/v1/fees/structures/clone')
      .send({ fromAcademicYear: YEAR, toAcademicYear: '2027-28' })
      .expect(200);
    expect(again.body).toEqual({ copied: 0, skipped: 2 });
  });

  it('counts the classes it did copy when some already exist', async () => {
    await setStructure('5');
    await as
      .post('/api/v1/fees/structures/clone')
      .send({ fromAcademicYear: YEAR, toAcademicYear: '2027-28' })
      .expect(200);

    // Class 6 is new, class 5 is already there. An unordered bulk write inserts the one and
    // rejects the other, and the count has to reflect that: reporting "copied 0" for a
    // clone that half worked reads as a failure to whoever ran the rollover.
    await setStructure('6');
    const res = await as
      .post('/api/v1/fees/structures/clone')
      .send({ fromAcademicYear: YEAR, toAcademicYear: '2027-28' })
      .expect(200);

    expect(res.body).toEqual({ copied: 1, skipped: 1 });
    const target = await as.get('/api/v1/fees/structures?academicYear=2027-28').expect(200);
    expect(target.body.items).toHaveLength(2);
  });

  it('is closed to teachers', async () => {
    const { header } = await teacherAuth();
    await request(app).get('/api/v1/fees/structures').set('Authorization', header).expect(403);
    await request(app).get('/api/v1/fees/invoices').set('Authorization', header).expect(403);
  });
});

describe('invoice run', () => {
  it('previews without writing anything', async () => {
    await setStructure('5');
    await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));

    const res = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);

    expect(res.body.totals).toMatchObject({ students: 1, toCreate: 1, alreadyInvoiced: 0, totalRupees: 1_200 });
    expect(res.body.dueDate).toBe('2026-08-10');
    expect(await Invoice.countDocuments()).toBe(0);
  });

  it('bills transport only to students who opted in', async () => {
    await setStructure('5');
    await createStudent(studentInput({ fullName: 'With Bus', classCode: '5', transportOpted: true }));
    await createStudent(studentInput({ fullName: 'No Bus', classCode: '5', transportOpted: false }));

    const res = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    const rows = res.body.rows as { fullName: string; totalRupees: number }[];

    expect(rows.find((r) => r.fullName === 'With Bus')?.totalRupees).toBe(1_800);
    expect(rows.find((r) => r.fullName === 'No Bus')?.totalRupees).toBe(1_200);
  });

  it('applies a percentage concession, rounded to the rupee', async () => {
    await setStructure('5');
    await createStudent(
      studentInput({
        fullName: 'Concession Kid',
        classCode: '5',
        concession: { type: 'PERCENT', value: 33, reason: 'Staff child' },
      }),
    );

    const res = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    // 33% of 120000 = 39600 exactly.
    expect(res.body.rows[0]).toMatchObject({ concessionRupees: 396, totalRupees: 804 });
  });

  it('caps a flat concession at the amount owed, never going negative', async () => {
    await setStructure('5');
    await createStudent(
      studentInput({
        fullName: 'Full Waiver',
        classCode: '5',
        concession: { type: 'FLAT', value: 5_000, reason: 'Full waiver' },
      }),
    );

    const res = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    expect(res.body.rows[0]).toMatchObject({ concessionRupees: 1_200, totalRupees: 0 });
  });

  it('flags classes that have students but no fee structure', async () => {
    await setStructure('5');
    await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
    await createStudent(studentInput({ fullName: 'Unbilled Kid', classCode: '7' }));

    const res = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    expect(res.body.classesWithoutStructure).toEqual(['7']);
    expect(res.body.totals.students).toBe(1);
  });

  it('commits one invoice per student, keyed studentId:period', async () => {
    await setStructure('5');
    const student = await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));

    const res = await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
    expect(res.body).toMatchObject({ created: 1, skipped: 0 });

    expect(await Invoice.findById(`${student.studentId}:${PERIOD}`)).not.toBeNull();
  });

  it('cannot double-bill: a second run for the same period creates nothing', async () => {
    await setStructure('5');
    await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));

    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
    const second = await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);

    expect(second.body.created).toBe(0);
    expect(await Invoice.countDocuments()).toBe(1);
  });

  it('survives two concurrent runs without duplicating', async () => {
    await setStructure('5');
    await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));

    const [a, b] = await Promise.all([
      as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }),
      as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await Invoice.countDocuments()).toBe(1);
  });

  it('bills only the selected classes', async () => {
    await setStructure('5');
    await setStructure('6');
    await createStudent(studentInput({ fullName: 'In Five', classCode: '5' }));
    await createStudent(studentInput({ fullName: 'In Six', classCode: '6' }));

    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD, classCodes: ['5'] }).expect(200);
    expect(await Invoice.countDocuments()).toBe(1);
  });

  it('skips inactive students', async () => {
    await setStructure('5');
    const student = await createStudent(studentInput({ fullName: 'Left School', classCode: '5' }));
    await as.post(`/api/v1/students/${student.studentId}/status`).send({ status: 'TC_ISSUED' }).expect(200);

    const res = await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
    expect(res.body.created).toBe(0);
  });

  it('rejects a malformed period', async () => {
    await as.post('/api/v1/fees/runs/preview').send({ period: '2026-13' }).expect(400);
    await as.post('/api/v1/fees/runs/preview').send({ period: 'August' }).expect(400);
  });

  it('honours the configured due day', async () => {
    await Settings.updateOne({ _id: SETTINGS_ID }, { $set: { feeDueDayOfMonth: 15 } });
    await setStructure('5');
    await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));

    const res = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    expect(res.body.dueDate).toBe('2026-08-15');
  });
});

describe('recording payments', () => {
  let invoiceId: string;

  beforeEach(async () => {
    await setStructure('5');
    const student = await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
    invoiceId = `${student.studentId}:${PERIOD}`;
  });

  const pay = (amountRupees: number, mode = 'CASH') =>
    as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .send({ amountRupees, mode, paidAt: '2026-08-05' });

  it('moves DUE to PARTIAL to PAID', async () => {
    const partial = await pay(500).expect(201);
    expect(partial.body).toMatchObject({ status: 'PARTIAL', paidRupees: 500, balanceRupees: 700 });

    const settled = await pay(700).expect(201);
    expect(settled.body).toMatchObject({ status: 'PAID', paidRupees: 1_200, balanceRupees: 0 });
  });

  it('issues sequential receipt numbers', async () => {
    const first = await pay(100).expect(201);
    const second = await pay(100).expect(201);

    const receipts = second.body.payments.map((p: { receiptNo: string }) => p.receiptNo);
    expect(receipts).toEqual(['RCPT-26-0001', 'RCPT-26-0002']);
    expect(first.body.payments[0].receiptNo).toBe('RCPT-26-0001');
  });

  it('refuses to overpay', async () => {
    const res = await pay(2_000).expect(400);
    expect(res.body.error.message).toMatch(/outstanding balance/i);
  });

  it('refuses a payment on a settled invoice', async () => {
    await pay(1_200).expect(201);
    const res = await pay(1).expect(400);
    expect(res.body.error.message).toMatch(/already settled/i);
  });

  it('rejects a zero or negative amount', async () => {
    await pay(0).expect(400);
    await pay(-500).expect(400);
  });

  it('cannot be overpaid by two concurrent payments', async () => {
    // Each is valid alone; together they exceed the total. The $expr guard must stop one.
    const [a, b] = await Promise.all([pay(700), pay(700)]);
    const statuses = [a.status, b.status].sort();

    expect(statuses[0]).toBe(201);
    expect([400, 409]).toContain(statuses[1]);

    const invoice = await Invoice.findById(invoiceId).lean();
    expect(invoice?.paidRupees).toBeLessThanOrEqual(1_200);
  });

  it('records the mode and reference', async () => {
    const res = await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .send({ amountRupees: 500, mode: 'UPI', reference: 'UPI-9988', paidAt: '2026-08-05' })
      .expect(201);

    expect(res.body.payments[0]).toMatchObject({ mode: 'UPI', reference: 'UPI-9988' });
  });

  it('404s an unknown invoice', async () => {
    await as
      .post('/api/v1/fees/invoices/NOPE:2026-08/payments')
      .send({ amountRupees: 100, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(404);
  });
});

describe('reversing a payment', () => {
  let invoiceId: string;

  beforeEach(async () => {
    await setStructure('5');
    const student = await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
    invoiceId = `${student.studentId}:${PERIOD}`;
  });

  it('restores the balance and keeps the record visible', async () => {
    const paid = await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .send({ amountRupees: 1_200, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);
    expect(paid.body.status).toBe('PAID');

    const receiptNo = paid.body.payments[0].receiptNo;
    const reversed = await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments/${receiptNo}/reverse`)
      .send({ reason: 'Cheque bounced' })
      .expect(200);

    expect(reversed.body).toMatchObject({ status: 'DUE', paidRupees: 0, balanceRupees: 1_200 });
    // The payment is still there, flagged — not deleted.
    expect(reversed.body.payments).toHaveLength(1);
    expect(reversed.body.payments[0]).toMatchObject({ isReversed: true, reversalReason: 'Cheque bounced' });
  });

  it('drops PAID back to PARTIAL when only one of two payments is reversed', async () => {
    for (const amount of [600, 600]) {
      await as
        .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
        .send({ amountRupees: amount, mode: 'CASH', paidAt: '2026-08-05' })
        .expect(201);
    }

    const res = await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments/RCPT-26-0001/reverse`)
      .send({ reason: 'Entered twice' })
      .expect(200);

    expect(res.body).toMatchObject({ status: 'PARTIAL', paidRupees: 600 });
  });

  it('refuses to reverse twice', async () => {
    await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .send({ amountRupees: 100, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);

    await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments/RCPT-26-0001/reverse`)
      .send({ reason: 'First reversal' })
      .expect(200);

    await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments/RCPT-26-0001/reverse`)
      .send({ reason: 'Again' })
      .expect(400);
  });

  it('requires a reason', async () => {
    await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .send({ amountRupees: 100, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);

    await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments/RCPT-26-0001/reverse`)
      .send({ reason: '' })
      .expect(400);
  });

  it('lets a reversed amount be paid again', async () => {
    await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .send({ amountRupees: 1_200, mode: 'CHEQUE', paidAt: '2026-08-05' })
      .expect(201);
    await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments/RCPT-26-0001/reverse`)
      .send({ reason: 'Cheque bounced' })
      .expect(200);

    const again = await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .send({ amountRupees: 1_200, mode: 'CASH', paidAt: '2026-08-08' })
      .expect(201);

    expect(again.body).toMatchObject({ status: 'PAID', paidRupees: 1_200 });
  });
});

describe('voiding an invoice', () => {
  let invoiceId: string;

  beforeEach(async () => {
    await setStructure('5');
    const student = await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
    invoiceId = `${student.studentId}:${PERIOD}`;
  });

  it('voids an unpaid invoice', async () => {
    const res = await as
      .post(`/api/v1/fees/invoices/${invoiceId}/void`)
      .send({ reason: 'Billed in error' })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'VOID', voidReason: 'Billed in error' });
  });

  it('refuses to void an invoice with live payments', async () => {
    await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .send({ amountRupees: 100, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);

    const res = await as
      .post(`/api/v1/fees/invoices/${invoiceId}/void`)
      .send({ reason: 'Billed in error' })
      .expect(400);
    expect(res.body.error.message).toMatch(/reverse the recorded payments/i);
  });

  it('refuses payment on a voided invoice, and it stays void', async () => {
    await as.post(`/api/v1/fees/invoices/${invoiceId}/void`).send({ reason: 'Billed in error' }).expect(200);

    await as
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .send({ amountRupees: 100, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(400);

    const invoice = await as.get(`/api/v1/fees/invoices/${invoiceId}`).expect(200);
    expect(invoice.body.status).toBe('VOID');
  });
});

describe('listing invoices', () => {
  beforeEach(async () => {
    await setStructure('5');
    await setStructure('6');
    await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
    await createStudent(studentInput({ fullName: 'Kabir Singh', classCode: '6' }));
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
  });

  it('filters by class and status', async () => {
    const byClass = await as.get('/api/v1/fees/invoices?classCode=5').expect(200);
    expect(byClass.body.total).toBe(1);

    const due = await as.get('/api/v1/fees/invoices?status=DUE').expect(200);
    expect(due.body.total).toBe(2);
  });

  it('searches by student name', async () => {
    const res = await as.get('/api/v1/fees/invoices?q=kabir').expect(200);
    expect(res.body.items[0].studentName).toBe('Kabir Singh');
  });

  it('marks invoices past their due date as overdue', async () => {
    // Due 2026-08-10; "today" in the test environment is well past it.
    const res = await as.get('/api/v1/fees/invoices?overdueOnly=true').expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items[0].isOverdue).toBe(true);
  });

  it('exposes a student’s invoice history', async () => {
    const list = await as.get('/api/v1/fees/invoices?classCode=5').expect(200);
    const studentId = list.body.items[0].studentId;

    const res = await as.get(`/api/v1/fees/students/${studentId}/invoices`).expect(200);
    expect(res.body.items).toHaveLength(1);
  });
});
