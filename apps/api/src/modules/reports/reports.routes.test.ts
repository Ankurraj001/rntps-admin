import { toDateKey } from '@rntps/shared';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { toCsv } from '../../lib/csv.js';
import {
  A_WORKING_MONDAY,
  adminAuth,
  freezeToWorkingDay,
  seedSettings,
  studentInput,
  teacherAuth,
} from '../../test/factories.js';
import { createStudent } from '../students/student.service.js';

let app: Express;
let adminHeader: string;

const PERIOD = '2026-08';
const HEADS = [{ code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200, appliesTo: 'ALL' }];

const as = {
  get: (p: string) => request(app).get(p).set('Authorization', adminHeader),
  post: (p: string) => request(app).post(p).set('Authorization', adminHeader),
  put: (p: string) => request(app).put(p).set('Authorization', adminHeader),
};

async function billAndInvoice(classCode: string, fullName: string) {
  await as.put(`/api/v1/fees/structures/${classCode}/2026-27`).send({ heads: HEADS }).expect(200);
  const student = await createStudent(studentInput({ fullName, classCode: classCode as never }));
  await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
  return student;
}

/** One bus rider and one walker in the same class, both billed for the same month. */
async function billOneOfEach() {
  await as.put('/api/v1/fees/structures/5/2026-27').send({ heads: HEADS }).expect(200);
  const bus = await createStudent(
    studentInput({ fullName: 'Bus Rider', classCode: '5', transportOpted: true }),
  );
  const walker = await createStudent(studentInput({ fullName: 'Walks To School', classCode: '5' }));
  await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
  return { bus, walker };
}

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('CSV writer', () => {
  it('quotes cells containing commas, quotes and newlines', () => {
    const csv = toCsv(['name', 'note'], [['Sharma, Aarav', 'said "hi"'], ['Plain', 'line1\nline2']]);
    expect(csv).toContain('"Sharma, Aarav"');
    expect(csv).toContain('"said ""hi"""');
    expect(csv).toContain('"line1\nline2"');
  });

  it('uses CRLF line endings and a trailing newline, as Excel expects', () => {
    expect(toCsv(['a'], [['b']])).toBe('a\r\nb\r\n');
  });

  it('renders empty cells for null and undefined', () => {
    expect(toCsv(['a', 'b'], [[null, undefined]])).toBe('a,b\r\n,\r\n');
  });
});

describe('GET /reports/dues', () => {
  it('aggregates a student’s unpaid invoices into one row', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    // A second month for the same student.
    await as.post('/api/v1/fees/runs/commit').send({ period: '2026-09' }).expect(200);

    const res = await as.get('/api/v1/reports/dues').expect(200);

    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      studentId: student.studentId,
      invoiceCount: 2,
      balanceRupees: 2_400,
      oldestDueDate: '2026-08-10',
    });
    expect(res.body.totals.balanceRupees).toBe(2_400);
  });

  it('excludes settled invoices', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${PERIOD}/payments`)
      .send({ amountRupees: 1_200, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);

    const res = await as.get('/api/v1/reports/dues').expect(200);
    expect(res.body.rows).toHaveLength(0);
  });

  it('counts a part payment toward the balance', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${PERIOD}/payments`)
      .send({ amountRupees: 200, mode: 'UPI', paidAt: '2026-08-05' })
      .expect(201);

    const res = await as.get('/api/v1/reports/dues').expect(200);
    expect(res.body.rows[0].balanceRupees).toBe(1_000);
  });

  it('buckets by age from the oldest due date', async () => {
    await billAndInvoice('5', 'Aarav Sharma');
    // Frozen, not left to the wall clock: the bucket is measured from today, so an assertion
    // on "0-30" passes only while the real date happens to be within a month of the due date
    // and starts failing on its own a few weeks later.
    freezeToWorkingDay();
    const res = await as.get('/api/v1/reports/dues').expect(200);

    // Due 2026-08-10, frozen at 2026-08-24, so 14 days overdue.
    expect(res.body.rows[0].bucket).toBe('0-30');
    expect(res.body.totals.aging['0-30']).toBe(1_200);
    vi.useRealTimers();
  });

  it('buckets an old invoice as 60+', async () => {
    await billAndInvoice('5', 'Aarav Sharma');
    // A much older period pushes the due date well past 60 days.
    await as.post('/api/v1/fees/runs/commit').send({ period: '2026-04' }).expect(200);

    const res = await as.get('/api/v1/reports/dues').expect(200);
    expect(res.body.rows[0].oldestDueDate).toBe('2026-04-10');
    expect(res.body.rows[0].bucket).toBe('60+');
  });

  it('reports an invoice not yet due separately from an overdue one', async () => {
    await billAndInvoice('5', 'Aarav Sharma');
    // A future month is billed but not yet payable.
    await as.post('/api/v1/fees/runs/commit').send({ period: '2027-01' }).expect(200);

    const res = await as.get('/api/v1/reports/dues?period=2027-01').expect(200);
    expect(res.body.rows[0].bucket).toBe('not-due');
    expect(res.body.totals.aging['not-due']).toBe(1_200);
  });

  it('filters by class', async () => {
    await billAndInvoice('5', 'In Five');
    await as.put('/api/v1/fees/structures/6/2026-27').send({ heads: HEADS }).expect(200);
    await createStudent(studentInput({ fullName: 'In Six', classCode: '6' }));
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);

    const res = await as.get('/api/v1/reports/dues?classCode=6').expect(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].studentName).toBe('IN SIX');
  });

  it('narrows to students on school transport, and to everyone when unchecked', async () => {
    await billOneOfEach();

    const filtered = await as.get('/api/v1/reports/dues?transportOnly=true').expect(200);
    expect(filtered.body.rows.map((row: { studentName: string }) => row.studentName)).toEqual(['BUS RIDER']);
    expect(filtered.body.totals.balanceRupees).toBe(1_200);

    // Off is the default, and the default must not hide anyone.
    const all = await as.get('/api/v1/reports/dues').expect(200);
    expect(all.body.rows).toHaveLength(2);
  });

  it('exports CSV with a BOM and an attachment header', async () => {
    await billAndInvoice('5', 'Aarav Sharma');
    const res = await as.get('/api/v1/reports/dues?format=csv').expect(200);

    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="dues-/);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain('AARAV SHARMA');
    // Money is a bare integer, not a formatted currency string — Excel must see a number.
    expect(res.text).toContain(',1200,');
  });

  it('is admin-only', async () => {
    const { header } = await teacherAuth();
    await request(app).get('/api/v1/reports/dues').set('Authorization', header).expect(403);
  });
});

describe('GET /reports/collection', () => {
  it('lists payments received in the range, grouped by mode', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    const invoice = `${student.studentId}:${PERIOD}`;

    await as.post(`/api/v1/fees/invoices/${invoice}/payments`).send({ amountRupees: 500, mode: 'CASH', paidAt: '2026-08-05' }).expect(201);
    await as.post(`/api/v1/fees/invoices/${invoice}/payments`).send({ amountRupees: 300, mode: 'UPI', paidAt: '2026-08-06' }).expect(201);

    const res = await as.get('/api/v1/reports/collection?from=2026-08-01&to=2026-08-31').expect(200);

    expect(res.body.totals).toMatchObject({ count: 2, amountRupees: 800 });
    expect(res.body.totals.byMode).toEqual({ CASH: 500, UPI: 300 });
  });

  it('excludes payments outside the range', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${PERIOD}/payments`)
      .send({ amountRupees: 500, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);

    const res = await as.get('/api/v1/reports/collection?from=2026-09-01&to=2026-09-30').expect(200);
    expect(res.body.totals.count).toBe(0);
  });

  it('lists the newest receipt first', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    const invoice = `${student.studentId}:${PERIOD}`;

    await as.post(`/api/v1/fees/invoices/${invoice}/payments`).send({ amountRupees: 100, mode: 'CASH', paidAt: '2026-08-03' }).expect(201);
    await as.post(`/api/v1/fees/invoices/${invoice}/payments`).send({ amountRupees: 200, mode: 'CASH', paidAt: '2026-08-20' }).expect(201);
    await as.post(`/api/v1/fees/invoices/${invoice}/payments`).send({ amountRupees: 300, mode: 'CASH', paidAt: '2026-08-11' }).expect(201);

    const res = await as.get('/api/v1/reports/collection?from=2026-08-01&to=2026-08-31').expect(200);

    // The receipts an admin needs are the ones just taken, not the oldest in the range.
    expect(res.body.rows.map((row: { paidAt: string }) => row.paidAt)).toEqual([
      '2026-08-20',
      '2026-08-11',
      '2026-08-03',
    ]);
  });

  it('lists a reversed payment but keeps it out of the totals', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    const invoice = `${student.studentId}:${PERIOD}`;

    await as.post(`/api/v1/fees/invoices/${invoice}/payments`).send({ amountRupees: 500, mode: 'CHEQUE', paidAt: '2026-08-05' }).expect(201);
    await as.post(`/api/v1/fees/invoices/${invoice}/payments/RCPT-26-0001/reverse`).send({ reason: 'Bounced' }).expect(200);

    const res = await as.get('/api/v1/reports/collection?from=2026-08-01&to=2026-08-31').expect(200);

    // A bounced cheque must not inflate the day's collection...
    expect(res.body.totals).toMatchObject({ count: 0, amountRupees: 0, reversedCount: 1, reversedRupees: 500 });
    expect(res.body.totals.byMode).toEqual({});
    // ...but the receipt was handed to a parent, so it cannot vanish from the record either.
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      receiptNo: 'RCPT-26-0001',
      amountRupees: 500,
      isReversed: true,
      reversalReason: 'Bounced',
    });
    expect(res.body.rows[0].reversedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reports what was kept alongside what was reversed', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    const invoice = `${student.studentId}:${PERIOD}`;

    await as.post(`/api/v1/fees/invoices/${invoice}/payments`).send({ amountRupees: 500, mode: 'CHEQUE', paidAt: '2026-08-05' }).expect(201);
    await as.post(`/api/v1/fees/invoices/${invoice}/payments/RCPT-26-0001/reverse`).send({ reason: 'Bounced' }).expect(200);
    await as.post(`/api/v1/fees/invoices/${invoice}/payments`).send({ amountRupees: 500, mode: 'CASH', paidAt: '2026-08-06' }).expect(201);

    const res = await as.get('/api/v1/reports/collection?from=2026-08-01&to=2026-08-31').expect(200);

    expect(res.body.rows).toHaveLength(2);
    // `count` explains `amountRupees`: one receipt kept, ₹500, all of it cash.
    expect(res.body.totals).toMatchObject({ count: 1, amountRupees: 500, reversedCount: 1, reversedRupees: 500 });
    expect(res.body.totals.byMode).toEqual({ CASH: 500 });
  });

  it('marks a reversal in the CSV so a summed column cannot count it', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    const invoice = `${student.studentId}:${PERIOD}`;

    await as.post(`/api/v1/fees/invoices/${invoice}/payments`).send({ amountRupees: 500, mode: 'CHEQUE', paidAt: '2026-08-05' }).expect(201);
    await as.post(`/api/v1/fees/invoices/${invoice}/payments/RCPT-26-0001/reverse`).send({ reason: 'Bounced' }).expect(200);

    const res = await as.get('/api/v1/reports/collection?from=2026-08-01&to=2026-08-31&format=csv').expect(200);

    expect(res.text).toContain('Status');
    expect(res.text).toContain('Reversed');
    expect(res.text).toContain('Bounced');
  });

  it('keeps a reversal out of the dashboard collection figure', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    const invoice = `${student.studentId}:${PERIOD}`;
    const today = new Date().toISOString().slice(0, 10);

    await as.post(`/api/v1/fees/invoices/${invoice}/payments`).send({ amountRupees: 500, mode: 'CHEQUE', paidAt: today }).expect(201);
    await as.post(`/api/v1/fees/invoices/${invoice}/payments/RCPT-26-0001/reverse`).send({ reason: 'Bounced' }).expect(200);

    // The dashboard reads the same totals, so listing reversals must not have leaked one in.
    const res = await as.get('/api/v1/reports/dashboard').expect(200);
    expect(res.body.month.collectedRupees).toBe(0);
  });

  it('narrows receipts to students on school transport, and to everyone when unchecked', async () => {
    const { bus, walker } = await billOneOfEach();

    await as
      .post(`/api/v1/fees/invoices/${bus.studentId}:${PERIOD}/payments`)
      .send({ amountRupees: 500, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);
    await as
      .post(`/api/v1/fees/invoices/${walker.studentId}:${PERIOD}/payments`)
      .send({ amountRupees: 300, mode: 'UPI', paidAt: '2026-08-06' })
      .expect(201);

    const filtered = await as
      .get('/api/v1/reports/collection?from=2026-08-01&to=2026-08-31&transportOnly=true')
      .expect(200);
    expect(filtered.body.rows.map((row: { studentName: string }) => row.studentName)).toEqual(['BUS RIDER']);
    // Totals follow the filter, otherwise the card above the table contradicts it.
    expect(filtered.body.totals).toMatchObject({ count: 1, amountRupees: 500 });
    expect(filtered.body.totals.byMode).toEqual({ CASH: 500 });

    const all = await as.get('/api/v1/reports/collection?from=2026-08-01&to=2026-08-31').expect(200);
    expect(all.body.totals).toMatchObject({ count: 2, amountRupees: 800 });
  });

  it('requires both dates', async () => {
    await as.get('/api/v1/reports/collection?from=2026-08-01').expect(400);
  });

  it('exports CSV', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${PERIOD}/payments`)
      .send({ amountRupees: 500, mode: 'CASH', paidAt: '2026-08-05', reference: 'REF-1' })
      .expect(201);

    const res = await as.get('/api/v1/reports/collection?from=2026-08-01&to=2026-08-31&format=csv').expect(200);
    expect(res.text).toContain('RCPT-26-0001');
    expect(res.text).toContain(',500');
  });
});

describe('GET /reports/dashboard', () => {
  // The dashboard has no date parameter — it always reports on `toDateKey()`, and on a
  // holiday it correctly finds nothing marked and nothing unmarked. The clock is pinned
  // around the request only, never around the seeding above it.
  afterEach(() => vi.useRealTimers());

  it('summarises students, attendance, collection and dues in one call', async () => {
    const student = await billAndInvoice('5', 'Aarav Sharma');
    await request(app)
      .put('/api/v1/attendance/roster')
      .set('Authorization', adminHeader)
      .send({
        classCode: '5',
        dateKey: A_WORKING_MONDAY,
        marks: [{ studentId: student.studentId, status: 'PRESENT' }],
      })
      .expect(200);

    freezeToWorkingDay();
    const res = await as.get('/api/v1/reports/dashboard').expect(200);

    expect(res.body.activeStudents).toBe(1);
    expect(res.body.studentsByClass).toEqual([{ classCode: '5', count: 1 }]);
    expect(res.body.today).toMatchObject({ marked: 1, present: 1, percentage: 100, unmarkedClasses: [] });
    expect(res.body.outstanding.balanceRupees).toBe(1_200);
  });

  it('lists classes with nothing marked today', async () => {
    await createStudent(studentInput({ fullName: 'Unmarked Kid', classCode: '7' }));

    freezeToWorkingDay();
    const res = await as.get('/api/v1/reports/dashboard').expect(200);
    expect(res.body.today.unmarkedClasses).toEqual(['7']);
  });

  it('says nothing is unmarked on a declared school holiday', async () => {
    await createStudent(studentInput({ fullName: 'Unmarked Kid', classCode: '7' }));
    await as.post('/api/v1/attendance/holiday').send({ dateKey: A_WORKING_MONDAY, label: 'Diwali' }).expect(200);

    freezeToWorkingDay();
    const res = await as.get('/api/v1/reports/dashboard').expect(200);

    expect(res.body.today.unmarkedClasses).toEqual([]);
    expect(res.body.today.holiday).toEqual({ dateKey: A_WORKING_MONDAY, label: 'Diwali' });
  });

  it('counts students with no reachable WhatsApp guardian', async () => {
    await createStudent(
      studentInput({
        fullName: 'No WhatsApp',
        classCode: '5',
        guardians: [
          { name: 'Opted Out', relation: 'FATHER', phone: '9000000009', isPrimary: true, whatsappOptOut: true },
        ],
      }),
    );
    const res = await as.get('/api/v1/reports/dashboard').expect(200);
    expect(res.body.studentsWithoutWhatsapp).toBe(1);
  });

  it('is readable by a teacher, since it drives their own dashboard', async () => {
    const { header } = await teacherAuth();
    await request(app).get('/api/v1/reports/dashboard').set('Authorization', header).expect(200);
  });

  it("carries what the school spent and took in, for an admin", async () => {
    await request(app)
      .post('/api/v1/expenses')
      .set('Authorization', adminHeader)
      .send({ dateKey: toDateKey(), name: 'Petrol', amountRupees: 800 })
      .expect(201);
    await request(app)
      .post('/api/v1/expenses')
      .set('Authorization', adminHeader)
      .send({ dateKey: toDateKey(), name: 'SSA grant', direction: 'INCOME', amountRupees: 5_000 })
      .expect(201);

    const res = await as.get('/api/v1/reports/dashboard').expect(200);
    expect(res.body.finance).toMatchObject({
      expenseRupees: 800,
      gainRupees: 5_000,
      moneyInRupees: 5_000,
      netRupees: 4_200,
    });
  });

  it('withholds them from a teacher, rather than leaving the UI to hide them', async () => {
    await request(app)
      .post('/api/v1/expenses')
      .set('Authorization', adminHeader)
      .send({ dateKey: toDateKey(), name: 'Teacher salary', amountRupees: 15_000 })
      .expect(201);

    const { header } = await teacherAuth();
    const res = await request(app)
      .get('/api/v1/reports/dashboard')
      .set('Authorization', header)
      .expect(200);

    // Every /expenses route is admin-only; a teacher reading the payroll off the one report
    // they are allowed to read would go straight round that.
    expect(res.body.finance).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('15000');
  });
});
