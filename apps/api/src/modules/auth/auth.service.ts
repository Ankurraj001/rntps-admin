import type { UserDto } from '@rntps/shared';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../lib/AppError.js';
import { hashPassword, needsRehash, verifyPassword } from '../../lib/password.js';
import {
  generatePasswordResetToken,
  generateRefreshToken,
  hashPasswordResetToken,
  hashRefreshToken,
  newTokenFamily,
  refreshTokenExpiry,
  signAccessToken,
} from '../../lib/tokens.js';
import {
  canReachAnyRecipient,
  canSendMail,
  mailNeedsLiveCheck,
  sendMail,
  verifyMailConnection,
} from '../../lib/mailer.js';
import { invitationEmail, passwordResetEmail } from '../../lib/mailTemplates.js';
import { User, type RefreshTokenSub, type UserDoc, type UserHydrated } from '../../models/User.js';

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
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
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

/**
 * How long a rotated token is kept around after it stops being usable.
 *
 * A rotated token is dead weight for authentication — presenting it never grants a session
 * — but it is not dead weight for *detection*: recognising one is the only signal that a
 * token was stolen, and it is what triggers revoking the whole family. So it cannot simply
 * be dropped at rotation.
 *
 * It does not need keeping until `expiresAt`, though, which is what used to happen. The
 * frontend renews on a timer rather than on a 401, so a tab open through a working day
 * rotates roughly every 14 minutes; over a 14-day `REFRESH_TOKEN_TTL_DAYS` that left ~475
 * spent entries, ~120 KB, inside one user document — rewritten in full on every rotation,
 * and indexed by `refreshTokens.tokenHash` on every entry. Ten staff accounts outweighed
 * all 250 student records.
 *
 * A day is still 8,640x `REFRESH_REUSE_GRACE_MS` and far longer than any real replay
 * takes, so it keeps the tripwire while bounding the array at a day's rotations. The
 * trade-off is explicit: a token replayed for the first time more than a day after it was
 * rotated is refused, as it always was, but no longer revokes its family — nobody learns
 * that it leaked. Theft of a *live* token is unaffected, which is the case that matters.
 */
const ROTATED_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Whether a stored refresh token is still worth carrying, for use or as a tripwire. */
function keepRefreshToken(token: RefreshTokenSub, now: Date): boolean {
  if (token.revokedAt !== null) return false;
  if (token.expiresAt.getTime() <= now.getTime()) return false;
  if (token.rotatedAt !== null) {
    return now.getTime() - token.rotatedAt.getTime() <= ROTATED_TOKEN_RETENTION_MS;
  }
  return true;
}

async function issueSession(
  user: UserHydrated,
  family: string,
  userAgent: string,
): Promise<SessionTokens> {
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

  user.refreshTokens = user.refreshTokens.filter((t) => keepRefreshToken(t, now));

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
const TIMING_DECOY_HASH = 'scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86);

export async function login(
  email: string,
  password: string,
  userAgent = '',
): Promise<{ tokens: SessionTokens; user: UserDto }> {
  const user = await User.findOne({ email }).select('+passwordHash +refreshTokens');

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

  // Transparently upgrade a weaker hash: a successful login is the only moment an
  // existing account's password is in memory to rehash from.
  if (needsRehash(user.passwordHash)) {
    user.passwordHash = await hashPassword(password);
  }

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
  const user = await User.findOne({ 'refreshTokens.tokenHash': tokenHash }).select(
    '+refreshTokens',
  );
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
  const user = await User.findOne({ 'refreshTokens.tokenHash': tokenHash }).select(
    '+refreshTokens',
  );
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
  const user = await User.findById(userId).select(
    '+passwordHash +refreshTokens +passwordResetTokenHash +passwordResetExpiresAt +passwordResetPurpose',
  );
  if (!user) throw AppError.notFound('User not found');

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AppError(400, 'Your current password is incorrect', 'WRONG_PASSWORD');
  }

  user.passwordHash = await hashPassword(newPassword);
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date();
  // Any reset link already in flight must die with the old password, or whoever requested
  // it keeps a way in for the rest of its TTL.
  clearPasswordResetToken(user);

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
// Password setup and reset links
// ---------------------------------------------------------------------------

export type ResetPurpose = 'invite' | 'reset';

/**
 * Whether self-service reset can actually be offered.
 *
 * `canSendMail()` only proves a transport exists. This asks the stronger question — can a
 * link reach an arbitrary member of staff — because "configured" and "working" are not the
 * same thing, and advertising reset when they differ is the "check your email" lie this
 * whole flow exists to avoid. Two ways it can be false:
 *
 * - Resend with MAIL_FROM left as its shared sender, which reaches the account owner and
 *   403s everyone else. Determined offline.
 * - SMTP whose credentials are rejected at the handshake. Only the server can say, so this
 *   probes it — the result cached per container, since it is read on every visit to the
 *   sign-in screens and a round-trip on each would be slow and rate-limit bait.
 *
 * A stale positive is survivable: the send reports failure and the token is withdrawn.
 */
const MAIL_HEALTH_TTL_MS = 5 * 60_000;
let mailHealth: { ok: boolean; checkedAt: number } | null = null;

export async function isPasswordResetByEmailAvailable(): Promise<boolean> {
  if (!canReachAnyRecipient()) return false;
  if (!mailNeedsLiveCheck()) return true;

  const now = Date.now();
  if (mailHealth && now - mailHealth.checkedAt < MAIL_HEALTH_TTL_MS) return mailHealth.ok;

  try {
    await verifyMailConnection();
    mailHealth = { ok: true, checkedAt: now };
  } catch (error) {
    logger.error({ err: error }, 'mail is configured but the transport rejected it');
    mailHealth = { ok: false, checkedAt: now };
  }
  return mailHealth.ok;
}

/**
 * Clears any reset link in flight.
 *
 * Called from every path that changes a password, because a token minted before that
 * change stays valid until it expires otherwise — so an attacker who triggered a reset
 * keeps a working link for up to an hour *after* the victim secures their account.
 */
export function clearPasswordResetToken(user: UserHydrated): void {
  user.passwordResetTokenHash = null;
  user.passwordResetExpiresAt = null;
  user.passwordResetPurpose = null;
}

function ttlMinutesFor(purpose: ResetPurpose): number {
  // An invitation is handed out ahead of time — often before term starts — so it has to
  // outlive the tight window that suits a self-service reset.
  return purpose === 'invite' ? env.INVITE_TTL_HOURS * 60 : env.PASSWORD_RESET_TTL_MINUTES;
}

/**
 * Mints a single-use link and emails it.
 *
 * The token is stored only as a SHA-256 hash, so a database leak yields nothing
 * replayable. If the email cannot be delivered the token is withdrawn again: leaving a
 * live credential-reset path in the database for a message nobody received is strictly
 * worse than not having tried.
 *
 * Returns whether the mail went out, so an admin-facing caller can fall back to handing
 * over a temporary password instead.
 */
export async function issuePasswordSetupLink(
  user: UserHydrated,
  purpose: ResetPurpose,
  appBaseUrl: string = env.APP_BASE_URL,
): Promise<{ sent: boolean; error?: string }> {
  if (!canSendMail()) return { sent: false, error: 'no mail transport configured' };

  const ttlMinutes = ttlMinutesFor(purpose);
  const { token, tokenHash } = generatePasswordResetToken();

  user.passwordResetTokenHash = tokenHash;
  user.passwordResetExpiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  user.passwordResetPurpose = purpose;
  await user.save();

  const link =
    `${appBaseUrl.replace(/\/$/, '')}/reset-password` +
    `?token=${encodeURIComponent(token)}&mode=${purpose}`;

  const body =
    purpose === 'invite'
      ? invitationEmail(user.name, link, ttlMinutes)
      : passwordResetEmail(user.name, link, ttlMinutes);

  const result = await sendMail({
    to: user.email,
    ...body,
    // Keyed to the token, so a retried function invocation cannot deliver a second link
    // that silently invalidates the first.
    idempotencyKey: `${purpose}-${tokenHash.slice(0, 32)}`,
  });

  if (!result.sent) {
    clearPasswordResetToken(user);
    await user.save();
    logger.error(
      { userId: String(user._id), purpose, error: result.error },
      'could not deliver the password link — token withdrawn',
    );
  }

  return result;
}

/** How many reset emails one account will accept before it stops sending, and over what window. */
const RESET_REQUEST_LIMIT = 3;
const RESET_REQUEST_WINDOW_MS = 60 * 60_000;

/**
 * Starts a password reset.
 *
 * Returns nothing regardless of whether the address exists, is inactive, or is being
 * throttled. Telling the caller "no such account" would turn this endpoint into a
 * staff-directory oracle, which is the usual way these flows leak.
 */
export async function requestPasswordReset(email: string, appBaseUrl: string): Promise<void> {
  // Nothing can be delivered, so mint nothing. Storing a reset hash that no one will ever
  // receive leaves a live credential-reset path in the database for no benefit.
  if (!canSendMail()) {
    logger.warn('password reset requested but no mail transport is configured — ignoring');
    return;
  }

  const user = await User.findOne({ email }).select(
    '+passwordResetTokenHash +passwordResetExpiresAt +passwordResetPurpose ' +
      '+passwordResetRequestedAt +passwordResetRequestCount',
  );

  // A deactivated account must not be recoverable by its former holder.
  if (!user || !user.isActive) {
    logger.info({ known: Boolean(user) }, 'password reset requested for an unusable address');
    return;
  }

  // Per-account throttle. The IP limiter on the route is per-container on serverless, so
  // this is what actually stops one inbox being flooded from rotating addresses.
  const now = Date.now();
  const windowStart = user.passwordResetRequestedAt?.getTime() ?? 0;
  const withinWindow = now - windowStart < RESET_REQUEST_WINDOW_MS;

  if (withinWindow && user.passwordResetRequestCount >= RESET_REQUEST_LIMIT) {
    logger.warn({ userId: String(user._id) }, 'password reset throttled for this account');
    return;
  }

  user.passwordResetRequestCount = withinWindow ? user.passwordResetRequestCount + 1 : 1;
  if (!withinWindow) user.passwordResetRequestedAt = new Date(now);

  await issuePasswordSetupLink(user, 'reset', appBaseUrl);
}

/**
 * Completes a password reset.
 *
 * The token is single-use and consumed even on the happy path, and every existing session
 * is revoked — a reset is exactly the moment to evict anyone already holding a session.
 */
export async function resetPasswordWithToken(
  token: string,
  newPassword: string,
): Promise<{ userId: string; purpose: ResetPurpose | null }> {
  const tokenHash = hashPasswordResetToken(token);

  const user = await User.findOne({ passwordResetTokenHash: tokenHash }).select(
    '+passwordHash +refreshTokens +passwordResetTokenHash +passwordResetExpiresAt ' +
      '+passwordResetPurpose +passwordResetRequestedAt +passwordResetRequestCount',
  );

  const invalid = new AppError(
    400,
    'That reset link is invalid or has expired. Request a new one.',
    'INVALID_RESET_TOKEN',
  );

  if (!user) throw invalid;
  if (!user.passwordResetExpiresAt || user.passwordResetExpiresAt.getTime() <= Date.now()) {
    // Clear the stale token so a leaked expired link cannot be probed repeatedly.
    clearPasswordResetToken(user);
    await user.save();
    throw invalid;
  }
  if (!user.isActive) throw invalid;

  const purpose = user.passwordResetPurpose;

  user.passwordHash = await hashPassword(newPassword);
  // The user chose this password, so there is nothing to force them to change.
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date();
  clearPasswordResetToken(user);
  // Completing a link proves the holder reads that inbox — the only confirmation the
  // address ever gets, since an admin types it in unverified at account creation.
  user.emailVerifiedAt = new Date();
  // A reset is also the remedy for a lockout, and clears the per-account send throttle so
  // a legitimate user is not left blocked by their own earlier attempts.
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.passwordResetRequestedAt = null;
  user.passwordResetRequestCount = 0;

  const now = new Date();
  for (const refreshToken of user.refreshTokens) {
    if (refreshToken.revokedAt === null) refreshToken.revokedAt = now;
  }

  await user.save();
  logger.info({ userId: String(user._id), purpose }, 'password set via emailed link');
  return { userId: String(user._id), purpose };
}
