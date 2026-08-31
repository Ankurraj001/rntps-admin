import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import * as mailer from '../../lib/mailer.js';
import { createTestUser, tokenFor } from '../../test/factories.js';

/**
 * The per-IP limiters, which had no coverage at all because they are disabled under
 * NODE_ENV=test. This file opts back in with RATE_LIMIT_IN_TEST so the limits are actually
 * exercised — including the split between requesting and completing a reset, which used to
 * share one budget.
 *
 * The limiters check this flag per request, so setting it here is enough — no module
 * reloading, which would recompile the Mongoose models.
 */

let app: Express;

beforeAll(() => {
  process.env.RATE_LIMIT_IN_TEST = 'true';
});

afterAll(() => {
  delete process.env.RATE_LIMIT_IN_TEST;
});

/**
 * A distinct client address per test. express-rate-limit keeps counters in memory for the
 * life of the limiter, and the limiters are module-scoped, so without this each test would
 * inherit the previous one's tally.
 */
let clientCounter = 0;
function freshClient(): string {
  clientCounter += 1;
  return `203.0.113.${clientCounter}`;
}

beforeEach(() => {
  app = createApp();
  vi.spyOn(mailer, 'canSendMail').mockReturnValue(true);
  vi.spyOn(mailer, 'sendMail').mockResolvedValue({ sent: true });
});

describe('POST /auth/login', () => {
  it('starts refusing after 10 attempts from one address', async () => {
    const ip = freshClient();
    const attempt = () =>
      request(app)
        .post('/api/v1/auth/login')
        .set('x-nf-client-connection-ip', ip)
        .send({ email: 'nobody@school.test', password: 'wrong-password-here' });

    for (let i = 0; i < 10; i += 1) expect((await attempt()).status).toBe(401);

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('POST /auth/forgot-password', () => {
  it('starts refusing after 5 requests from one address', async () => {
    const ip = freshClient();
    const attempt = () =>
      request(app)
        .post('/api/v1/auth/forgot-password')
        .set('x-nf-client-connection-ip', ip)
        .send({ email: 'teacher@school.test' });

    for (let i = 0; i < 5; i += 1) expect((await attempt()).status).toBe(204);
    expect((await attempt()).status).toBe(429);
  });

  it('does not spend the budget of a different address', async () => {
    const ip = freshClient();
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/v1/auth/forgot-password')
        .set('x-nf-client-connection-ip', ip)
        .send({ email: 'teacher@school.test' })
        .expect(204);
    }

    await request(app)
      .post('/api/v1/auth/forgot-password')
      .set('x-nf-client-connection-ip', freshClient())
      .send({ email: 'teacher@school.test' })
      .expect(204);
  });
});

describe('the reset budget is no longer shared with the request budget', () => {
  it('leaves /reset-password usable after /forgot-password is exhausted', async () => {
    const ip = freshClient();
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/v1/auth/forgot-password')
        .set('x-nf-client-connection-ip', ip)
        .send({ email: 'teacher@school.test' })
        .expect(204);
    }
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .set('x-nf-client-connection-ip', ip)
      .send({ email: 'teacher@school.test' })
      .expect(429);

    // Sharing one limiter, as this used to, meant a user who asked twice could be refused
    // the chance to actually set a password. 400 is the invalid token, not a 429.
    await request(app)
      .post('/api/v1/auth/reset-password')
      .set('x-nf-client-connection-ip', ip)
      .send({ token: 'a'.repeat(43), newPassword: 'a-brand-new-passphrase' })
      .expect(400);
  });
});

describe('POST /auth/change-password', () => {
  it('is throttled, so currentPassword cannot be ground down', async () => {
    const user = await createTestUser({ role: 'TEACHER', email: 'grind@school.test' });
    const header = `Bearer ${await tokenFor(user)}`;
    const ip = freshClient();

    const attempt = () =>
      request(app)
        .post('/api/v1/auth/change-password')
        .set('Authorization', header)
        .set('x-nf-client-connection-ip', ip)
        .send({ currentPassword: 'not-the-real-one', newPassword: 'a-brand-new-passphrase' });

    for (let i = 0; i < 10; i += 1) expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(429);
  });
});
