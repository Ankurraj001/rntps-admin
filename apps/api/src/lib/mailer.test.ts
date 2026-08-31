import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Transport selection and failure reporting.
 *
 * `sendMail` must never throw — a mail outage turning a password-reset request into a 500
 * would both break the flow and, by differing from the usual 204, reveal that the account
 * exists. It reports failure in the return value instead, which is what lets the caller
 * withdraw a token whose email never went out.
 *
 * The env module reads process.env once at import, so each case re-imports it with vi.resetModules.
 */

const ORIGINAL_ENV = { ...process.env };

async function loadMailer(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import('./mailer.js');
}

beforeEach(() => {
  // A configured transport must not be inherited from the suite's own environment.
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.resetModules();
});

const mail = {
  to: 'teacher@school.test',
  subject: 'Reset your password',
  text: 'link',
  html: '<p>link</p>',
};

describe('with no transport configured', () => {
  it('reports not sent rather than throwing, so local dev works with no credentials', async () => {
    const mailer = await loadMailer({});
    expect(mailer.canSendMail()).toBe(false);

    const result = await mailer.sendMail(mail);
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/no mail transport/i);
  });
});

describe('with RESEND_API_KEY set', () => {
  it('posts to the Resend API and reports success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'abc' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const mailer = await loadMailer({ RESEND_API_KEY: 're_test_key' });
    expect(mailer.canSendMail()).toBe(true);
    expect(await mailer.sendMail(mail)).toEqual({ sent: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(String(init.body))).toMatchObject({ to: mail.to, subject: mail.subject });
  });

  it('sends an idempotency key when given one, so a retried invocation cannot double-send', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const mailer = await loadMailer({ RESEND_API_KEY: 're_test_key' });
    await mailer.sendMail({ ...mail, idempotencyKey: 'reset-deadbeef' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('reset-deadbeef');
  });

  it('surfaces the API message on a refusal instead of throwing', async () => {
    // The shape Resend returns when MAIL_FROM is still its shared sender.
    const body = JSON.stringify({
      name: 'validation_error',
      message: 'You can only send testing emails to your own email address',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 403 })));

    const mailer = await loadMailer({ RESEND_API_KEY: 're_test_key' });
    const result = await mailer.sendMail(mail);

    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/only send testing emails/i);
  });

  it('reports a transport error rather than propagating it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const mailer = await loadMailer({ RESEND_API_KEY: 're_test_key' });
    const result = await mailer.sendMail(mail);

    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/network down/);
  });

  it('rejects a bad key on verify, which is what mail:test relies on', async () => {
    const body = JSON.stringify({ message: 'API key is invalid' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 401 })));

    // MAIL_FROM must be a real domain, or the cheaper shared-sender check fires first.
    const mailer = await loadMailer({
      RESEND_API_KEY: 're_bad_key',
      MAIL_FROM: 'RNTPS <noreply@send.rntps.in>',
    });
    await expect(mailer.verifyMailConnection()).rejects.toThrow(/API key is invalid/);
  });
});

describe('verifying that mail can reach anyone, not just the account owner', () => {
  function domainsResponse(domains: { name: string; status: string }[]) {
    return vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: domains }), { status: 200 }));
  }

  it('fails on the default sender even though the key is valid', async () => {
    // The trap: the key works, so a key-only check would report mail as available — while
    // Resend would 403 every recipient but the account owner.
    const fetchMock = domainsResponse([]);
    vi.stubGlobal('fetch', fetchMock);
    const mailer = await loadMailer({ RESEND_API_KEY: 're_test_key' });

    await expect(mailer.verifyMailConnection()).rejects.toThrow(/shared sender/i);
    // Caught before any network call, so it works with a send-only key too.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a sending-only key, which cannot list domains at all', async () => {
    // Restricted keys are the recommended kind; refusing them would push people to a
    // broader-permission key for no benefit.
    const body = JSON.stringify({ message: 'This API key is restricted to only send emails' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 401 })));

    const mailer = await loadMailer({
      RESEND_API_KEY: 're_send_only',
      MAIL_FROM: 'RNTPS <noreply@send.rntps.in>',
    });

    await expect(mailer.verifyMailConnection()).resolves.toBeUndefined();
  });

  it('fails when the sending domain is not on the account', async () => {
    vi.stubGlobal('fetch', domainsResponse([{ name: 'other.example', status: 'verified' }]));
    const mailer = await loadMailer({
      RESEND_API_KEY: 're_test_key',
      MAIL_FROM: 'RNTPS <noreply@send.rntps.in>',
    });

    await expect(mailer.verifyMailConnection()).rejects.toThrow(/not a domain on this Resend account/);
  });

  it('fails while the domain is still pending DNS propagation', async () => {
    vi.stubGlobal('fetch', domainsResponse([{ name: 'send.rntps.in', status: 'pending' }]));
    const mailer = await loadMailer({
      RESEND_API_KEY: 're_test_key',
      MAIL_FROM: 'RNTPS <noreply@send.rntps.in>',
    });

    await expect(mailer.verifyMailConnection()).rejects.toThrow(/not verified yet.*pending/);
  });

  it('passes once the sending domain is verified', async () => {
    vi.stubGlobal('fetch', domainsResponse([{ name: 'send.rntps.in', status: 'verified' }]));
    const mailer = await loadMailer({
      RESEND_API_KEY: 're_test_key',
      MAIL_FROM: 'RNTPS <noreply@send.rntps.in>',
    });

    await expect(mailer.verifyMailConnection()).resolves.toBeUndefined();
  });
});

describe('canReachAnyRecipient', () => {
  it('is false with no transport', async () => {
    const mailer = await loadMailer({});
    expect(mailer.canReachAnyRecipient()).toBe(false);
  });

  it('is false while MAIL_FROM is Resend\'s shared sender', async () => {
    // A key alone is not enough: that sender reaches only the account owner.
    const mailer = await loadMailer({ RESEND_API_KEY: 're_test_key' });
    expect(mailer.canSendMail()).toBe(true);
    expect(mailer.canReachAnyRecipient()).toBe(false);
  });

  it('is true once MAIL_FROM is on a real domain', async () => {
    const mailer = await loadMailer({
      RESEND_API_KEY: 're_test_key',
      MAIL_FROM: 'RNTPS <noreply@send.rntps.in>',
    });
    expect(mailer.canReachAnyRecipient()).toBe(true);
  });

  it('is true for SMTP, which has no such restriction', async () => {
    const mailer = await loadMailer({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '9',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
    });
    expect(mailer.canReachAnyRecipient()).toBe(true);
  });
});

describe('mailNeedsLiveCheck', () => {
  it('is true for SMTP, whose credentials can only be tested by connecting', async () => {
    // Present credentials prove nothing here: Brevo rejects the account email as a login
    // with 535, and there is no way to see that without a handshake.
    const mailer = await loadMailer({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '9',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
    });
    expect(mailer.mailNeedsLiveCheck()).toBe(true);
  });

  it('is false for Resend, which needs no probe', async () => {
    const mailer = await loadMailer({
      RESEND_API_KEY: 're_test_key',
      MAIL_FROM: 'RNTPS <noreply@send.rntps.in>',
    });
    expect(mailer.mailNeedsLiveCheck()).toBe(false);
  });

  it('is false when Resend supersedes a configured SMTP', async () => {
    const mailer = await loadMailer({
      RESEND_API_KEY: 're_test_key',
      MAIL_FROM: 'RNTPS <noreply@send.rntps.in>',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '9',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
    });
    expect(mailer.mailNeedsLiveCheck()).toBe(false);
  });

  it('is false with nothing configured', async () => {
    const mailer = await loadMailer({});
    expect(mailer.mailNeedsLiveCheck()).toBe(false);
  });
});

describe('senderDomain', () => {
  it('reads the domain out of either address form', async () => {
    const { senderDomain } = await loadMailer({});
    expect(senderDomain('RNTPS Admin <noreply@Send.RNTPS.in>')).toBe('send.rntps.in');
    expect(senderDomain('noreply@rntps.in')).toBe('rntps.in');
    expect(senderDomain('not-an-address')).toBeNull();
  });
});

describe('with only SMTP configured', () => {
  it('does not reach for the Resend API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // Loopback on a port nothing listens on: refused immediately, with no DNS lookup, so
    // the case is deterministic offline.
    const mailer = await loadMailer({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '9',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
    });

    expect(mailer.canSendMail()).toBe(true);
    // The connection is refused, so this fails — the point is that it failed via SMTP.
    const result = await mailer.sendMail(mail);
    expect(result.sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('transport precedence', () => {
  it('prefers Resend when both are configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const mailer = await loadMailer({
      RESEND_API_KEY: 're_test_key',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '9',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
    });

    expect(await mailer.sendMail(mail)).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
