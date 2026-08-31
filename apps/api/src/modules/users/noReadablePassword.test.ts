import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { adminAuth, createTestUser, TEST_PASSWORD } from '../../test/factories.js';

/**
 * Guards the removal of the readable-password feature.
 *
 * There used to be a `plaintextPassword` field written on every password change — and on
 * every successful login — plus an admin endpoint that read it back. Both are gone. These
 * tests fail if either returns, including by way of a stray `User.create({...})` that
 * passes the field through.
 *
 * The field is checked through the raw driver on purpose: Mongoose no longer declares it,
 * so a model query would strip it and the assertion would pass no matter what is on disk.
 */

let app: Express;
let adminHeader: string;

beforeEach(async () => {
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

async function rawUser(email: string): Promise<Record<string, unknown> | null> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('not connected');
  return db.collection('users').findOne({ email });
}

describe('the reveal-password endpoint is gone', () => {
  it('404s for an admin', async () => {
    const user = await createTestUser({ role: 'TEACHER', email: 'reveal@school.test' });
    await request(app)
      .get(`/api/v1/users/${String(user._id)}/password`)
      .set('Authorization', adminHeader)
      .expect(404);
  });

  it('is still 401 for an anonymous caller — the router guard runs before route matching', async () => {
    const user = await createTestUser({ role: 'TEACHER', email: 'anon@school.test' });
    await request(app)
      .get(`/api/v1/users/${String(user._id)}/password`)
      .expect(401);
  });
});

describe('no readable password is ever persisted', () => {
  it('is absent after an admin creates a user', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', adminHeader)
      .send({
        name: 'Priya Nair',
        email: 'priya@school.test',
        role: 'TEACHER',
        assignedClasses: ['5'],
      })
      .expect(201);

    const stored = await rawUser('priya@school.test');
    expect(stored).not.toBeNull();
    expect(stored).not.toHaveProperty('plaintextPassword');
    // The one-time handover password is still returned, but only in this response body.
    expect(JSON.stringify(res.body)).not.toMatch(/plaintextPassword/);
  });

  it('is absent after a successful login — the old backfill site', async () => {
    await createTestUser({ role: 'TEACHER', email: 'login@school.test' });

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'login@school.test', password: TEST_PASSWORD })
      .expect(200);

    expect(await rawUser('login@school.test')).not.toHaveProperty('plaintextPassword');
  });

  it('is absent after a user changes their own password', async () => {
    await createTestUser({ role: 'TEACHER', email: 'change@school.test' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'change@school.test', password: TEST_PASSWORD })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'her-own-passphrase' })
      .expect(204);

    expect(await rawUser('change@school.test')).not.toHaveProperty('plaintextPassword');
  });

  it('is absent after an admin resets a password', async () => {
    const user = await createTestUser({ role: 'TEACHER', email: 'reset@school.test' });

    await request(app)
      .post(`/api/v1/users/${String(user._id)}/reset-password`)
      .set('Authorization', adminHeader)
      .send({})
      .expect(200);

    expect(await rawUser('reset@school.test')).not.toHaveProperty('plaintextPassword');
  });

  it('never appears in the users list', async () => {
    await createTestUser({ role: 'TEACHER', email: 'list@school.test' });
    const res = await request(app)
      .get('/api/v1/users')
      .set('Authorization', adminHeader)
      .expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/plaintextPassword/);
  });
});
