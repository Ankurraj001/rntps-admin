import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { canSendMail } from '../../lib/mailer.js';
import { User } from '../../models/User.js';
import { createTestUser, seedSettings } from '../../test/factories.js';

/**
 * With no SMTP credentials a reset link cannot be delivered, so the app must not offer
 * self-service reset. It used to accept the request, mint a token and answer 204, leaving
 * the user waiting for an email that was never sent.
 */

let app: Express;

beforeEach(async () => {
  await seedSettings();
  app = createApp();
});

describe('GET /auth/config', () => {
  it('is public — the sign-in screens need it before anyone is authenticated', async () => {
    const res = await request(app).get('/api/v1/auth/config').expect(200);
    expect(res.body).toEqual({
      passwordResetByEmail: canSendMail(),
      passwordResetTtlMinutes: expect.any(Number),
    });
  });

  it('reports reset-by-email as unavailable in this environment', async () => {
    // The suite runs without SMTP credentials, which is also how the school runs today.
    expect(canSendMail()).toBe(false);
    const res = await request(app).get('/api/v1/auth/config').expect(200);
    expect(res.body.passwordResetByEmail).toBe(false);
  });
});

describe('POST /auth/forgot-password with no mail configured', () => {
  it('mints no reset token, so nothing undeliverable is left in the database', async () => {
    const user = await createTestUser({ role: 'TEACHER' });

    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: user.email })
      .expect(204);

    const stored = await User.findById(user._id)
      .select('+passwordResetTokenHash +passwordResetExpiresAt')
      .lean<{ passwordResetTokenHash?: string | null; passwordResetExpiresAt?: Date | null }>();

    expect(stored?.passwordResetTokenHash ?? null).toBeNull();
    expect(stored?.passwordResetExpiresAt ?? null).toBeNull();
  });

  it('still answers the same for an unknown address, revealing nothing', async () => {
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@rntps.test' })
      .expect(204);
  });
});
