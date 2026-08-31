import { z } from 'zod';
import { CLASS_CODES, USER_ROLES, type UserRole } from '../constants.js';
import { optionalText, phoneInputSchema } from './common.js';

/**
 * Minimum length is the primary strength lever for a school with a handful of staff
 * accounts; a composition rule ("one symbol") mostly produces Password1! in practice.
 * NIST 800-63B recommends length over composition, and sets 8 as its floor for a
 * user-chosen secret.
 *
 * Exported so the API and the two password forms cannot drift apart — the forms used to
 * carry their own copy of the number, which is three places to miss when it changes.
 */
export const PASSWORD_MIN_LENGTH = 8;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(200, 'Password is too long')
  // Length after trimming, so the minimum cannot be met with spaces. Skipped when the raw
  // value is already too short: .min() has reported that, and adding "mostly spaces" to a
  // password containing none reads like a second, wrong complaint.
  .refine(
    (value) => value.length < PASSWORD_MIN_LENGTH || value.trim().length >= PASSWORD_MIN_LENGTH,
    'Password cannot be mostly spaces',
  );

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(120);

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(200),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(200),
    newPassword: passwordSchema,
  })
  .refine((body) => body.currentPassword !== body.newPassword, {
    path: ['newPassword'],
    message: 'Choose a password you have not used here before',
  });

export const createUserSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is required').max(80),
    email: emailSchema,
    phone: optionalText(phoneInputSchema),
    role: z.enum(USER_ROLES),
    /** Teachers may only mark attendance for the classes listed here. */
    assignedClasses: z.array(z.enum(CLASS_CODES)).max(CLASS_CODES.length).default([]),
    /** Omit to have the server generate a temporary password to hand over. */
    password: optionalText(passwordSchema),
  })
  .superRefine((user, ctx) => {
    if (user.role === 'TEACHER' && user.assignedClasses.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['assignedClasses'],
        message: 'Assign at least one class, or the teacher will not be able to do anything',
      });
    }
    if (user.role === 'ADMIN' && user.assignedClasses.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['assignedClasses'],
        message: 'Admins already have access to every class',
      });
    }
  });

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  phone: optionalText(phoneInputSchema),
  role: z.enum(USER_ROLES).optional(),
  assignedClasses: z.array(z.enum(CLASS_CODES)).optional(),
  isActive: z.boolean().optional(),
});

export const resetPasswordSchema = z.object({
  /** Omit to have the server generate one. */
  newPassword: optionalText(passwordSchema),
});

export type LoginPayload = z.output<typeof loginSchema>;
export type CreateUserPayload = z.output<typeof createUserSchema>;
export type CreateUserInput = z.input<typeof createUserSchema>;
export type UpdateUserPayload = z.output<typeof updateUserSchema>;

export interface UserDto {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  assignedClasses: string[];
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  isLocked: boolean;
  /**
   * When the holder last proved they control the address, by completing an emailed link.
   * Null means nobody ever has — most often because an admin mistyped it, which is
   * otherwise invisible until someone reports never receiving mail.
   */
  emailVerifiedAt: string | null;
  createdAt: string;
}

export interface LoginResponse {
  accessToken: string;
  /** Seconds until the access token expires, so the client can refresh ahead of time. */
  expiresIn: number;
  user: UserDto;
}

/** Returned when an admin creates a user or resets a password without supplying one. */
export interface TemporaryPasswordResponse {
  user: UserDto;
  temporaryPassword: string;
}

/** Convenience for the frontend: does this user control this class? */
export function canAccessClass(user: Pick<UserDto, 'role' | 'assignedClasses'>, classCode: string): boolean {
  if (user.role === 'ADMIN') return true;
  return user.assignedClasses.includes(classCode);
}

/**
 * What the sign-in screens are allowed to offer, fetched before anything is typed.
 *
 * Exists so the app can tell the truth about self-service reset. Without it the forgotten
 * password page promises an email that a server with no SMTP credentials will never send,
 * and the user waits for it.
 */
export interface AuthConfigDto {
  /** False when no mail transport is configured or reachable, so no link can be delivered. */
  passwordResetByEmail: boolean;
  /** How long a reset link lasts, so the page states the real figure rather than a guess. */
  passwordResetTtlMinutes: number;
}
