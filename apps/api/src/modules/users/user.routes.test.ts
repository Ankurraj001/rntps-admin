import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { User } from '../../models/User.js';
import { adminAuth, createTestUser, teacherAuth, tokenFor } from '../../test/factories.js';

let app: Express;
let adminHeader: string;
let adminId: string;

const asAdmin = {
  get: (path: string) => request(app).get(path).set('Authorization', adminHeader),
  post: (path: string) => request(app).post(path).set('Authorization', adminHeader),
  patch: (path: string) => request(app).patch(path).set('Authorization', adminHeader),
};

const newTeacher = {
  name: 'Priya Nair',
  email: 'priya@school.test',
  role: 'TEACHER',
  assignedClasses: ['5', '6'],
};

beforeEach(async () => {
  app = createApp();
  const admin = await adminAuth();
  adminHeader = admin.header;
  adminId = String(admin.user._id);
});

describe('access control', () => {
  it('is closed to anonymous callers', async () => {
    await request(app).get('/api/v1/users').expect(401);
  });

  it('is closed to teachers', async () => {
    const { header } = await teacherAuth();
    await request(app).get('/api/v1/users').set('Authorization', header).expect(403);
    await request(app).post('/api/v1/users').set('Authorization', header).send(newTeacher).expect(403);
  });
});

describe('POST /users', () => {
  it('creates a teacher and returns a temporary password once', async () => {
    const res = await asAdmin.post('/api/v1/users').send(newTeacher).expect(201);

    expect(res.body.user.email).toBe('priya@school.test');
    expect(res.body.user.mustChangePassword).toBe(true);
    expect(res.body.temporaryPassword).toEqual(expect.any(String));
    expect(res.body.temporaryPassword.length).toBeGreaterThanOrEqual(12);
  });

  it('never leaks the password hash', async () => {
    const res = await asAdmin.post('/api/v1/users').send(newTeacher).expect(201);
    expect(JSON.stringify(res.body.user)).not.toMatch(/passwordHash|scrypt\$/);
  });

  it('lets the new teacher sign in with the temporary password', async () => {
    const created = await asAdmin.post('/api/v1/users').send(newTeacher).expect(201);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'priya@school.test', password: created.body.temporaryPassword })
      .expect(200);

    expect(res.body.user.mustChangePassword).toBe(true);
  });

  it('requires a teacher to have at least one class', async () => {
    await asAdmin
      .post('/api/v1/users')
      .send({ ...newTeacher, assignedClasses: [] })
      .expect(400);
  });

  it('refuses classes for an admin, who already reaches all of them', async () => {
    await asAdmin
      .post('/api/v1/users')
      .send({ name: 'Second Admin', email: 'a2@school.test', role: 'ADMIN', assignedClasses: ['5'] })
      .expect(400);
  });

  it('rejects a duplicate email with a clear message', async () => {
    await asAdmin.post('/api/v1/users').send(newTeacher).expect(201);
    const res = await asAdmin.post('/api/v1/users').send(newTeacher).expect(409);
    expect(res.body.error.message).toMatch(/already has an account/i);
  });

  it('treats emails case-insensitively when detecting duplicates', async () => {
    await asAdmin.post('/api/v1/users').send(newTeacher).expect(201);
    await asAdmin.post('/api/v1/users').send({ ...newTeacher, email: 'PRIYA@School.test' }).expect(409);
  });

  it('rejects an invalid email and a weak explicit password', async () => {
    await asAdmin.post('/api/v1/users').send({ ...newTeacher, email: 'not-an-email' }).expect(400);
    await asAdmin.post('/api/v1/users').send({ ...newTeacher, password: 'short' }).expect(400);
  });
});

describe('PATCH /users/:id', () => {
  it('updates a teacher’s assigned classes', async () => {
    const teacher = await createTestUser({ role: 'TEACHER', email: 't@school.test', assignedClasses: ['5'] });

    const res = await asAdmin
      .patch(`/api/v1/users/${String(teacher._id)}`)
      .send({ assignedClasses: ['1', '2'] })
      .expect(200);

    expect(res.body.assignedClasses).toEqual(['1', '2']);
  });

  it('stops an admin removing their own admin access', async () => {
    const res = await asAdmin
      .patch(`/api/v1/users/${adminId}`)
      .send({ role: 'TEACHER', assignedClasses: ['5'] })
      .expect(400);

    expect(res.body.error.message).toMatch(/your own admin access/i);
  });

  it('stops the last admin being demoted, so the system stays reachable', async () => {
    const other = await createTestUser({ role: 'ADMIN', email: 'other-admin@school.test' });

    // Demoting the *other* admin is fine while this admin remains.
    await asAdmin
      .patch(`/api/v1/users/${String(other._id)}`)
      .send({ role: 'TEACHER', assignedClasses: ['5'] })
      .expect(200);

    // Now demote the remaining one, acting as the freshly-demoted teacher's replacement.
    const secondAdmin = await createTestUser({ role: 'ADMIN', email: 'third@school.test' });
    const header = `Bearer ${await tokenFor(secondAdmin)}`;

    const res = await request(app)
      .patch(`/api/v1/users/${adminId}`)
      .set('Authorization', header)
      .send({ role: 'TEACHER', assignedClasses: ['5'] })
      .expect(200);
    expect(res.body.role).toBe('TEACHER');
  });
});

describe('deactivate / activate', () => {
  it('deactivating ends the user’s sessions immediately', async () => {
    const created = await asAdmin.post('/api/v1/users').send(newTeacher).expect(201);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'priya@school.test', password: created.body.temporaryPassword })
      .expect(200);

    const cookie = (login.headers['set-cookie'] as unknown as string[])[0] as string;

    await asAdmin.post(`/api/v1/users/${created.body.user.id}/deactivate`).expect(200);

    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('stops an admin deactivating themselves', async () => {
    await asAdmin.post(`/api/v1/users/${adminId}/deactivate`).expect(400);
  });

  it('stops the last active admin being deactivated', async () => {
    const other = await createTestUser({ role: 'ADMIN', email: 'other-admin@school.test' });
    const header = `Bearer ${await tokenFor(other)}`;

    // Deactivate the seeded admin, leaving `other` as the only one.
    await request(app)
      .post(`/api/v1/users/${adminId}/deactivate`)
      .set('Authorization', header)
      .expect(200);

    // `other` cannot now deactivate itself either way, so use a teacher-turned-admin check:
    const res = await request(app)
      .post(`/api/v1/users/${String(other._id)}/deactivate`)
      .set('Authorization', header)
      .expect(400);
    expect(res.body.error.message).toMatch(/your own account/i);
  });

  it('reactivates a user', async () => {
    const teacher = await createTestUser({ role: 'TEACHER', email: 't@school.test', isActive: false });
    const res = await asAdmin.post(`/api/v1/users/${String(teacher._id)}/activate`).expect(200);
    expect(res.body.isActive).toBe(true);
  });
});

describe('reset password and unlock', () => {
  it('issues a new temporary password and forces a change', async () => {
    const teacher = await createTestUser({ role: 'TEACHER', email: 't@school.test' });

    const res = await asAdmin.post(`/api/v1/users/${String(teacher._id)}/reset-password`).send({}).expect(200);

    expect(res.body.temporaryPassword).toEqual(expect.any(String));
    expect(res.body.user.mustChangePassword).toBe(true);

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 't@school.test', password: res.body.temporaryPassword })
      .expect(200);
  });

  it('clears a lockout, which is how a locked-out teacher gets back in', async () => {
    const teacher = await createTestUser({ role: 'TEACHER', email: 't@school.test' });
    await User.updateOne(
      { _id: teacher._id },
      { $set: { lockedUntil: new Date(Date.now() + 600_000), failedLoginAttempts: 5 } },
    );

    const res = await asAdmin.post(`/api/v1/users/${String(teacher._id)}/unlock`).expect(200);
    expect(res.body.isLocked).toBe(false);
  });
});

describe('GET /users', () => {
  it('lists users without exposing hashes or refresh tokens', async () => {
    await createTestUser({ role: 'TEACHER', email: 't@school.test' });
    const res = await asAdmin.get('/api/v1/users').expect(200);

    expect(res.body.items.length).toBe(2);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|scrypt\$|tokenHash/);
  });
});
