import { buildWaLink, renderTemplate } from '@rntps/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { Student } from '../../models/Student.js';
import { adminAuth, seedSettings, studentInput, teacherAuth } from '../../test/factories.js';
import { createStudent } from '../students/student.service.js';

let app: Express;
let adminHeader: string;

const PERIOD = '2026-08';
const HEADS = [{ code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200, appliesTo: 'ALL' }];

const as = {
  get: (p: string) => request(app).get(p).set('Authorization', adminHeader),
  post: (p: string) => request(app).post(p).set('Authorization', adminHeader),
  put: (p: string) => request(app).put(p).set('Authorization', adminHeader),
  patch: (p: string) => request(app).patch(p).set('Authorization', adminHeader),
};

async function billClass(classCode: string) {
  await as.put(`/api/v1/fees/structures/${classCode}/2026-27`).send({ heads: HEADS }).expect(200);
}

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('unit helpers', () => {
  it('builds a wa.me link with digits only and encoded text', () => {
    const link = buildWaLink('919876543210', 'Dear Rakesh,\nFee due: ₹1,800');
    expect(link).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
    // No raw newline, space or plus survives in the URL.
    expect(link).not.toMatch(/[\s+]/);
    expect(decodeURIComponent(link.split('text=')[1] as string)).toContain('Fee due');
  });

  it('strips any punctuation from the phone number', () => {
    expect(buildWaLink('+91 98765-43210', 'hi')).toContain('wa.me/919876543210?');
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(renderTemplate('Hi {{name}}, owe {{amount}}', { name: 'A', amount: '₹5' })).toBe('Hi A, owe ₹5');
    // A broken template should be obvious, not silently blank.
    expect(renderTemplate('Hi {{nope}}', {})).toBe('Hi {{nope}}');
  });
});

describe('POST /notifications', () => {
  it('creates one item per guardian phone with a wa.me link', async () => {
    await billClass('5');
    await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);

    const res = await as.post('/api/v1/notifications').send({ type: 'FEE_DUE', period: PERIOD }).expect(201);

    expect(res.body.totalCount).toBe(1);
    const item = res.body.items[0];
    expect(item.guardianPhone).toBe('919876543210');
    expect(item.totalDueRupees).toBe(1_200);
    expect(item.status).toBe('PENDING');
    expect(item.waLink).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
  });

  it('merges siblings into one message, not one per child', async () => {
    await billClass('5');
    await billClass('2');
    const elder = await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
    await createStudent(
      studentInput({ fullName: 'Ananya Sharma', classCode: '2', siblingOfStudentId: elder.studentId }),
    );
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);

    const res = await as.post('/api/v1/notifications').send({ period: PERIOD }).expect(201);

    // One phone number, one message, both children listed.
    expect(res.body.totalCount).toBe(1);
    const item = res.body.items[0];
    expect(item.students).toHaveLength(2);
    expect(item.totalDueRupees).toBe(2_400);
    expect(item.renderedMessage).toContain('Aarav Sharma');
    expect(item.renderedMessage).toContain('Ananya Sharma');
    expect(item.invoiceIds).toHaveLength(2);
  });

  it('sends separate messages to families with different numbers', async () => {
    await billClass('5');
    await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
    await createStudent(
      studentInput({
        fullName: 'Kabir Singh',
        classCode: '5',
        guardians: [{ name: 'Other Parent', relation: 'MOTHER', phone: '9000000001', isPrimary: true }],
      }),
    );
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);

    const res = await as.post('/api/v1/notifications').send({ period: PERIOD }).expect(201);
    expect(res.body.totalCount).toBe(2);
  });

  it('reports students whose guardians opted out instead of silently dropping them', async () => {
    await billClass('5');
    const student = await createStudent(studentInput({ fullName: 'Opted Out', classCode: '5' }));
    await createStudent(
      studentInput({
        fullName: 'Reachable Kid',
        classCode: '5',
        guardians: [{ name: 'Reachable', relation: 'FATHER', phone: '9000000002', isPrimary: true }],
      }),
    );
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
    await Student.updateOne({ _id: student.studentId }, { $set: { 'guardians.0.whatsappOptOut': true } });

    const res = await as.post('/api/v1/notifications').send({ period: PERIOD }).expect(201);

    expect(res.body.totalCount).toBe(1);
    expect(res.body.unreachable).toHaveLength(1);
    expect(res.body.unreachable[0]).toMatchObject({ fullName: 'Opted Out' });
  });

  it('reflects a part payment in the amount chased', async () => {
    await billClass('5');
    const student = await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${PERIOD}/payments`)
      .send({ amountRupees: 500, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);

    const res = await as.post('/api/v1/notifications').send({ period: PERIOD }).expect(201);
    expect(res.body.items[0].totalDueRupees).toBe(700);
  });

  it('excludes settled invoices', async () => {
    await billClass('5');
    const student = await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${PERIOD}/payments`)
      .send({ amountRupees: 1_200, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);

    const res = await as.post('/api/v1/notifications').send({ period: PERIOD }).expect(400);
    expect(res.body.error.message).toMatch(/no unpaid invoices/i);
  });

  it('honours the minimum due filter', async () => {
    await billClass('5');
    const student = await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
    await as
      .post(`/api/v1/fees/invoices/${student.studentId}:${PERIOD}/payments`)
      .send({ amountRupees: 1_199, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(201);

    // ₹1 outstanding, minimum ₹100 — not worth a message.
    const res = await as.post('/api/v1/notifications').send({ period: PERIOD, minDueRupees: 100 }).expect(400);
    expect(res.body.error.message).toMatch(/minimum amount/i);
  });

  it('filters by class', async () => {
    await billClass('5');
    await billClass('6');
    await createStudent(studentInput({ fullName: 'In Five', classCode: '5' }));
    await createStudent(
      studentInput({
        fullName: 'In Six',
        classCode: '6',
        guardians: [{ name: 'Six Parent', relation: 'FATHER', phone: '9000000003', isPrimary: true }],
      }),
    );
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);

    const res = await as.post('/api/v1/notifications').send({ period: PERIOD, classCodes: ['5'] }).expect(201);
    expect(res.body.totalCount).toBe(1);
    expect(res.body.items[0].students[0].fullName).toBe('In Five');
  });

  it('is closed to teachers', async () => {
    const { header } = await teacherAuth();
    await request(app).post('/api/v1/notifications').set('Authorization', header).send({}).expect(403);
    await request(app).get('/api/v1/notifications').set('Authorization', header).expect(403);
  });
});

describe('resumable queue', () => {
  async function makeBatch() {
    await billClass('5');
    await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
    const res = await as.post('/api/v1/notifications').send({ period: PERIOD }).expect(201);
    return res.body as { id: string; items: { key: string }[] };
  }

  it('records progress so the queue survives a reload', async () => {
    const batch = await makeBatch();
    const key = batch.items[0]?.key as string;

    const opened = await as.patch(`/api/v1/notifications/${batch.id}/items/${key}`).send({ status: 'OPENED' }).expect(200);
    expect(opened.body.items[0].status).toBe('OPENED');

    const sent = await as.patch(`/api/v1/notifications/${batch.id}/items/${key}`).send({ status: 'SENT' }).expect(200);
    expect(sent.body.items[0].status).toBe('SENT');
    expect(sent.body.items[0].sentAt).toEqual(expect.any(String));
    expect(sent.body.sentCount).toBe(1);

    // Re-fetching gives the same progress — this is what makes it resumable.
    const reloaded = await as.get(`/api/v1/notifications/${batch.id}`).expect(200);
    expect(reloaded.body.sentCount).toBe(1);
  });

  it('counts skipped items separately from sent', async () => {
    const batch = await makeBatch();
    const key = batch.items[0]?.key as string;

    const res = await as.patch(`/api/v1/notifications/${batch.id}/items/${key}`).send({ status: 'SKIPPED' }).expect(200);
    expect(res.body).toMatchObject({ sentCount: 0, skippedCount: 1 });
  });

  it('404s an unknown item', async () => {
    const batch = await makeBatch();
    await as.patch(`/api/v1/notifications/${batch.id}/items/919999999999`).send({ status: 'SENT' }).expect(404);
  });

  it('rejects an unknown status', async () => {
    const batch = await makeBatch();
    const key = batch.items[0]?.key as string;
    await as.patch(`/api/v1/notifications/${batch.id}/items/${key}`).send({ status: 'DELIVERED' }).expect(400);
  });

  it('lists previous batches without their items', async () => {
    await makeBatch();
    const res = await as.get('/api/v1/notifications').expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).not.toHaveProperty('items');
  });
});
