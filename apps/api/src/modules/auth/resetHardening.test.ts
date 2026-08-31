import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import * as mailer from '../../lib/mailer.js';
import { User } from '../../models/User.js';
import { TEST_PASSWORD, createTestUser, tokenFor } from '../../test/factories.js';

/**
 * The failure modes that survived the original reset implementation: a token left live by
 * an email that never arrived, a token left live by a password change, and an unbounded
 * number of reset emails aimed at one inbox.
 */

let app: Express;
let sendMail: ReturnType<typeof vi.spyOn>;

function tokenFromLastEmail(): string {
  const body = String(sendMail.mock.calls.at(-1)?.[0]?.text ?? '');
  const match = /reset-password\?token=([^\s&]+)/.exec(body);
  if (!match) throw new Error(`No reset link in email body: ${body}`);
  return decodeURIComponent(match[1] as string);
}

async function pendingToken(email: string): Promise<string | null> {
  const user = await User.findOne({ email }).select('+passwordResetTokenHash');
  return user?.passwordResetTokenHash ?? null;
}

beforeEach(async () => {
  app = createApp();
  vi.spyOn(mailer, 'canSendMail').mockReturnValue(true);
  sendMail = vi.spyOn(mailer, 'sendMail').mockResolvedValue({ sent: true });
  await createTestUser({ email: 'teacher@school.test', role: 'TEACHER', assignedClasses: ['5'] });
});

describe('a failed send does not leave a live token', () => {
  it('withdraws the token when the transport reports failure', async () => {
    sendMail.mockResolvedValue({ sent: false, error: 'mailbox unavailable' });

    // Still 204: distinguishing this would tell the caller the account exists.
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'teacher@school.test' })
      .expect(204);

    expect(await pendingToken('teacher@school.test')).toBeNull();
  });

  it('leaves the token in place when the send succeeds', async () => {
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'teacher@school.test' })
      .expect(204);

    expect(await pendingToken('teacher@school.test')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('changing a password kills any link in flight', () => {
  it('a self-service change invalidates an outstanding reset link', async () => {
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'teacher@school.test' })
      .expect(204);
    const stolenToken = tokenFromLastEmail();

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'teacher@school.test', password: TEST_PASSWORD })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-passphrase' })
      .expect(204);

    expect(await pendingToken('teacher@school.test')).toBeNull();
    // Without this, whoever requested the reset keeps a way in for the rest of the TTL.
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: stolenToken, newPassword: 'attacker-chosen-passphrase' })
      .expect(400);
  });

  it('an admin reset invalidates an outstanding reset link', async () => {
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'teacher@school.test' })
      .expect(204);
    const stolenToken = tokenFromLastEmail();

    const admin = await createTestUser({ role: 'ADMIN', email: 'boss@school.test' });
    const target = await User.findOne({ email: 'teacher@school.test' });

    await request(app)
      .post(`/api/v1/users/${String(target?._id)}/reset-password`)
      .set('Authorization', `Bearer ${await tokenFor(admin)}`)
      .send({ password: 'admin-set-passphrase' })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: stolenToken, newPassword: 'attacker-chosen-passphrase' })
      .expect(400);
  });
});

describe('per-account send throttle', () => {
  it('stops sending after three links inside the window', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'teacher@school.test' })
        .expect(204);
    }
    expect(sendMail).toHaveBeenCalledTimes(3);

    // Fourth request still answers 204 — silence is what keeps it from being an oracle —
    // but no further mail goes out.
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'teacher@school.test' })
      .expect(204);
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  it('does not throttle a different account', async () => {
    await createTestUser({ email: 'other@school.test', role: 'TEACHER', assignedClasses: ['6'] });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'teacher@school.test' })
        .expect(204);
    }
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'other@school.test' })
      .expect(204);

    expect(sendMail).toHaveBeenCalledTimes(4);
  });

  it('clears the counter once a reset completes, so a user is not locked out by their own attempts', async () => {
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'teacher@school.test' })
      .expect(204);

    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: tokenFromLastEmail(), newPassword: 'a-brand-new-passphrase' })
      .expect(204);

    const user = await User.findOne({ email: 'teacher@school.test' }).select(
      '+passwordResetRequestCount +passwordResetRequestedAt',
    );
    expect(user?.passwordResetRequestCount).toBe(0);
    expect(user?.passwordResetRequestedAt).toBeNull();
  });
});

describe('the reset link records its purpose', () => {
  it('marks a self-service reset as such, not as an invitation', async () => {
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'teacher@school.test' })
      .expect(204);

    const user = await User.findOne({ email: 'teacher@school.test' }).select('+passwordResetPurpose');
    expect(user?.passwordResetPurpose).toBe('reset');

    const body = String(sendMail.mock.calls.at(-1)?.[0]?.text ?? '');
    expect(body).toMatch(/mode=reset/);
  });
});
