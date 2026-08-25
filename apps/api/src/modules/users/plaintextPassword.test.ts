import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { AuditLog } from '../../models/AuditLog.js';
import { User } from '../../models/User.js';
import { adminAuth, createTestUser, teacherAuth } from '../../test/factories.js';
import * as plaintext from '../../lib/plaintextPassword.js';

let app: Express;
let adminHeader: string;

const newTeacher = {
  name: 'Priya Nair',
  email: 'priya@school.test',
  role: 'TEACHER',
  assignedClasses: ['5'],
};

/**
 * The flag is env-driven, so it is stubbed rather than set through the environment —
 * that keeps both the on and off behaviour testable in one run.
 */
function enablePlaintext(on: boolean): void {
  vi.spyOn(plaintext, 'isPlaintextStorageEnabled').mockReturnValue(on);
  vi.spyOn(plaintext, 'plaintextFieldFor').mockImplementation((password: string) => ({
    plaintextPassword: on ? password : null,
  }));
}

beforeEach(async () => {
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('when readable passwords are switched off (the default)', () => {
  beforeEach(() => enablePlaintext(false));

  it('stores no readable copy when a user is created', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', adminHeader)
      .send(newTeacher)
      .expect(201);

    const stored = await User.findById(res.body.user.id).select('+plaintextPassword').lean();
    expect(stored?.plaintextPassword).toBeNull();
  });

  it('refuses to reveal, and says what to do instead', async () => {
    const teacher = await createTestUser({ role: 'TEACHER', email: 't@school.test' });
    const res = await request(app)
      .get(`/api/v1/users/${String(teacher._id)}/password`)
      .set('Authorization', adminHeader)
      .expect(409);

    expect(res.body.error.code).toBe('PLAINTEXT_DISABLED');
    expect(res.body.error.message).toMatch(/use Reset/i);
  });
});

describe('when readable passwords are switched on', () => {
  beforeEach(() => enablePlaintext(true));

  it('records the temporary password of a newly created user', async () => {
    const created = await request(app)
      .post('/api/v1/users')
      .set('Authorization', adminHeader)
      .send(newTeacher)
      .expect(201);

    const res = await request(app)
      .get(`/api/v1/users/${created.body.user.id}/password`)
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.password).toBe(created.body.temporaryPassword);
  });

  it('the revealed password actually works for signing in', async () => {
    const created = await request(app)
      .post('/api/v1/users')
      .set('Authorization', adminHeader)
      .send(newTeacher)
      .expect(201);

    const revealed = await request(app)
      .get(`/api/v1/users/${created.body.user.id}/password`)
      .set('Authorization', adminHeader)
      .expect(200);

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'priya@school.test', password: revealed.body.password })
      .expect(200);
  });

  it('tracks the password through a reset', async () => {
    const created = await request(app)
      .post('/api/v1/users')
      .set('Authorization', adminHeader)
      .send(newTeacher)
      .expect(201);

    const reset = await request(app)
      .post(`/api/v1/users/${created.body.user.id}/reset-password`)
      .set('Authorization', adminHeader)
      .send({})
      .expect(200);

    const revealed = await request(app)
      .get(`/api/v1/users/${created.body.user.id}/password`)
      .set('Authorization', adminHeader)
      .expect(200);

    expect(revealed.body.password).toBe(reset.body.temporaryPassword);
    expect(revealed.body.password).not.toBe(created.body.temporaryPassword);
  });

  it('tracks the password after the user changes it themselves', async () => {
    const created = await request(app)
      .post('/api/v1/users')
      .set('Authorization', adminHeader)
      .send(newTeacher)
      .expect(201);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'priya@school.test', password: created.body.temporaryPassword })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ currentPassword: created.body.temporaryPassword, newPassword: 'her-own-passphrase' })
      .expect(204);

    const revealed = await request(app)
      .get(`/api/v1/users/${created.body.user.id}/password`)
      .set('Authorization', adminHeader)
      .expect(200);

    expect(revealed.body.password).toBe('her-own-passphrase');
  });

  it('is closed to teachers', async () => {
    const target = await createTestUser({ role: 'TEACHER', email: 't@school.test' });
    const { header } = await teacherAuth();

    await request(app)
      .get(`/api/v1/users/${String(target._id)}/password`)
      .set('Authorization', header)
      .expect(403);
  });

  it('is closed to anonymous callers', async () => {
    const target = await createTestUser({ role: 'TEACHER', email: 't@school.test' });
    await request(app).get(`/api/v1/users/${String(target._id)}/password`).expect(401);
  });

  it('never appears in the users list or any other response', async () => {
    await request(app).post('/api/v1/users').set('Authorization', adminHeader).send(newTeacher).expect(201);

    const list = await request(app).get('/api/v1/users').set('Authorization', adminHeader).expect(200);
    // Reading a password must require the dedicated endpoint, not a list fetch.
    expect(JSON.stringify(list.body)).not.toMatch(/plaintextPassword/);
  });

  it('audits who read whose password, without recording the password', async () => {
    const created = await request(app)
      .post('/api/v1/users')
      .set('Authorization', adminHeader)
      .send(newTeacher)
      .expect(201);

    await request(app)
      .get(`/api/v1/users/${created.body.user.id}/password`)
      .set('Authorization', adminHeader)
      .expect(200);

    const entry = await AuditLog.findOne({ action: 'user.password-viewed' }).lean();
    expect(entry).not.toBeNull();
    expect(entry?.entityId).toBe(created.body.user.id);
    expect(JSON.stringify(entry)).not.toContain(created.body.temporaryPassword);
  });

  it('explains itself for an account whose password predates the setting', async () => {
    const teacher = await createTestUser({ role: 'TEACHER', email: 'old@school.test' });
    await User.updateOne({ _id: teacher._id }, { $set: { plaintextPassword: null } });

    const res = await request(app)
      .get(`/api/v1/users/${String(teacher._id)}/password`)
      .set('Authorization', adminHeader)
      .expect(409);

    expect(res.body.error.code).toBe('NO_PLAINTEXT_STORED');
    expect(res.body.error.message).toMatch(/use Reset/i);
  });

  it('still authenticates against the hash, not the readable copy', async () => {
    const created = await request(app)
      .post('/api/v1/users')
      .set('Authorization', adminHeader)
      .send(newTeacher)
      .expect(201);

    // Corrupt only the readable copy. Login must be unaffected.
    await User.updateOne({ _id: created.body.user.id }, { $set: { plaintextPassword: 'not-the-password' } });

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'priya@school.test', password: created.body.temporaryPassword })
      .expect(200);
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'priya@school.test', password: 'not-the-password' })
      .expect(401);
  });
});
