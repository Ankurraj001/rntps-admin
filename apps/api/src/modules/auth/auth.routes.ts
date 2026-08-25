import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordWithTokenSchema,
  type AuthConfigDto,
} from '@rntps/shared';
import { Router, type CookieOptions, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { clientIp } from '../../app.js';
import { env, isProduction, isTest } from '../../config/env.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/AppError.js';
import { canSendMail } from '../../lib/mailer.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';
import { validate, validatedBody } from '../../middleware/validate.js';
import * as service from './auth.service.js';

export const REFRESH_COOKIE = 'rntps_rt';

/**
 * The SPA and the API share one Netlify origin, so this cookie is first-party and can
 * stay SameSite=Strict. A split frontend/backend deployment would force SameSite=None,
 * which Safari blocks outright.
 *
 * Path is scoped to the auth routes so the token is not attached to every API call.
 */
function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions());
}

function clearRefreshCookie(res: Response): void {
  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE, options);
}

function readRefreshCookie(req: Request): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A tight per-IP limit in front of login. On serverless this is best-effort — each warm
 * container counts separately — so the database-backed account lockout in the service
 * is the real protection. This just blunts the cheapest attacks.
 */
const loginRateLimit = isTest
  ? (_req: Request, _res: Response, next: () => void) => next()
  : rateLimit({
      windowMs: 60_000,
      limit: 10,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: clientIp,
      validate: { ip: false, xForwardedForHeader: false },
      message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute and try again.' } },
    });

/**
 * Deliberately tighter than login: a password-reset request sends an email, so an
 * unthrottled endpoint is both an account-enumeration probe and a way to use the school's
 * mail quota to spam someone's inbox.
 */
const forgotPasswordRateLimit = isTest
  ? (_req: Request, _res: Response, next: () => void) => next()
  : rateLimit({
      windowMs: 15 * 60_000,
      limit: 5,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: clientIp,
      validate: { ip: false, xForwardedForHeader: false },
      message: {
        error: { code: 'RATE_LIMITED', message: 'Too many reset requests. Try again in a few minutes.' },
      },
    });

export const authRoutes = Router();

authRoutes.post(
  '/login',
  loginRateLimit,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = validatedBody(req, loginSchema);
    const { tokens, user } = await service.login(email, password, req.get('user-agent') ?? '');

    setRefreshCookie(res, tokens.refreshToken);
    res.json({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, user });
  }),
);

authRoutes.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const presented = readRefreshCookie(req);
    if (!presented) {
      throw new AppError(401, 'Your session has expired. Please sign in again.', 'INVALID_REFRESH');
    }

    try {
      const { tokens, user } = await service.refresh(presented, req.get('user-agent') ?? '');
      setRefreshCookie(res, tokens.refreshToken);
      res.json({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, user });
    } catch (error) {
      // A dead token should not keep being replayed by the browser on every page load.
      clearRefreshCookie(res);
      throw error;
    }
  }),
);

authRoutes.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await service.logout(readRefreshCookie(req));
    clearRefreshCookie(res);
    res.status(204).end();
  }),
);

/**
 * Public, and deliberately so: the sign-in screens need it before anyone is authenticated.
 *
 * It reveals only whether the server can send mail at all — not whether any account
 * exists — so it gives an attacker nothing.
 */
authRoutes.get(
  '/config',
  asyncHandler(async (_req, res) => {
    const config: AuthConfigDto = { passwordResetByEmail: canSendMail() };
    res.json(config);
  }),
);

authRoutes.post(
  '/forgot-password',
  forgotPasswordRateLimit,
  validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const { email } = validatedBody(req, forgotPasswordSchema);
    await service.requestPasswordReset(email, env.APP_BASE_URL);

    // Always 204, whether or not the address exists. Anything else would let a caller
    // enumerate which staff addresses are registered.
    res.status(204).end();
  }),
);

authRoutes.post(
  '/reset-password',
  forgotPasswordRateLimit,
  validate(resetPasswordWithTokenSchema),
  asyncHandler(async (req, res) => {
    const { token, newPassword } = validatedBody(req, resetPasswordWithTokenSchema);
    await service.resetPasswordWithToken(token, newPassword);

    // The token revoked every session, so there is nothing to keep in the browser.
    clearRefreshCookie(res);
    res.status(204).end();
  }),
);

authRoutes.get(
  '/me',
  requireAuth({ allowPasswordChangePending: true }),
  asyncHandler(async (req, res) => {
    res.json(await service.getUserById(currentUser(req).id));
  }),
);

authRoutes.post(
  '/change-password',
  requireAuth({ allowPasswordChangePending: true }),
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = validatedBody(req, changePasswordSchema);
    await service.changePassword(currentUser(req).id, currentPassword, newPassword);

    // Every session was just revoked, so the browser must not keep the stale cookie.
    clearRefreshCookie(res);
    res.status(204).end();
  }),
);
