import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { User } from '../../models/User.js';
import {
  TEST_PASSWORD,
  cookieHeader,
  createTestUser,
  refreshCookieFrom,
  tokenFor,
} from '../../test/factories.js';

let app: Express;

beforeEach(() => {
  app = createApp();
});

const login = (email: string, password: string) =>
  request(app).post('/api/v1/auth/login').send({ email, password });

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await createTestUser({ email: 'admin@school.test' });
  });

  it('returns an access token and sets the refresh cookie', async () => {
    const res = await login('admin@school.test', TEST_PASSWORD).expect(200);

    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.expiresIn).toBe(900);
    expect(res.body.user.email).toBe('admin@school.test');
    expect(refreshCookieFrom(res)).toBeTruthy();
  });

  it('never returns the password hash or refresh tokens', async () => {
    const res = await login('admin@school.test', TEST_PASSWORD).expect(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/passwordHash|scrypt\$|refreshTokens/);
  });

  it('sets the cookie httpOnly, SameSite=Strict and scoped to the auth path', async () => {
    const res = await login('admin@school.test', TEST_PASSWORD).expect(200);
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [raw]).join(';');

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/i);
  });

  it('accepts the email case-insensitively', async () => {
    await login('ADMIN@School.TEST', TEST_PASSWORD).expect(200);
  });

  it('rejects a wrong password', async () => {
    const res = await login('admin@school.test', 'wrong-password').expect(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('gives an identical error for an unknown email, so accounts cannot be enumerated', async () => {
    const unknown = await login('nobody@school.test', TEST_PASSWORD).expect(401);
    const wrong = await login('admin@school.test', 'wrong-password').expect(401);

    expect(unknown.body).toEqual(wrong.body);
  });

  it('refuses a deactivated account without saying so', async () => {
    await createTestUser({ email: 'gone@school.test', isActive: false });
    const res = await login('gone@school.test', TEST_PASSWORD).expect(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('account lockout', () => {
  beforeEach(async () => {
    await createTestUser({ email: 'admin@school.test' });
  });

  it('locks the account after the configured number of failures', async () => {
    for (let i = 0; i < 5; i += 1) {
      await login('admin@school.test', 'wrong-password').expect(401);
    }

    const res = await login('admin@school.test', TEST_PASSWORD).expect(423);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('rejects the correct password while locked', async () => {
    for (let i = 0; i < 5; i += 1) await login('admin@school.test', 'wrong-password');
    await login('admin@school.test', TEST_PASSWORD).expect(423);
  });

  it('resets the failure count after a successful sign-in', async () => {
    await login('admin@school.test', 'wrong-password').expect(401);
    await login('admin@school.test', 'wrong-password').expect(401);
    await login('admin@school.test', TEST_PASSWORD).expect(200);

    const user = await User.findOne({ email: 'admin@school.test' }).lean();
    expect(user?.failedLoginAttempts).toBe(0);
  });

  it('the lockout lives in the database, so it holds across serverless containers', async () => {
    for (let i = 0; i < 5; i += 1) await login('admin@school.test', 'wrong-password');

    // A different container = a fresh Express app with empty in-memory counters.
    const otherContainer = createApp();
    const res = await request(otherContainer)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@school.test', password: TEST_PASSWORD })
      .expect(423);

    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('POST /auth/refresh', () => {
  async function signIn() {
    await createTestUser({ email: 'admin@school.test' });
    const res = await login('admin@school.test', TEST_PASSWORD).expect(200);
    return refreshCookieFrom(res) as string;
  }

  it('rotates the token and issues a new access token', async () => {
    const first = await signIn();

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader(first))
      .expect(200);

    const second = refreshCookieFrom(res);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('tolerates a concurrent refresh, so two tabs do not sign each other out', async () => {
    const first = await signIn();

    // Both tabs bootstrap with the same cookie before either has the new one.
    const [a, b] = await Promise.all([
      request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(first)),
      request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(first)),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);

    // The session is still alive afterwards.
    const latest = refreshCookieFrom(b) as string;
    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(latest)).expect(200);
  });

  it('revokes the whole family when a rotated token is replayed after the grace window', async () => {
    const first = await signIn();

    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader(first))
      .expect(200);
    const second = refreshCookieFrom(rotated) as string;

    // Push the rotation outside the grace window, so the replay reads as theft rather
    // than as two tabs racing.
    await User.updateOne(
      { email: 'admin@school.test' },
      { $set: { 'refreshTokens.$[t].rotatedAt': new Date(Date.now() - 60_000) } },
      { arrayFilters: [{ 't.rotatedAt': { $ne: null } }] },
    );

    // The stolen original is replayed.
    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(first)).expect(401);

    // The legitimate token is killed too — the correct response to a stolen session.
    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(second)).expect(401);
  });

  it('drops rotated tokens past the retention window, so the array cannot grow unbounded', async () => {
    const first = await signIn();

    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader(first))
      .expect(200);
    const second = refreshCookieFrom(rotated) as string;

    const countTokens = async () => {
      const user = await User.findOne({ email: 'admin@school.test' }).select('+refreshTokens');
      return user?.refreshTokens.length ?? 0;
    };

    // A live token plus the one it replaced, still held as a reuse tripwire.
    expect(await countTokens()).toBe(2);

    // Age the spent entry past the retention window. A tab refreshing every 14 minutes
    // used to accumulate these for the full 14-day token lifetime.
    await User.updateOne(
      { email: 'admin@school.test' },
      { $set: { 'refreshTokens.$[t].rotatedAt': new Date(Date.now() - 25 * 60 * 60 * 1000) } },
      { arrayFilters: [{ 't.rotatedAt': { $ne: null } }] },
    );

    const next = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader(second))
      .expect(200);

    // The stale entry is gone, not merely joined by a third: the new live token and the
    // one it just replaced are all that remain.
    expect(await countTokens()).toBe(2);

    // Pruned means unusable, which it already was.
    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(first)).expect(401);
    // ...and the current chain is untouched by the pruning.
    const latest = refreshCookieFrom(next) as string;
    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(latest)).expect(200);
  });

  it('clears the cookie when the token is rejected', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader('not-a-real-token'))
      .expect(401);

    const raw = res.headers['set-cookie'];
    expect((Array.isArray(raw) ? raw : [raw]).join(';')).toMatch(/rntps_rt=;/);
  });

  it('401s with no cookie at all', async () => {
    await request(app).post('/api/v1/auth/refresh').expect(401);
  });

  it('stops working once the account is deactivated', async () => {
    const token = await signIn();
    await User.updateOne({ email: 'admin@school.test' }, { $set: { isActive: false } });

    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(token)).expect(401);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    await createTestUser({ email: 'admin@school.test' });
    const res = await login('admin@school.test', TEST_PASSWORD).expect(200);
    const token = refreshCookieFrom(res) as string;

    await request(app).post('/api/v1/auth/logout').set('Cookie', cookieHeader(token)).expect(204);
    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(token)).expect(401);
  });

  it('succeeds even without a cookie, so sign-out is never stuck', async () => {
    await request(app).post('/api/v1/auth/logout').expect(204);
  });
});

describe('GET /auth/me', () => {
  it('returns the signed-in user', async () => {
    const user = await createTestUser({ email: 'admin@school.test' });
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${await tokenFor(user)}`)
      .expect(200);

    expect(res.body.email).toBe('admin@school.test');
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  it('401s without a token', async () => {
    await request(app).get('/api/v1/auth/me').expect(401);
  });

  it('401s on a tampered token', async () => {
    const user = await createTestUser();
    const token = await tokenFor(user);
    const tampered = `${token.slice(0, -4)}AAAA`;

    await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${tampered}`).expect(401);
  });

  it('401s on a malformed Authorization header', async () => {
    await request(app).get('/api/v1/auth/me').set('Authorization', 'Basic abc123').expect(401);
  });
});

describe('forced password change', () => {
  it('blocks normal routes until the password is changed', async () => {
    const user = await createTestUser({ mustChangePassword: true });
    const header = `Bearer ${await tokenFor(user)}`;

    const blocked = await request(app).get('/api/v1/students').set('Authorization', header).expect(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // ...but /auth/me must still work, or the app cannot render the change form.
    await request(app).get('/api/v1/auth/me').set('Authorization', header).expect(200);
  });

  it('lets the user through once the password is changed', async () => {
    const user = await createTestUser({ mustChangePassword: true });
    const header = `Bearer ${await tokenFor(user)}`;

    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', header)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-password' })
      .expect(204);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'a-brand-new-password' })
      .expect(200);

    expect(res.body.user.mustChangePassword).toBe(false);
  });
});

describe('POST /auth/change-password', () => {
  it('rejects a wrong current password', async () => {
    const user = await createTestUser();
    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${await tokenFor(user)}`)
      .send({ currentPassword: 'not-it', newPassword: 'a-brand-new-password' })
      .expect(400);
  });

  it('rejects a new password below the minimum length', async () => {
    const user = await createTestUser();
    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${await tokenFor(user)}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'short' })
      .expect(400);
  });

  it('rejects reusing the same password', async () => {
    const user = await createTestUser();
    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${await tokenFor(user)}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD })
      .expect(400);
  });

  it('signs every other session out', async () => {
    const user = await createTestUser({ email: 'admin@school.test' });
    const loginRes = await login('admin@school.test', TEST_PASSWORD).expect(200);
    const refreshToken = refreshCookieFrom(loginRes) as string;

    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${await tokenFor(user)}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-password' })
      .expect(204);

    await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader(refreshToken))
      .expect(401);
  });
});
