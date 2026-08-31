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
  /** SHA-256 of the reset token, never the token itself. Single use. */
  passwordResetTokenHash: string | null;
  passwordResetExpiresAt: Date | null;
  /**
   * What the outstanding link is for. Only changes the wording of the email and the page
   * — never what the token authorises, so a tampered `mode` in the URL buys nothing.
   */
  passwordResetPurpose: 'invite' | 'reset' | null;
  /**
   * Per-account throttle for reset requests. The IP limiter in front of the route is
   * per-container on serverless, so an attacker rotating addresses could otherwise flood
   * one inbox; this counter is shared by every container.
   */
  passwordResetRequestedAt: Date | null;
  passwordResetRequestCount: number;
  /**
   * When the holder last proved they control this address, by completing an emailed link.
   * Null means nobody has ever confirmed it — an admin may simply have mistyped it.
   */
  emailVerifiedAt: Date | null;
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
    // select:false so a stray query cannot hand a live reset token to a response.
    passwordResetTokenHash: { type: String, default: null, select: false },
    passwordResetExpiresAt: { type: Date, default: null, select: false },
    passwordResetPurpose: { type: String, enum: ['invite', 'reset'], default: null, select: false },
    passwordResetRequestedAt: { type: Date, default: null, select: false },
    passwordResetRequestCount: { type: Number, default: 0, min: 0, select: false },
    emailVerifiedAt: { type: Date, default: null },
    refreshTokens: { type: [refreshTokenSchema], default: [], select: false },
    createdBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ 'refreshTokens.tokenHash': 1 });
userSchema.index({ role: 1, isActive: 1 });
// Partial, not sparse: the field defaults to null rather than being absent, so `sparse`
// would still index every user. Matching on $type narrows it to the handful with a reset
// actually in flight.
userSchema.index(
  { passwordResetTokenHash: 1 },
  { partialFilterExpression: { passwordResetTokenHash: { $type: 'string' } } },
);

export const User = model<UserDoc>('User', userSchema);
export type UserHydrated = HydratedDocument<UserDoc>;
