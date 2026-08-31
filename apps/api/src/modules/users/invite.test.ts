import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import * as mailer from '../../lib/mailer.js';
import { User } from '../../models/User.js';
import { adminAuth, createTestUser } from '../../test/factories.js';

/**
 * Account handover by emailed link.
 *
 * The property worth protecting: when mail works, no password for a new account exists
 * anywhere an admin can read it. The temporary-password path still has to survive, though,
 * because it is the only way to onboard someone when mail is down.
 */

let app: Express;
let adminHeader: string;
let sendMail: ReturnType<typeof vi.spyOn>;

const newTeacher = {
  name: 'Priya Nair',
  email: 'priya@school.test',
  role: 'TEACHER',
  assignedClasses: ['5'],
};

/** Pulls the token out of the emailed link, the way a user clicking it would. */
function linkFromLastEmail(): { token: string; mode: string | null } {
  const body = String(sendMail.mock.calls.at(-1)?.[0]?.text ?? '');
  const match = /reset-password\?token=([^\s&]+)(?:&mode=([^\s&]+))?/.exec(body);
  if (!match) throw new Error(`No setup link in email body: ${body}`);
  return { token: decodeURIComponent(match[1] as string), mode: match[2] ?? null };
}

beforeEach(async () => {
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('with mail available', () => {
  beforeEach(() => {
    vi.spyOn(mailer, 'canSendMail').mockReturnValue(true);
    sendMail = vi.spyOn(mailer, 'sendMail').mockResolvedValue({ sent: true });
  });

  it('emails a setup link instead of returning a password', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', adminHeader)
      .send(newTeacher)
      .expect(201);

    expect(res.body.invited).toBe(true);
    expect(res.body.temporaryPassword).toBeNull();
    // The whole point: nothing password-shaped reaches the admin.
    expect(JSON.stringify(res.body)).not.toMatch(/password["']?\s*:\s*["'][^"']+/i);

    expect(sendMail).toHaveBeenCalledOnce();
    const mail = sendMail.mock.calls[0]?.[0] as mailer.Mail;
    expect(mail.to).toBe('priya@school.test');
    expect(mail.subject).toMatch(/set up/i);
    expect(linkFromLastEmail().mode).toBe('invite');
  });

  it('stores only a hash of the setup token', async () => {
    await request(app).post('/api/v1/users').set('Authorization', adminHeader).send(newTeacher).expect(201);

    const { token } = linkFromLastEmail();
    const stored = await User.findOne({ email: 'priya@school.test' }).select(
      '+passwordResetTokenHash +passwordResetPurpose',
    );
    expect(stored?.passwordResetTokenHash).toBeTruthy();
    expect(stored?.passwordResetTokenHash).not.toBe(token);
    expect(stored?.passwordResetTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.passwordResetPurpose).toBe('invite');
  });

  it('lets the invited user set a password and sign in with it', async () => {
    await request(app).post('/api/v1/users').set('Authorization', adminHeader).send(newTeacher).expect(201);
    const { token } = linkFromLastEmail();

    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'her-chosen-passphrase' })
      .expect(204);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'priya@school.test', password: 'her-chosen-passphrase' })
      .expect(200);

    // They chose it themselves, so there is nothing to force them to change.
    expect(login.body.user.mustChangePassword).toBe(false);
  });

  it('marks the address confirmed once the link is used', async () => {
    await request(app).post('/api/v1/users').set('Authorization', adminHeader).send(newTeacher).expect(201);
    expect((await User.findOne({ email: 'priya@school.test' }))?.emailVerifiedAt).toBeNull();

    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: linkFromLastEmail().token, newPassword: 'her-chosen-passphrase' })
      .expect(204);

    expect((await User.findOne({ email: 'priya@school.test' }))?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('leaves the account unreachable until the link is used', async () => {
    await request(app).post('/api/v1/users').set('Authorization', adminHeader).send(newTeacher).expect(201);

    // The hash is real but random, so no password anyone could have been told will work.
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'priya@school.test', password: 'anything-at-all' })
      .expect(401);
  });

  it('emails a link on an admin reset, and the old password stops working at once', async () => {
    const user = await createTestUser({ role: 'TEACHER', email: 'old@school.test' });

    const res = await request(app)
      .post(`/api/v1/users/${String(user._id)}/reset-password`)
      .set('Authorization', adminHeader)
      .send({})
      .expect(200);

    expect(res.body.invited).toBe(true);
    expect(res.body.temporaryPassword).toBeNull();
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'old@school.test', password: 'correct-horse-battery' })
      .expect(401);
  });

  it('still honours a password the admin typed, without emailing anything', async () => {
    await request(app)
      .post('/api/v1/users')
      .set('Authorization', adminHeader)
      .send({ ...newTeacher, password: 'admin-chosen-passphrase' })
      .expect(201);

    expect(sendMail).not.toHaveBeenCalled();
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'priya@school.test', password: 'admin-chosen-passphrase' })
      .expect(200);
  });
});

describe('when the send fails', () => {
  beforeEach(() => {
    vi.spyOn(mailer, 'canSendMail').mockReturnValue(true);
    sendMail = vi.spyOn(mailer, 'sendMail').mockResolvedValue({ sent: false, error: 'smtp exploded' });
  });

  it('falls back to a temporary password rather than leaving an unreachable account', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', adminHeader)
      .send(newTeacher)
      .expect(201);

    expect(res.body.invited).toBe(false);
    expect(res.body.temporaryPassword).toBeTruthy();

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'priya@school.test', password: res.body.temporaryPassword })
      .expect(200);
  });

  it('withdraws the token, so no live link survives an email nobody received', async () => {
    await request(app).post('/api/v1/users').set('Authorization', adminHeader).send(newTeacher).expect(201);

    const stored = await User.findOne({ email: 'priya@school.test' }).select(
      '+passwordResetTokenHash +passwordResetExpiresAt +passwordResetPurpose',
    );
    expect(stored?.passwordResetTokenHash).toBeNull();
    expect(stored?.passwordResetExpiresAt).toBeNull();
    expect(stored?.passwordResetPurpose).toBeNull();
  });
});

describe('with no mail transport', () => {
  it('returns a temporary password, as it always did', async () => {
    // The suite runs without mail credentials, so this is the default path.
    expect(mailer.canSendMail()).toBe(false);

    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', adminHeader)
      .send(newTeacher)
      .expect(201);

    expect(res.body.invited).toBe(false);
    expect(res.body.temporaryPassword).toBeTruthy();
    expect(res.body.user.mustChangePassword).toBe(true);
  });
});
