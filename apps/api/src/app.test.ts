import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { clientIp } from './app.js';

/** Minimal stand-in for the parts of Request that clientIp reads. */
function fakeRequest(headers: Record<string, string>, ip?: string): Request {
  return {
    get: (name: string) => headers[name.toLowerCase()],
    ip,
  } as unknown as Request;
}

describe('clientIp', () => {
  it('prefers the Netlify client IP header', () => {
    const req = fakeRequest(
      { 'x-nf-client-connection-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' },
      '10.0.0.1',
    );
    expect(clientIp(req)).toBe('203.0.113.7');
  });

  it('falls back to the first x-forwarded-for entry', () => {
    const req = fakeRequest({ 'x-forwarded-for': '198.51.100.1, 10.0.0.5, 10.0.0.6' });
    expect(clientIp(req)).toBe('198.51.100.1');
  });

  it('falls back to the socket IP on a persistent server', () => {
    expect(clientIp(fakeRequest({}, '192.0.2.44'))).toBe('192.0.2.44');
  });

  it('never returns undefined, which is what broke the limiter on serverless', () => {
    // express-rate-limit throws ERR_ERL_UNDEFINED_IP_ADDRESS on an undefined key.
    expect(clientIp(fakeRequest({}))).toBe('unknown');
  });
});
