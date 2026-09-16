import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { adminAuth, seedSettings } from '../../test/factories.js';

/**
 * Date of birth and admission date are optional.
 *
 * A child can be standing at the desk before the birth certificate is found, and the
 * previous requirement meant the admin either waited or invented a date — so these tests
 * pin that a record saves with neither date, that a supplied date is still validated, and
 * that the two are still ordered against each other whenever both are present.
 */

let app: Express;
let adminHeader: string;

const asAdmin = {
  get: (path: string) => request(app).get(path).set('Authorization', adminHeader),
  post: (path: string) => request(app).post(path).set('Authorization', adminHeader),
  patch: (path: string) => request(app).patch(path).set('Authorization', adminHeader),
};

/** Deliberately carries neither date — that is the case being tested. */
const validBody = {
  fullName: 'Aarav Sharma',
  gender: 'MALE',
  classCode: '5',
  guardians: [{ name: 'Rakesh Sharma', relation: 'FATHER', phone: '9876543210', isPrimary: true }],
};

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('onboarding without dates', () => {
  it('onboards a student with neither date', async () => {
    const res = await asAdmin.post('/api/v1/students').send(validBody).expect(201);

    expect(res.body.studentId).toBe('RNTPS-26-001');
    expect(res.body.dob).toBeNull();
    expect(res.body.admissionDate).toBeNull();
  });

  it('treats a blank date from the form as no date rather than a bad one', async () => {
    const res = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, dob: '', admissionDate: '' })
      .expect(201);

    expect(res.body.dob).toBeNull();
    expect(res.body.admissionDate).toBeNull();
  });

  it('onboards with only a date of birth', async () => {
    const res = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, dob: '2015-06-14' })
      .expect(201);

    expect(res.body.dob).toBe('2015-06-14');
    expect(res.body.admissionDate).toBeNull();
  });

  it('onboards with only an admission date', async () => {
    const res = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, admissionDate: '2026-04-01' })
      .expect(201);

    expect(res.body.dob).toBeNull();
    expect(res.body.admissionDate).toBe('2026-04-01');
  });

  it('still rejects a date that is not a real calendar day', async () => {
    await asAdmin.post('/api/v1/students')
      .send({ ...validBody, dob: '2015-02-31' })
      .expect(400);
  });

  it('still orders the two dates when both are given', async () => {
    const res = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, dob: '2027-01-01', admissionDate: '2026-04-01' })
      .expect(400);

    expect(res.body.error.details).toContainEqual(
      expect.objectContaining({ field: 'dob', message: expect.stringMatching(/before the admission date/i) }),
    );
  });
});

describe('filling the dates in later', () => {
  it('accepts both dates on a record onboarded without them', async () => {
    const created = await asAdmin.post('/api/v1/students').send(validBody).expect(201);

    const res = await asAdmin.patch(`/api/v1/students/${created.body.studentId}`)
      .send({ dob: '2015-06-14', admissionDate: '2026-04-01' })
      .expect(200);

    expect(res.body.dob).toBe('2015-06-14');
    expect(res.body.admissionDate).toBe('2026-04-01');
  });

  it('accepts one date while the other is still unknown', async () => {
    const created = await asAdmin.post('/api/v1/students').send(validBody).expect(201);

    const res = await asAdmin.patch(`/api/v1/students/${created.body.studentId}`)
      .send({ dob: '2015-06-14' })
      .expect(200);

    expect(res.body.dob).toBe('2015-06-14');
    expect(res.body.admissionDate).toBeNull();
  });

  it('still rejects a date of birth that lands after the stored admission date', async () => {
    const created = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, admissionDate: '2026-04-01' })
      .expect(201);

    await asAdmin.patch(`/api/v1/students/${created.body.studentId}`)
      .send({ dob: '2030-01-01' })
      .expect(400);
  });
});

describe('clearing a date entered in error', () => {
  it('clears a stored date of birth', async () => {
    const created = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, dob: '2015-06-14', admissionDate: '2026-04-01' })
      .expect(201);

    const res = await asAdmin.patch(`/api/v1/students/${created.body.studentId}`)
      .send({ dob: '' })
      .expect(200);

    expect(res.body.dob).toBeNull();
    // Clearing one date leaves the other alone.
    expect(res.body.admissionDate).toBe('2026-04-01');
  });

  it('clears a date of birth and moves the admission date earlier in the same edit', async () => {
    const created = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, dob: '2015-06-14', admissionDate: '2026-04-01' })
      .expect(201);

    // The ordering check must read the cleared date as gone, not fall back to the stored
    // 2015 value — which would reject this edit for being before a date of birth that no
    // longer exists.
    const res = await asAdmin.patch(`/api/v1/students/${created.body.studentId}`)
      .send({ dob: '', admissionDate: '2010-01-01' })
      .expect(200);

    expect(res.body.dob).toBeNull();
    expect(res.body.admissionDate).toBe('2010-01-01');
  });

  it('leaves both dates untouched by an edit that says nothing about them', async () => {
    const created = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, dob: '2015-06-14', admissionDate: '2026-04-01' })
      .expect(201);

    const res = await asAdmin.patch(`/api/v1/students/${created.body.studentId}`)
      .send({ rollNo: 7 })
      .expect(200);

    expect(res.body.dob).toBe('2015-06-14');
    expect(res.body.admissionDate).toBe('2026-04-01');
  });
});

describe('students CSV export', () => {
  it('leaves the date cells blank for a student without them', async () => {
    await asAdmin.post('/api/v1/students').send(validBody).expect(201);

    const res = await asAdmin.get('/api/v1/students?format=csv').expect(200);
    const [header, firstRow] = res.text.trim().split('\n');
    const columns = header.split(',');
    const cells = firstRow.split(',');

    expect(cells[columns.indexOf('DOB')]).toBe('');
    expect(cells[columns.indexOf('Admission date')]).toBe('');
  });
});
