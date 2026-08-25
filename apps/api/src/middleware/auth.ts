import type { ClassCode, UserRole } from '@rntps/shared';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/AppError.js';
import { verifyAccessToken } from '../lib/tokens.js';

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  classes: string[];
  mustChangePassword: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Rejects anything without a valid access token.
 *
 * A user who must change their password is authenticated but deliberately confined:
 * only /auth/me, /auth/change-password and /auth/logout are reachable, so a temporary
 * password cannot be used to browse student records indefinitely.
 */
export function requireAuth(options: { allowPasswordChangePending?: boolean } = {}) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = bearerToken(req);
    if (!token) {
      next(new AppError(401, 'Sign in to continue', 'UNAUTHENTICATED'));
      return;
    }

    const claims = await verifyAccessToken(token);
    if (!claims) {
      next(new AppError(401, 'Your session has expired. Please sign in again.', 'UNAUTHENTICATED'));
      return;
    }

    req.user = {
      id: claims.sub,
      role: claims.role,
      classes: claims.classes,
      mustChangePassword: claims.mustChangePassword,
    };

    if (claims.mustChangePassword && !options.allowPasswordChangePending) {
      next(new AppError(403, 'Set a new password before continuing', 'PASSWORD_CHANGE_REQUIRED'));
      return;
    }

    next();
  };
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError(401, 'Sign in to continue', 'UNAUTHENTICATED'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(AppError.forbidden('You do not have permission to do that'));
      return;
    }
    next();
  };
}

/**
 * Confines a teacher to their assigned classes. Admins pass through.
 *
 * The class is read from wherever the route puts it, because a teacher must not be able
 * to reach another class by moving the parameter from the query string into the body.
 */
export function requireClassAccess(
  extract: (req: Request) => string | string[] | undefined = defaultClassExtractor,
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError(401, 'Sign in to continue', 'UNAUTHENTICATED'));
      return;
    }
    if (req.user.role === 'ADMIN') {
      next();
      return;
    }

    const requested = extract(req);
    const codes = (Array.isArray(requested) ? requested : [requested]).filter(
      (c): c is string => typeof c === 'string' && c.length > 0,
    );

    if (codes.length === 0) {
      next(AppError.badRequest('A class must be specified'));
      return;
    }

    const allowed = new Set(req.user.classes);
    const denied = codes.filter((code) => !allowed.has(code));
    if (denied.length > 0) {
      next(AppError.forbidden(`You are not assigned to ${denied.join(', ')}`));
      return;
    }

    next();
  };
}

function defaultClassExtractor(req: Request): string | string[] | undefined {
  const fromParams = (req.params as Record<string, unknown>).classCode;
  if (typeof fromParams === 'string') return fromParams;

  const fromQuery = (req.query as Record<string, unknown>).classCode;
  if (typeof fromQuery === 'string') return fromQuery;

  const fromBody = (req.body as Record<string, unknown> | undefined)?.classCode;
  if (typeof fromBody === 'string') return fromBody;

  return undefined;
}

/** Narrows to a definitely-authenticated user inside a handler. */
export function currentUser(req: Request): AuthenticatedUser {
  if (!req.user) throw new AppError(401, 'Sign in to continue', 'UNAUTHENTICATED');
  return req.user;
}

export function isClassAllowed(user: AuthenticatedUser, classCode: ClassCode | string): boolean {
  return user.role === 'ADMIN' || user.classes.includes(classCode);
}
