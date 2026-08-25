import {
  academicYearFor,
  createStudentSchema,
  listStudentsQuerySchema,
  type CreateStudentInput,
  type CreateStudentPayload,
  type ListStudentsQuery,
} from '@rntps/shared';
import { SETTINGS_ID, Settings } from '../models/Settings.js';

export async function seedSettings(overrides: Record<string, unknown> = {}) {
  return Settings.create({
    _id: SETTINGS_ID,
    schoolName: 'RNTPS',
    activeAcademicYear: academicYearFor(new Date('2026-08-25T00:00:00Z')),
    studentIdPrefix: 'RNTPS',
    feeDueDayOfMonth: 10,
    counters: { student: 0, receipt: 0, family: 0 },
    holidays: [],
    templates: [],
    ...overrides,
  });
}

/**
 * Returns a *parsed* payload, matching what the service receives in production after the
 * validate() middleware has run. Handing the service raw input would let tests pass
 * against data the real API could never produce.
 */
export function studentInput(overrides: Partial<CreateStudentInput> = {}): CreateStudentPayload {
  return createStudentSchema.parse({
    fullName: 'Aarav Sharma',
    dob: '2015-06-14',
    gender: 'MALE',
    classCode: '5',
    rollNo: null,
    admissionDate: '2026-04-01',
    guardians: [{ name: 'Rakesh Sharma', relation: 'FATHER', phone: '9876543210', isPrimary: true }],
    ...overrides,
  } satisfies CreateStudentInput);
}

export function listQuery(overrides: Record<string, unknown> = {}): ListStudentsQuery {
  return listStudentsQuerySchema.parse(overrides);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

import type { ClassCode, UserRole } from '@rntps/shared';
import type { Response } from 'supertest';
import { hashPassword } from '../lib/password.js';
import { signAccessToken } from '../lib/tokens.js';
import { User, type UserHydrated } from '../models/User.js';
import { REFRESH_COOKIE } from '../modules/auth/auth.routes.js';

export const TEST_PASSWORD = 'correct-horse-battery';

export interface TestUserOptions {
  role?: UserRole;
  email?: string;
  name?: string;
  assignedClasses?: ClassCode[];
  password?: string;
  isActive?: boolean;
  mustChangePassword?: boolean;
}

export async function createTestUser(options: TestUserOptions = {}): Promise<UserHydrated> {
  const role = options.role ?? 'ADMIN';
  return User.create({
    name: options.name ?? (role === 'ADMIN' ? 'Admin User' : 'Teacher User'),
    email: options.email ?? `${role.toLowerCase()}@school.test`,
    passwordHash: await hashPassword(options.password ?? TEST_PASSWORD),
    role,
    assignedClasses: role === 'ADMIN' ? [] : (options.assignedClasses ?? ['5']),
    isActive: options.isActive ?? true,
    mustChangePassword: options.mustChangePassword ?? false,
  });
}

/**
 * Mints a token directly rather than going through /login. Authorisation tests care
 * about what a token permits, not about how it was obtained; the login flow itself is
 * covered by the auth route tests.
 */
export async function tokenFor(user: UserHydrated): Promise<string> {
  return signAccessToken({
    sub: String(user._id),
    role: user.role,
    classes: user.role === 'ADMIN' ? [] : [...user.assignedClasses],
    mustChangePassword: user.mustChangePassword,
  });
}

export async function adminAuth(): Promise<{ user: UserHydrated; header: string }> {
  const user = await createTestUser({ role: 'ADMIN' });
  return { user, header: `Bearer ${await tokenFor(user)}` };
}

export async function teacherAuth(
  assignedClasses: ClassCode[] = ['5'],
): Promise<{ user: UserHydrated; header: string }> {
  const user = await createTestUser({ role: 'TEACHER', assignedClasses });
  return { user, header: `Bearer ${await tokenFor(user)}` };
}

/** Pulls the refresh cookie value out of a Set-Cookie header. */
export function refreshCookieFrom(res: Response): string | undefined {
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const match = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  if (!match) return undefined;
  const value = match.split(';')[0]?.split('=')[1];
  return value && value.length > 0 ? value : undefined;
}

export function cookieHeader(token: string): string {
  return `${REFRESH_COOKIE}=${token}`;
}
