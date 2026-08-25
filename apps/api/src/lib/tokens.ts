import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { UserRole } from '@rntps/shared';
import { env } from '../config/env.js';

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = 'rntps-admin';
const AUDIENCE = 'rntps-admin-api';

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  /** Empty for admins, who reach every class. */
  classes: string[];
  mustChangePassword: boolean;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({
    role: claims.role,
    classes: claims.classes,
    mustChangePassword: claims.mustChangePassword,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

/** Returns null for any invalid, expired or tampered token — callers treat that as 401. */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    return toClaims(payload);
  } catch {
    return null;
  }
}

function toClaims(payload: JWTPayload): AccessTokenClaims | null {
  const { sub, role, classes, mustChangePassword } = payload as JWTPayload & {
    role?: unknown;
    classes?: unknown;
    mustChangePassword?: unknown;
  };
  if (typeof sub !== 'string') return null;
  if (role !== 'ADMIN' && role !== 'TEACHER') return null;

  return {
    sub,
    role,
    classes: Array.isArray(classes) ? classes.filter((c): c is string => typeof c === 'string') : [],
    mustChangePassword: mustChangePassword === true,
  };
}

/**
 * Refresh tokens are opaque random strings, not JWTs: they must be revocable, and a
 * self-contained token cannot be revoked before it expires.
 */
export function generateRefreshToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashRefreshToken(token) };
}

/**
 * SHA-256 rather than a password hash: the input is already 256 bits of entropy, so
 * there is nothing to brute-force, and refresh runs on every page load.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newTokenFamily(): string {
  return randomUUID();
}

export function refreshTokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
