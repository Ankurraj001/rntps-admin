import { PASSWORD_MIN_LENGTH, passwordSchema } from '@rntps/shared';
import { describe, expect, it } from 'vitest';

/**
 * Pins the password policy at its boundaries.
 *
 * The route tests only ever send 'short', which fails at any plausible minimum — so the
 * exact figure had no coverage and could drift unnoticed. Lives in this workspace because
 * @rntps/shared has no test runner of its own.
 */

describe('passwordSchema', () => {
  it('is 8 characters', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
  });

  it('rejects one character below the minimum', () => {
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
  });

  it('accepts exactly the minimum', () => {
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
  });

  it('names the minimum in the error, so the form can show it', () => {
    const result = passwordSchema.safeParse('short');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(`Use at least ${PASSWORD_MIN_LENGTH} characters`);
    }
  });

  it('reports only the length when a short password has no spaces at all', () => {
    // Both rules used to fire, so the user was told their space-free password was "mostly
    // spaces" alongside the real complaint.
    const result = passwordSchema.safeParse('abcdefg');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.message).toMatch(/at least 8/);
    }
  });

  it('does not let spaces pad out the minimum', () => {
    // Long enough by raw length, but only two non-space characters.
    expect(passwordSchema.safeParse('ab' + ' '.repeat(PASSWORD_MIN_LENGTH)).success).toBe(false);
  });

  it('still accepts a passphrase containing spaces', () => {
    expect(passwordSchema.safeParse('correct horse battery').success).toBe(true);
  });

  it('rejects an over-long password', () => {
    expect(passwordSchema.safeParse('a'.repeat(201)).success).toBe(false);
  });
});
