import type { CreateUserPayload, UpdateUserPayload, UserDto } from '@rntps/shared';
import { randomBytes } from 'node:crypto';
import { AppError } from '../../lib/AppError.js';
import { canSendMail } from '../../lib/mailer.js';
import { generateTemporaryPassword, hashPassword } from '../../lib/password.js';
import { isDuplicateKeyError } from '../../lib/mongoErrors.js';
import { User, type UserDoc, type UserHydrated } from '../../models/User.js';
import {
  clearPasswordResetToken,
  issuePasswordSetupLink,
  toUserDto,
} from '../auth/auth.service.js';

/**
 * A password nobody holds.
 *
 * When an account is set up by emailed link there is no password yet, but the schema
 * requires a hash. Hashing 32 random bytes that are immediately discarded gives a real,
 * unguessable hash rather than a marker value some future code path might treat as
 * "empty" and skip verification for.
 */
async function unusablePasswordHash(): Promise<string> {
  return hashPassword(randomBytes(32).toString('base64url'));
}

/**
 * `temporaryPassword` is non-null only on the fallback path, where mail could not carry a
 * setup link. `invited` tells the UI which happened, so it can say so rather than leaving
 * the admin guessing whether the user has been contacted.
 */
export interface CreateUserResult {
  user: UserDto;
  temporaryPassword: string | null;
  invited: boolean;
}

export async function listUsers(): Promise<UserDto[]> {
  const users = await User.find().sort({ name: 1 }).lean<UserDoc[]>();
  return users.map(toUserDto);
}

export async function createUser(
  payload: CreateUserPayload,
  actorId: string | null,
): Promise<CreateUserResult> {
  // Admins reach every class, so a stored list would only ever drift out of date.
  const assignedClasses = payload.role === 'ADMIN' ? [] : payload.assignedClasses;

  // An admin who typed a password already knows it, so there is nothing to email; if mail
  // works we invite instead, and nobody — including the admin — ever sees the password.
  const inviteByEmail = !payload.password && canSendMail();

  // Only needed when we can neither email a link nor use a password the admin supplied.
  const fallbackPassword = inviteByEmail || payload.password ? null : generateTemporaryPassword();

  try {
    const created = await User.create({
      name: payload.name,
      email: payload.email,
      phone: payload.phone ?? '',
      passwordHash: inviteByEmail
        ? await unusablePasswordHash()
        : await hashPassword((payload.password ?? fallbackPassword) as string),
      role: payload.role,
      assignedClasses,
      isActive: true,
      // Always true: an admin who typed the password knows it, so the new user should
      // still replace it with something only they know.
      mustChangePassword: true,
      createdBy: actorId,
    });

    if (inviteByEmail) {
      const { sent } = await issuePasswordSetupLink(created, 'invite');
      if (sent)
        return { user: toUserDto(created.toObject()), temporaryPassword: null, invited: true };

      // Mail was configured but the send failed. Rather than leave an account nobody can
      // reach, fall back to the one-time handover the admin can read out.
      const temporaryPassword = await assignTemporaryPassword(created);
      return { user: toUserDto(created.toObject()), temporaryPassword, invited: false };
    }

    return { user: toUserDto(created.toObject()), temporaryPassword: fallbackPassword, invited: false };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw AppError.conflict(`${payload.email} already has an account`);
    }
    throw error;
  }
}

/** Sets a fresh generated password on the user and returns it for one-time handover. */
async function assignTemporaryPassword(user: UserHydrated): Promise<string> {
  const temporaryPassword = generateTemporaryPassword();
  user.passwordHash = await hashPassword(temporaryPassword);
  user.mustChangePassword = true;
  user.passwordChangedAt = new Date();
  await user.save();
  return temporaryPassword;
}

export async function updateUser(
  userId: string,
  payload: UpdateUserPayload,
  actor: { id: string },
): Promise<UserDto> {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');

  const nextRole = payload.role ?? user.role;
  const nextActive = payload.isActive ?? user.isActive;

  // Guard against an admin locking themselves — and possibly everyone — out.
  if (String(user._id) === actor.id && (nextRole !== 'ADMIN' || !nextActive)) {
    throw AppError.badRequest('You cannot remove your own admin access');
  }
  if (user.role === 'ADMIN' && (nextRole !== 'ADMIN' || !nextActive)) {
    await assertAnotherActiveAdminExists(userId);
  }

  if (payload.name !== undefined) user.name = payload.name;
  if (payload.phone !== undefined) user.phone = payload.phone;
  if (payload.role !== undefined) user.role = payload.role;
  if (payload.isActive !== undefined) user.isActive = payload.isActive;
  if (payload.assignedClasses !== undefined) user.assignedClasses = payload.assignedClasses;

  if (user.role === 'ADMIN') user.assignedClasses = [];
  if (user.role === 'TEACHER' && user.assignedClasses.length === 0) {
    throw AppError.badRequest('Assign at least one class to a teacher');
  }

  await user.save();
  return toUserDto(user.toObject());
}

export async function setUserActive(
  userId: string,
  isActive: boolean,
  actor: { id: string },
): Promise<UserDto> {
  if (!isActive && userId === actor.id) {
    throw AppError.badRequest('You cannot deactivate your own account');
  }

  const user = await User.findById(userId).select('+refreshTokens');
  if (!user) throw AppError.notFound('User not found');

  if (!isActive && user.role === 'ADMIN') await assertAnotherActiveAdminExists(userId);

  user.isActive = isActive;

  // Deactivating must end current sessions, not just block the next login.
  if (!isActive) {
    const now = new Date();
    for (const token of user.refreshTokens) {
      if (token.revokedAt === null) token.revokedAt = now;
    }
  }

  await user.save();
  return toUserDto(user.toObject());
}

/**
 * Resets another user's password on their behalf.
 *
 * Prefers emailing a setup link, so the new password is chosen by its owner and never
 * passes through the admin. Falls back to a one-time generated password when mail is
 * unavailable or the send fails, which is also the break-glass path when a user has lost
 * access to their inbox.
 */
export async function resetPassword(
  userId: string,
  explicitPassword: string | undefined,
): Promise<CreateUserResult> {
  const user = await User.findById(userId).select(
    '+refreshTokens +passwordResetTokenHash +passwordResetExpiresAt +passwordResetPurpose',
  );
  if (!user) throw AppError.notFound('User not found');

  // Every reset ends current sessions, whichever way the new password is delivered:
  // whoever knew the old one must not keep a live session.
  const now = new Date();
  for (const token of user.refreshTokens) {
    if (token.revokedAt === null) token.revokedAt = now;
  }
  // A reset is also the remedy for a locked-out user.
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  clearPasswordResetToken(user);

  if (!explicitPassword && canSendMail()) {
    // Park the account on a hash nobody holds while the link is outstanding, so the old
    // password stops working the moment the reset is requested.
    user.passwordHash = await unusablePasswordHash();
    user.mustChangePassword = true;
    user.passwordChangedAt = new Date();
    await user.save();

    const { sent } = await issuePasswordSetupLink(user, 'invite');
    if (sent) return { user: toUserDto(user.toObject()), temporaryPassword: null, invited: true };

    const temporaryPassword = await assignTemporaryPassword(user);
    return { user: toUserDto(user.toObject()), temporaryPassword, invited: false };
  }

  const temporaryPassword = explicitPassword ? null : generateTemporaryPassword();
  user.passwordHash = await hashPassword(explicitPassword ?? (temporaryPassword as string));
  user.mustChangePassword = true;
  user.passwordChangedAt = new Date();
  await user.save();

  return { user: toUserDto(user.toObject()), temporaryPassword, invited: false };
}

export async function unlockUser(userId: string): Promise<UserDto> {
  const user = await User.findByIdAndUpdate(
    userId,
    { $set: { failedLoginAttempts: 0, lockedUntil: null } },
    { new: true },
  ).lean<UserDoc>();
  if (!user) throw AppError.notFound('User not found');
  return toUserDto(user);
}

/** The system must never be left without a way in. */
async function assertAnotherActiveAdminExists(excludingUserId: string): Promise<void> {
  const others = await User.countDocuments({
    _id: { $ne: excludingUserId },
    role: 'ADMIN',
    isActive: true,
  });
  if (others === 0) {
    throw AppError.badRequest('This is the last active admin — promote another admin first');
  }
}
