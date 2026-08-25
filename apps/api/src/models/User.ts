import { CLASS_CODES, USER_ROLES, type ClassCode, type UserRole } from '@rntps/shared';
import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/**
 * A refresh token is stored only as a SHA-256 hash, so a database leak cannot be
 * replayed as a session. `family` links a token to its rotation chain: presenting an
 * already-rotated token means it was stolen, and the whole family is revoked.
 */
export interface RefreshTokenSub {
  tokenHash: string;
  family: string;
  issuedAt: Date;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  userAgent: string;
}

export interface UserDoc {
  _id: Types.ObjectId;
  name: string;
  email: string;
  phone: string;
  passwordHash: string;
  role: UserRole;
  assignedClasses: ClassCode[];
  isActive: boolean;
  mustChangePassword: boolean;
  /** Shared across every serverless container, unlike the in-memory rate limiter. */
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  /**
   * Readable copy of the password, kept only when STORE_PLAINTEXT_PASSWORDS is on.
   * Never used to authenticate — verification always goes through passwordHash.
   */
  plaintextPassword: string | null;
  /** SHA-256 of the reset token, never the token itself. Single use. */
  passwordResetTokenHash: string | null;
  passwordResetExpiresAt: Date | null;
  refreshTokens: RefreshTokenSub[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const refreshTokenSchema = new Schema<RefreshTokenSub>(
  {
    tokenHash: { type: String, required: true },
    family: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    rotatedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    userAgent: { type: String, default: '' },
  },
  { _id: false },
);

const userSchema = new Schema<UserDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 120 },
    phone: { type: String, default: '' },
    // `select: false` so a stray User.find() cannot leak hashes into a response.
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: USER_ROLES, required: true },
    assignedClasses: { type: [{ type: String, enum: CLASS_CODES }], default: [] },
    isActive: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: true },
    failedLoginAttempts: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    // select:false so it cannot reach a response by accident. Reading it requires the
    // dedicated, audited endpoint.
    plaintextPassword: { type: String, default: null, select: false },
    // select:false so a stray query cannot hand a live reset token to a response.
    passwordResetTokenHash: { type: String, default: null, select: false },
    passwordResetExpiresAt: { type: Date, default: null, select: false },
    refreshTokens: { type: [refreshTokenSchema], default: [], select: false },
    createdBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ 'refreshTokens.tokenHash': 1 });
userSchema.index({ role: 1, isActive: 1 });
// Sparse: only the handful of users with a reset in flight are indexed.
userSchema.index({ passwordResetTokenHash: 1 }, { sparse: true });

export const User = model<UserDoc>('User', userSchema);
export type UserHydrated = HydratedDocument<UserDoc>;
