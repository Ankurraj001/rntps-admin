import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { User } from '../../models/User.js';
import { TEST_PASSWORD, cookieHeader, createTestUser, refreshCookieFrom } from '../../test/factories.js';
import * as mailer from '../../lib/mailer.js';

let app: Express;
let sendMail: ReturnType<typeof vi.spyOn>;

/** Pulls the token out of the emailed link, the way a user clicking it would. */
function tokenFromLastEmail(): string {
  const body = String(sendMail.mock.calls.at(-1)?.[0]?.text ?? '');
  const match = /reset-password\?token=([^\s&]+)/.exec(body);
  if (!match) throw new Error(`No reset link in email body: ${body}`);
  return decodeURIComponent(match[1] as string);
}

beforeEach(async () => {
  app = createApp();
  // This file exercises the flow as it behaves with SMTP configured; the no-SMTP path is
  // covered in passwordResetOff.test.ts.
  vi.spyOn(mailer, 'canSendMail').mockReturnValue(true);
  sendMail = vi.spyOn(mailer, 'sendMail').mockResolvedValue({ sent: true });
  await createTestUser({ email: 'teacher@school.test', role: 'TEACHER', assignedClasses: ['5'] });
});

describe('POST /auth/forgot-password', () => {
  it('emails a reset link to a known address', async () => {
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'teacher@school.test' })
      .expect(204);

    expect(sendMail).toHaveBeenCalledOnce();
    const mail = sendMail.mock.calls[0]?.[0] as mailer.Mail;
    expect(mail.to).toBe('teacher@school.test');
    expect(mail.text).toMatch(/reset-password\?token=/);
    expect(mail.subject).toMatch(/reset/i);
  });

  it('returns the same 204 for an unknown address, so accounts cannot be enumerated', async () => {
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@school.test' })
      .expect(204);

    expect(sendMail).not.toHaveBeenCalled();
  });

  it('does not let a deactivated account recover itself', async () => {
    await createTestUser({ email: 'gone@school.test', isActive: false });
    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'gone@school.test' }).expect(204);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('accepts the email case-insensitively', async () => {
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'Teacher@School.TEST' })
      .expect(204);
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('rejects a malformed address', async () => {
    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'not-an-email' }).expect(400);
  });

  it('stores only a hash of the token, never the token itself', async () => {
    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'teacher@school.test' }).expect(204);
    const token = tokenFromLastEmail();

    const stored = await User.findOne({ email: 'teacher@school.test' })
      .select('+passwordResetTokenHash')
      .lean();

    expect(stored?.passwordResetTokenHash).toEqual(expect.any(String));
    expect(stored?.passwordResetTokenHash).not.toBe(token);
    // SHA-256 hex.
    expect(stored?.passwordResetTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never exposes the reset token through the API', async () => {
    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'teacher@school.test' }).expect(204);

    const admin = await createTestUser({ email: 'admin2@school.test', role: 'ADMIN' });
    const { signAccessToken } = await import('../../lib/tokens.js');
    const header = `Bearer ${await signAccessToken({ sub: String(admin._id), role: 'ADMIN', classes: [], mustChangePassword: false })}`;

    const res = await request(app).get('/api/v1/users').set('Authorization', header).expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordResetTokenHash|passwordResetExpiresAt/);
  });
});

describe('POST /auth/reset-password', () => {
  async function requestReset(email = 'teacher@school.test'): Promise<string> {
    await request(app).post('/api/v1/auth/forgot-password').send({ email }).expect(204);
    return tokenFromLastEmail();
  }

  it('sets a new password the user can sign in with', async () => {
    const token = await requestReset();

    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'brand-new-passphrase' })
      .expect(204);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'teacher@school.test', password: 'brand-new-passphrase' })
      .expect(200);

    // The user chose it, so they are not forced to change it again.
    expect(res.body.user.mustChangePassword).toBe(false);
  });

  it('invalidates the old password', async () => {
    const token = await requestReset();
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'brand-new-passphrase' })
      .expect(204);

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'teacher@school.test', password: TEST_PASSWORD })
      .expect(401);
  });

  it('is single use', async () => {
    const token = await requestReset();
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'brand-new-passphrase' })
      .expect(204);

    const second = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'another-passphrase-x' })
      .expect(400);
    expect(second.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('rejects an expired token and clears it', async () => {
    const token = await requestReset();
    await User.updateOne(
      { email: 'teacher@school.test' },
      { $set: { passwordResetExpiresAt: new Date(Date.now() - 1000) } },
    );

    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'brand-new-passphrase' })
      .expect(400);

    const stored = await User.findOne({ email: 'teacher@school.test' })
      .select('+passwordResetTokenHash')
      .lean();
    // Cleared, so a leaked expired link cannot be probed repeatedly.
    expect(stored?.passwordResetTokenHash).toBeNull();
  });

  it('rejects a forged token', async () => {
    await requestReset();
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'a'.repeat(43), newPassword: 'brand-new-passphrase' })
      .expect(400);
  });

  it('enforces the password policy', async () => {
    const token = await requestReset();
    await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'short' }).expect(400);
  });

  it('signs every existing session out', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'teacher@school.test', password: TEST_PASSWORD })
      .expect(200);
    const refresh = refreshCookieFrom(login) as string;

    const token = await requestReset();
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'brand-new-passphrase' })
      .expect(204);

    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(refresh)).expect(401);
  });

  it('clears a lockout, so a locked-out user can recover unaided', async () => {
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'teacher@school.test', password: 'wrong' })
        .expect(401);
    }
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'teacher@school.test', password: TEST_PASSWORD })
      .expect(423);

    const token = await requestReset();
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'brand-new-passphrase' })
      .expect(204);

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'teacher@school.test', password: 'brand-new-passphrase' })
      .expect(200);
  });

  it('a second request supersedes the first token', async () => {
    const first = await requestReset();
    const second = await requestReset();
    expect(second).not.toBe(first);

    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: first, newPassword: 'brand-new-passphrase' })
      .expect(400);
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: second, newPassword: 'brand-new-passphrase' })
      .expect(204);
  });
});
