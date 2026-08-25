import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';
import { isTest } from '../config/env.js';

// promisify() picks the no-options overload, so the signature is restated here.
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * scrypt from node:crypto, rather than argon2 or bcrypt.
 *
 * Both of those are native addons, and native addons in a bundled serverless function
 * are a reliable source of cold-start "module not found" failures. scrypt is built into
 * Node, so there is nothing to compile or bundle, and OWASP lists it as an acceptable
 * password hash.
 *
 * Parameters follow the OWASP minimum: N = 2^17, r = 8, p = 1. Measured at ~200ms and
 * ~128MB per hash, which is comfortable inside a 1GB function and invisible on a login.
 */
const DEFAULT_PARAMS = isTest
  ? // A real hash costs ~200ms; at a few hundred hashes per suite that is minutes of
    // waiting for no extra coverage. Parameters travel with the hash, so verification
    // logic is exercised identically either way.
    ({ N: 2 ** 12, r: 8, p: 1 } as const)
  : ({ N: 2 ** 17, r: 8, p: 1 } as const);
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** scrypt needs roughly 128 * N * r bytes; the driver rejects the call without headroom. */
function maxmemFor(N: number, r: number): number {
  return 256 * N * r;
}

/**
 * Bounds on the parameters read back out of a stored hash.
 *
 * Because maxmem is derived from N, a hash claiming N = 2^30 would not fail — it would
 * be attempted, burning minutes of CPU and gigabytes of memory on a single request.
 * Anything outside these bounds is treated as a corrupt hash instead.
 */
const MIN_N = 2 ** 12;
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;

function parametersAreSane(N: number, r: number, p: number): boolean {
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < MIN_N || N > MAX_N) return false;
  // scrypt requires N to be a power of two.
  if ((N & (N - 1)) !== 0) return false;
  if (r < 1 || r > MAX_R) return false;
  if (p < 1 || p > MAX_P) return false;
  return true;
}

/**
 * Encoded as `scrypt$N$r$p$salt$hash`. The parameters travel with the hash so they can
 * be raised later without invalidating existing passwords — verify uses the stored
 * values, not the current defaults.
 */
export async function hashPassword(password: string): Promise<string> {
  const { N, r, p } = DEFAULT_PARAMS;
  const salt = randomBytes(SALT_LENGTH);
  const derived = (await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: maxmemFor(N, r),
  }));

  return ['scrypt', N, r, p, salt.toString('base64url'), derived.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!parametersAreSane(N, r, p)) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(parts[5] as string, 'base64url');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;

  const salt = Buffer.from(parts[4] as string, 'base64url');

  let derived: Buffer;
  try {
    derived = (await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r),
    }));
  } catch {
    // Absurd stored parameters would otherwise crash the login route.
    return false;
  }

  return timingSafeEqual(derived, expected);
}

/** True when a hash was made with weaker parameters than the current default. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < DEFAULT_PARAMS.N;
}

const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A temporary password an admin can read aloud or write down: no 0/O/1/l/I, and long
 * enough to satisfy the 12-character minimum with room to spare.
 */
export function generateTemporaryPassword(length = 14): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += TEMP_ALPHABET[(bytes[i] as number) % TEMP_ALPHABET.length];
  }
  return out;
}
