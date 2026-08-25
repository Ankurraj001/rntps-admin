import type { CreateUserPayload, UpdateUserPayload, UserDto } from '@rntps/shared';
import { AppError } from '../../lib/AppError.js';
import { generateTemporaryPassword, hashPassword } from '../../lib/password.js';
import { isPlaintextStorageEnabled, plaintextFieldFor } from '../../lib/plaintextPassword.js';
import { isDuplicateKeyError } from '../../lib/mongoErrors.js';
import { User, type UserDoc } from '../../models/User.js';
import { toUserDto } from '../auth/auth.service.js';

export async function listUsers(): Promise<UserDto[]> {
  const users = await User.find().sort({ name: 1 }).lean<UserDoc[]>();
  return users.map(toUserDto);
}

export async function createUser(
  payload: CreateUserPayload,
  actorId: string | null,
): Promise<{ user: UserDto; temporaryPassword: string | null }> {
  // Admins reach every class, so a stored list would only ever drift out of date.
  const assignedClasses = payload.role === 'ADMIN' ? [] : payload.assignedClasses;

  const temporaryPassword = payload.password ? null : generateTemporaryPassword();
  const password = payload.password ?? (temporaryPassword as string);
  const passwordHash = await hashPassword(password);

  try {
    const created = await User.create({
      name: payload.name,
      email: payload.email,
      phone: payload.phone ?? '',
      passwordHash,
      ...plaintextFieldFor(password),
      role: payload.role,
      assignedClasses,
      isActive: true,
      // Always true: an admin who typed the password knows it, so the new user should
      // still replace it with something only they know.
      mustChangePassword: true,
      createdBy: actorId,
    });

    return { user: toUserDto(created.toObject()), temporaryPassword };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw AppError.conflict(`${payload.email} already has an account`);
    }
    throw error;
  }
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

export async function resetPassword(
  userId: string,
  explicitPassword: string | undefined,
): Promise<{ user: UserDto; temporaryPassword: string | null }> {
  const user = await User.findById(userId).select('+refreshTokens +plaintextPassword');
  if (!user) throw AppError.notFound('User not found');

  const temporaryPassword = explicitPassword ? null : generateTemporaryPassword();
  const password = explicitPassword ?? (temporaryPassword as string);
  user.passwordHash = await hashPassword(password);
  user.plaintextPassword = plaintextFieldFor(password).plaintextPassword;
  user.mustChangePassword = true;
  user.passwordChangedAt = new Date();
  // A reset is also the remedy for a locked-out user.
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;

  const now = new Date();
  for (const token of user.refreshTokens) {
    if (token.revokedAt === null) token.revokedAt = now;
  }

  await user.save();
  return { user: toUserDto(user.toObject()), temporaryPassword };
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

/**
 * Returns the stored readable password, so an admin can tell a teacher what theirs is.
 *
 * Every call is audited by the route, because "who looked at whose password" is exactly
 * the question you want answerable after the fact.
 */
export async function revealPassword(userId: string): Promise<{ password: string }> {
  if (!isPlaintextStorageEnabled()) {
    throw new AppError(
      409,
      'Readable passwords are not being stored. Set STORE_PLAINTEXT_PASSWORDS=true, or use Reset to issue a new password.',
      'PLAINTEXT_DISABLED',
    );
  }

  const user = await User.findById(userId).select('+plaintextPassword').lean<UserDoc>();
  if (!user) throw AppError.notFound('User not found');

  if (!user.plaintextPassword) {
    throw new AppError(
      409,
      'No readable password on record for this user — it was set before this was switched on. Use Reset to issue a new one.',
      'NO_PLAINTEXT_STORED',
    );
  }

  return { password: user.plaintextPassword };
}
