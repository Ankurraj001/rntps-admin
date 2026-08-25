import { describe, expect, it } from 'vitest';
import { generateTemporaryPassword, hashPassword, needsRehash, verifyPassword } from './password.js';

describe('hashPassword / verifyPassword', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('correct-horse-battery', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('correct-horse-batterz', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same-password-twice');
    const b = await hashPassword('same-password-twice');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-twice', b)).toBe(true);
  });

  it('encodes its parameters so they can be raised later', async () => {
    const hash = await hashPassword('correct-horse-battery');
    const [algorithm, N, r, p] = hash.split('$');
    expect(algorithm).toBe('scrypt');
    expect(Number(N)).toBeGreaterThan(0);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it('verifies against the stored parameters, not the current defaults', async () => {
    // A hash produced with weaker settings must still verify after the defaults rise.
    const legacy = await hashPassword('legacy-password-x');
    const weakened = legacy.replace(/^scrypt\$\d+\$/, 'scrypt$1024$');
    // Different parameters produce a different key, so this must NOT verify...
    expect(await verifyPassword('legacy-password-x', weakened)).toBe(false);
    // ...while the untouched hash still does.
    expect(await verifyPassword('legacy-password-x', legacy)).toBe(true);
  });

  it('normalises unicode, so the same typed password works across input methods', async () => {
    const composed = 'passwordé-secure';
    const decomposed = composed.normalize('NFD');
    expect(composed).not.toBe(decomposed);

    const hash = await hashPassword(composed);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    for (const bad of ['', 'not-a-hash', 'scrypt$x$8$1$aa$bb', 'bcrypt$1$2$3$4$5', 'scrypt$16384$8$1$aa']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('does not blow up on absurd stored parameters', async () => {
    const absurd = `scrypt$${2 ** 30}$8$1$YWFhYWFhYWFhYWFhYWFhYQ$${'A'.repeat(86)}`;
    expect(await verifyPassword('anything', absurd)).toBe(false);
  });
});

describe('needsRehash', () => {
  it('is false for a hash made with the current parameters', async () => {
    expect(needsRehash(await hashPassword('a-password-here'))).toBe(false);
  });

  it('is true for a weaker hash', () => {
    expect(needsRehash(`scrypt$1024$8$1$aa$bb`)).toBe(true);
  });

  it('is true for anything unrecognised, so it gets replaced on next login', () => {
    expect(needsRehash('$2b$10$somethingbcryptish')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });
});

describe('generateTemporaryPassword', () => {
  it('is long enough to satisfy the 12-character minimum', () => {
    expect(generateTemporaryPassword().length).toBe(14);
  });

  it('omits characters that are misread when written down', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateTemporaryPassword()).not.toMatch(/[0O1lI]/);
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateTemporaryPassword()));
    expect(seen.size).toBe(200);
  });
});
