import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordWithTokenSchema,
  type AuthConfigDto,
} from '@rntps/shared';
import { Router, type CookieOptions, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { clientIp } from '../../app.js';
import { env, isProduction, isTest } from '../../config/env.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/AppError.js';
import { recordAudit } from '../../lib/audit.js';
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
 * Limiters are off under test so the suite is not throttled, except when a test opts in
 * with RATE_LIMIT_IN_TEST — otherwise this behaviour would have no coverage at all.
 *
 * On serverless every limit here is best-effort: each warm container counts separately, so
 * N containers allow N times the limit. The real protections are database-backed and shared
 * by every container — the account lockout in `login`, and the per-account send throttle in
 * `requestPasswordReset`.
 */
function perIpLimit(options: { windowMs: number; limit: number; message: string }) {
  const limiter = rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clientIp,
    validate: { ip: false, xForwardedForHeader: false },
    message: { error: { code: 'RATE_LIMITED', message: options.message } },
  });

  return (req: Request, res: Response, next: NextFunction) => {
    if (limitsActive()) return limiter(req, res, next);
    next();
  };
}

/**
 * Read from `process.env` per request rather than the parsed config, which is frozen at
 * import. A suite that wants to exercise the limits has to be able to switch them on after
 * this module has already loaded, and re-importing the module tree instead would recompile
 * the Mongoose models.
 */
function limitsActive(): boolean {
  return !isTest || process.env.RATE_LIMIT_IN_TEST === 'true';
}

const loginRateLimit = perIpLimit({
  windowMs: 60_000,
  limit: 10,
  message: 'Too many attempts. Wait a minute and try again.',
});

/**
 * Deliberately tighter than login: a password-reset request sends an email, so an
 * unthrottled endpoint is both an account-enumeration probe and a way to use the school's
 * mail quota to spam someone's inbox.
 *
 * Separate instances for requesting and completing a reset. Sharing one — as this used to —
 * made the budget *combined*, so a user who asked for two links could find themselves
 * unable to spend the third request on actually setting a password.
 */
const forgotPasswordRateLimit = perIpLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  message: 'Too many reset requests. Try again in a few minutes.',
});

const resetPasswordRateLimit = perIpLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  message: 'Too many attempts. Try again in a few minutes.',
});

/**
 * Guards `currentPassword` against brute force. This path had no limiter and no lockout,
 * so an attacker holding a stolen access token could grind at the global 200/min.
 */
const changePasswordRateLimit = perIpLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  message: 'Too many attempts. Try again in a few minutes.',
});

export const authRoutes = Router();

authRoutes.post(
  '/login',
  loginRateLimit,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = validatedBody(req, loginSchema);

    let result;
    try {
      result = await service.login(email, password, req.get('user-agent') ?? '');
    } catch (error) {
      // Worth a durable record: repeated hits on a locked account are what a brute-force
      // attempt looks like from the outside. Failed guesses are only logged, not audited —
      // they are far too numerous, and each one would carry an address into a two-year table.
      if (error instanceof AppError && error.code === 'ACCOUNT_LOCKED') {
        await recordAudit(req, { action: 'auth.login-blocked', entity: 'auth', entityId: email });
      }
      throw error;
    }

    const { tokens, user } = result;
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
 *
 * `passwordResetByEmail` reflects whether mail can actually be *delivered*, not merely
 * whether credentials are set, so the forgotten-password page never promises an email the
 * server cannot send.
 */
authRoutes.get(
  '/config',
  asyncHandler(async (_req, res) => {
    const config: AuthConfigDto = {
      passwordResetByEmail: await service.isPasswordResetByEmailAvailable(),
      passwordResetTtlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
    };
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

    // Recorded whether or not the address exists — the route genuinely does not know, which
    // is the same property that keeps the response from leaking. A burst of these against
    // unknown addresses is what enumeration looks like after the fact.
    await recordAudit(req, {
      action: 'auth.password-reset-requested',
      entity: 'auth',
      entityId: email,
    });

    // Always 204, whether or not the address exists. Anything else would let a caller
    // enumerate which staff addresses are registered.
    res.status(204).end();
  }),
);

authRoutes.post(
  '/reset-password',
  resetPasswordRateLimit,
  validate(resetPasswordWithTokenSchema),
  asyncHandler(async (req, res) => {
    const { token, newPassword } = validatedBody(req, resetPasswordWithTokenSchema);
    const { userId, purpose } = await service.resetPasswordWithToken(token, newPassword);

    await recordAudit(req, {
      action: 'auth.password-reset-completed',
      entity: 'user',
      entityId: userId,
      after: { purpose },
    });

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
  changePasswordRateLimit,
  requireAuth({ allowPasswordChangePending: true }),
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = validatedBody(req, changePasswordSchema);
    const userId = currentUser(req).id;
    await service.changePassword(userId, currentPassword, newPassword);

    await recordAudit(req, { action: 'auth.password-changed', entity: 'user', entityId: userId });

    // Every session was just revoked, so the browser must not keep the stale cookie.
    clearRefreshCookie(res);
    res.status(204).end();
  }),
);
