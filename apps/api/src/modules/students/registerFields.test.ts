import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { Student } from '../../models/Student.js';
import { adminAuth, seedSettings } from '../../test/factories.js';

/**
 * Religion and category are register fields: free text, never required, and blank on every
 * student who was on the roll before they existed. These tests pin all three properties,
 * since the whole point of the fields is that the school can record whatever its paperwork
 * says without the app having an opinion on the list of valid answers.
 */

let app: Express;
let adminHeader: string;

const asAdmin = {
  get: (path: string) => request(app).get(path).set('Authorization', adminHeader),
  post: (path: string) => request(app).post(path).set('Authorization', adminHeader),
  patch: (path: string) => request(app).patch(path).set('Authorization', adminHeader),
};

const validBody = {
  fullName: 'Aarav Sharma',
  dob: '2015-06-14',
  gender: 'MALE',
  classCode: '5',
  admissionDate: '2026-04-01',
  guardians: [{ name: 'Rakesh Sharma', relation: 'FATHER', phone: '9876543210', isPrimary: true }],
};

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('religion and category', () => {
  it('onboards a student without them', async () => {
    const res = await asAdmin.post('/api/v1/students').send(validBody).expect(201);

    expect(res.body.religion).toBe('');
    expect(res.body.category).toBe('');
  });

  it('accepts any text and stores it upper case', async () => {
    const res = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, religion: '  hindu ', category: 'obc' })
      .expect(201);

    expect(res.body.religion).toBe('HINDU');
    expect(res.body.category).toBe('OBC');
  });

  it('accepts a value outside the usual list rather than rejecting it', async () => {
    const res = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, religion: 'Zoroastrian', category: 'EWS (state quota)' })
      .expect(201);

    expect(res.body.religion).toBe('ZOROASTRIAN');
    expect(res.body.category).toBe('EWS (STATE QUOTA)');
  });

  it('reports them as blank for a student stored before the fields existed', async () => {
    const created = await asAdmin.post('/api/v1/students').send(validBody).expect(201);
    // What a production record looks like: the keys are simply absent, not null.
    await Student.collection.updateOne(
      { _id: created.body.studentId },
      { $unset: { religion: '', category: '' } },
    );

    const res = await asAdmin.get(`/api/v1/students/${created.body.studentId}`).expect(200);
    expect(res.body.religion).toBe('');
    expect(res.body.category).toBe('');
  });

  it('lets an admin fill them in on an existing record, and clear them again', async () => {
    const created = await asAdmin.post('/api/v1/students').send(validBody).expect(201);

    const filled = await asAdmin.patch(`/api/v1/students/${created.body.studentId}`)
      .send({ religion: 'Muslim', category: 'General' })
      .expect(200);
    expect(filled.body.religion).toBe('MUSLIM');
    expect(filled.body.category).toBe('GENERAL');

    // A blank input is a real value — it means "remove what was recorded" — and it must
    // not be mistaken for "leave it alone" the way an omitted key is.
    const cleared = await asAdmin.patch(`/api/v1/students/${created.body.studentId}`)
      .send({ religion: '', category: '' })
      .expect(200);
    expect(cleared.body.religion).toBe('');
    expect(cleared.body.category).toBe('');
  });

  it('leaves them untouched by an edit that says nothing about them', async () => {
    const created = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, religion: 'Sikh', category: 'OBC' })
      .expect(201);

    const res = await asAdmin.patch(`/api/v1/students/${created.body.studentId}`)
      .send({ rollNo: 7 })
      .expect(200);

    expect(res.body.religion).toBe('SIKH');
    expect(res.body.category).toBe('OBC');
  });

  it('rejects a value longer than the register column', async () => {
    await asAdmin.post('/api/v1/students')
      .send({ ...validBody, category: 'X'.repeat(41) })
      .expect(400);
  });
});

describe('students CSV export', () => {
  it('includes the two register columns', async () => {
    await asAdmin.post('/api/v1/students')
      .send({ ...validBody, religion: 'Hindu', category: 'SC' })
      .expect(201);

    const res = await asAdmin.get('/api/v1/students?format=csv').expect(200);
    const [header, firstRow] = res.text.trim().split('\n');

    expect(header).toContain('Religion');
    expect(header).toContain('Category');
    expect(firstRow).toContain('HINDU');
    expect(firstRow).toContain('SC');
  });
});
