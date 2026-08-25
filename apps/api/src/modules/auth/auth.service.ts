import type { UserDto } from '@rntps/shared';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../lib/AppError.js';
import { hashPassword, needsRehash, verifyPassword } from '../../lib/password.js';
import { plaintextFieldFor } from '../../lib/plaintextPassword.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  newTokenFamily,
  refreshTokenExpiry,
  signAccessToken,
} from '../../lib/tokens.js';
import { canSendMail, sendMail } from '../../lib/mailer.js';
import { User, type UserDoc, type UserHydrated } from '../../models/User.js';

export function toUserDto(user: UserDoc): UserDto {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    assignedClasses: [...user.assignedClasses],
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    isLocked: isLocked(user),
    createdAt: user.createdAt?.toISOString() ?? '',
  };
}

export function isLocked(user: Pick<UserDoc, 'lockedUntil'>): boolean {
  return user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

async function issueSession(user: UserHydrated, family: string, userAgent: string): Promise<SessionTokens> {
  const { token, tokenHash } = generateRefreshToken();
  const now = new Date();

  user.refreshTokens.push({
    tokenHash,
    family,
    issuedAt: now,
    expiresAt: refreshTokenExpiry(now),
    rotatedAt: null,
    revokedAt: null,
    userAgent: userAgent.slice(0, 200),
  });

  // Drop anything expired or revoked so the array cannot grow without bound.
  user.refreshTokens = user.refreshTokens.filter(
    (t) => t.expiresAt.getTime() > now.getTime() && t.revokedAt === null,
  );

  await user.save();

  const accessToken = await signAccessToken({
    sub: String(user._id),
    role: user.role,
    classes: user.role === 'ADMIN' ? [] : [...user.assignedClasses],
    mustChangePassword: user.mustChangePassword,
  });

  return { accessToken, refreshToken: token, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * Deliberately identical for "no such user", "wrong password" and "deactivated":
 * distinguishing them would let anyone enumerate staff email addresses.
 */
function invalidCredentials(): AppError {
  return new AppError(401, 'Email or password is incorrect', 'INVALID_CREDENTIALS');
}

/** A real hash of a value nobody can supply, used to equalise timing on unknown emails. */
const TIMING_DECOY_HASH =
  'scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86);

export async function login(
  email: string,
  password: string,
  userAgent = '',
): Promise<{ tokens: SessionTokens; user: UserDto }> {
  const user = await User.findOne({ email }).select('+passwordHash +refreshTokens +plaintextPassword');

  if (!user) {
    // Spend comparable time on an unknown address so response timing does not reveal
    // whether the account exists.
    await verifyPassword(password, TIMING_DECOY_HASH);
    throw invalidCredentials();
  }

  if (isLocked(user)) {
    const minutes = Math.ceil(((user.lockedUntil as Date).getTime() - Date.now()) / 60_000);
    throw new AppError(
      423,
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      'ACCOUNT_LOCKED',
    );
  }

  const passwordMatches = await verifyPassword(password, user.passwordHash);

  if (!passwordMatches) {
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= env.MAX_FAILED_LOGINS) {
      user.lockedUntil = new Date(Date.now() + env.ACCOUNT_LOCK_MINUTES * 60_000);
      user.failedLoginAttempts = 0;
      logger.warn({ userId: String(user._id) }, 'account locked after repeated failures');
    }
    await user.save();
    throw invalidCredentials();
  }

  if (!user.isActive) throw invalidCredentials();

  // Transparently upgrade a weaker hash now that the plaintext is available. This is
  // also the one moment an existing account can backfill its readable copy, since the
  // password is only ever in memory here.
  if (needsRehash(user.passwordHash)) {
    user.passwordHash = await hashPassword(password);
  }
  user.plaintextPassword = plaintextFieldFor(password).plaintextPassword;

  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date();

  const tokens = await issueSession(user, newTokenFamily(), userAgent);
  return { tokens, user: toUserDto(user) };
}

/**
 * How long after a rotation the old token is still accepted, for genuinely concurrent
 * clients. Auth0 and similar services use a few seconds of leeway for the same reason.
 * Outside this window, reuse is treated as theft.
 */
const REFRESH_REUSE_GRACE_MS = 10_000;

function invalidRefresh(): AppError {
  return new AppError(401, 'Your session has expired. Please sign in again.', 'INVALID_REFRESH');
}

/**
 * Rotates a refresh token.
 *
 * Presenting a token that has already been rotated means it was captured and replayed,
 * so the whole family is revoked rather than just that token. The legitimate user is
 * signed out too, which is the correct response to a stolen session.
 */
export async function refresh(
  presentedToken: string,
  userAgent = '',
): Promise<{ tokens: SessionTokens; user: UserDto }> {
  const tokenHash = hashRefreshToken(presentedToken);
  const user = await User.findOne({ 'refreshTokens.tokenHash': tokenHash }).select('+refreshTokens');
  if (!user) throw invalidRefresh();

  const stored = user.refreshTokens.find((t) => t.tokenHash === tokenHash);
  if (!stored) throw invalidRefresh();

  // An explicit revocation (sign-out, password change, deactivation) is always final.
  if (stored.revokedAt !== null) throw invalidRefresh();

  if (stored.rotatedAt !== null) {
    const sinceRotation = Date.now() - stored.rotatedAt.getTime();

    if (sinceRotation > REFRESH_REUSE_GRACE_MS) {
      const now = new Date();
      for (const token of user.refreshTokens) {
        if (token.family === stored.family && token.revokedAt === null) token.revokedAt = now;
      }
      await user.save();
      logger.warn(
        { userId: String(user._id), family: stored.family },
        'refresh token reuse detected, family revoked',
      );
      throw invalidRefresh();
    }

    // Inside the grace window this is almost certainly a benign race rather than theft:
    // two browser tabs bootstrapping at once, or React StrictMode double-invoking the
    // effect in development, all send the same cookie before any of them has the new
    // one. Revoking there would sign the user out on nearly every page load.
    logger.debug(
      { userId: String(user._id), sinceRotation },
      'concurrent refresh inside grace window, issuing a new token',
    );
  }

  if (stored.expiresAt.getTime() <= Date.now()) throw invalidRefresh();
  if (!user.isActive) throw invalidRefresh();

  // Anchored to the FIRST rotation, so replaying the same token cannot keep extending
  // its own grace window.
  stored.rotatedAt ??= new Date();
  const tokens = await issueSession(user, stored.family, userAgent);
  return { tokens, user: toUserDto(user) };
}

export async function logout(presentedToken: string | undefined): Promise<void> {
  if (!presentedToken) return;

  const tokenHash = hashRefreshToken(presentedToken);
  const user = await User.findOne({ 'refreshTokens.tokenHash': tokenHash }).select('+refreshTokens');
  if (!user) return;

  const stored = user.refreshTokens.find((t) => t.tokenHash === tokenHash);
  if (!stored) return;

  // Revoke the whole family, so signing out ends that chain entirely.
  const now = new Date();
  for (const token of user.refreshTokens) {
    if (token.family === stored.family && token.revokedAt === null) token.revokedAt = now;
  }
  await user.save();
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await User.findById(userId).select('+passwordHash +refreshTokens +plaintextPassword');
  if (!user) throw AppError.notFound('User not found');

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AppError(400, 'Your current password is incorrect', 'WRONG_PASSWORD');
  }

  user.passwordHash = await hashPassword(newPassword);
  user.plaintextPassword = plaintextFieldFor(newPassword).plaintextPassword;
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date();

  // A password change ends every existing session, including any an attacker holds.
  const now = new Date();
  for (const token of user.refreshTokens) {
    if (token.revokedAt === null) token.revokedAt = now;
  }

  await user.save();
}

export async function getUserById(userId: string): Promise<UserDto> {
  const user = await User.findById(userId).lean<UserDoc>();
  if (!user) throw AppError.notFound('User not found');
  return toUserDto(user);
}

// ---------------------------------------------------------------------------
// Forgotten password
// ---------------------------------------------------------------------------

/**
 * Starts a password reset.
 *
 * Returns nothing regardless of whether the address exists. Telling the caller "no such
 * account" would turn this endpoint into a staff-directory oracle, which is the usual way
 * these flows leak.
 */
export async function requestPasswordReset(email: string, appBaseUrl: string): Promise<void> {
  // Nothing can be delivered, so mint nothing. Storing a reset hash that no one will ever
  // receive leaves a live credential-reset path in the database for no benefit.
  if (!canSendMail()) {
    logger.warn('password reset requested but SMTP is not configured — ignoring');
    return;
  }

  const user = await User.findOne({ email }).select('+passwordResetTokenHash +passwordResetExpiresAt');

  // A deactivated account must not be recoverable by its former holder.
  if (!user || !user.isActive) {
    logger.info({ known: Boolean(user) }, 'password reset requested for an unusable address');
    return;
  }

  const { token, tokenHash } = generateRefreshToken();
  user.passwordResetTokenHash = tokenHash;
  user.passwordResetExpiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000);
  await user.save();

  const link = `${appBaseUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
  const minutes = env.PASSWORD_RESET_TTL_MINUTES;

  await sendMail({
    to: user.email,
    subject: 'Reset your RNTPS Admin password',
    text: [
      `Hello ${user.name},`,
      '',
      'Use this link to set a new password:',
      link,
      '',
      `The link expires in ${minutes} minutes and can be used once.`,
      'If you did not ask for this, you can ignore this email — nothing has changed.',
    ].join('\n'),
    html: [
      `<p>Hello ${escapeHtml(user.name)},</p>`,
      '<p>Use this link to set a new password:</p>',
      `<p><a href="${escapeHtml(link)}">Set a new password</a></p>`,
      `<p style="color:#475569;font-size:14px">The link expires in ${minutes} minutes and can be used once. `,
      'If you did not ask for this, you can ignore this email — nothing has changed.</p>',
    ].join(''),
  });
}

/** Minimal escaping for the values interpolated into the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Completes a password reset.
 *
 * The token is single-use and consumed even on the happy path, and every existing session
 * is revoked — a reset is exactly the moment to evict anyone already holding a session.
 */
export async function resetPasswordWithToken(token: string, newPassword: string): Promise<void> {
  const tokenHash = hashRefreshToken(token);

  const user = await User.findOne({ passwordResetTokenHash: tokenHash }).select(
    '+passwordHash +refreshTokens +passwordResetTokenHash +passwordResetExpiresAt +plaintextPassword',
  );

  const invalid = new AppError(
    400,
    'That reset link is invalid or has expired. Request a new one.',
    'INVALID_RESET_TOKEN',
  );

  if (!user) throw invalid;
  if (!user.passwordResetExpiresAt || user.passwordResetExpiresAt.getTime() <= Date.now()) {
    // Clear the stale token so a leaked expired link cannot be probed repeatedly.
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    await user.save();
    throw invalid;
  }
  if (!user.isActive) throw invalid;

  user.passwordHash = await hashPassword(newPassword);
  user.plaintextPassword = plaintextFieldFor(newPassword).plaintextPassword;
  // The user chose this password, so there is nothing to force them to change.
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date();
  user.passwordResetTokenHash = null;
  user.passwordResetExpiresAt = null;
  // A reset is also the remedy for a lockout.
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;

  const now = new Date();
  for (const refreshToken of user.refreshTokens) {
    if (refreshToken.revokedAt === null) refreshToken.revokedAt = now;
  }

  await user.save();
  logger.info({ userId: String(user._id) }, 'password reset via emailed link');
}
