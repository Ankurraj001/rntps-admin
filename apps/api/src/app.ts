import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { env, isTest } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';
import { rejectMongoOperators } from './middleware/validate.js';
import { attendanceRoutes } from './modules/attendance/attendance.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { expenseRoutes } from './modules/expenses/expenses.routes.js';
import { feesRoutes } from './modules/fees/fees.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { notificationRoutes } from './modules/notifications/notifications.routes.js';
import { reportRoutes } from './modules/reports/reports.routes.js';
import { settingsRoutes } from './modules/settings/settings.routes.js';
import { studentRoutes } from './modules/students/student.routes.js';
import { userRoutes } from './modules/users/user.routes.js';

export function createApp(): Express {
  const app = express();

  // Render/Vercel sit behind a proxy; without this the rate limiter sees one client IP.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      // Required for the refresh cookie in local dev, where the SPA and API sit on
      // different ports. In production they share one Netlify origin and CORS is unused.
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(requestId);
  app.use(rejectMongoOperators);

  if (!isTest) {
    app.use(
      rateLimit({
        windowMs: 60_000,
        limit: 200,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        keyGenerator: clientIp,
        // The built-in checks assume a socket-backed req.ip, which does not exist in a
        // serverless invocation; clientIp() covers that case instead.
        validate: { ip: false, xForwardedForHeader: false },
      }),
    );
  }

  // Mounted twice on purpose: at the root for local dev and any platform health check,
  // and under /api so a single Netlify rewrite (/api/* -> the function) covers the
  // probes as well as the API.
  app.use(healthRoutes);
  app.use('/api', healthRoutes);

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/users', userRoutes);
  app.use('/api/v1/attendance', attendanceRoutes);
  app.use('/api/v1/expenses', expenseRoutes);
  app.use('/api/v1/fees', feesRoutes);
  app.use('/api/v1/notifications', notificationRoutes);
  app.use('/api/v1/reports', reportRoutes);
  app.use('/api/v1/students', studentRoutes);
  app.use('/api/v1/settings', settingsRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * The client IP, wherever it is actually available.
 *
 * On Netlify there is no socket, so `req.ip` is undefined and express-rate-limit throws
 * ERR_ERL_UNDEFINED_IP_ADDRESS; Netlify puts the real address in
 * `x-nf-client-connection-ip`. On a persistent server `req.ip` is populated from the
 * socket via `trust proxy`.
 *
 * NOTE: on serverless this limiter is best-effort only — each warm container keeps its
 * own in-memory counter, so N containers allow N times the limit. Real brute-force
 * protection is the database-backed account lockout in the auth module, which every
 * container shares.
 */
export function clientIp(req: Request): string {
  const netlifyIp = req.get('x-nf-client-connection-ip');
  if (netlifyIp) return netlifyIp;

  const forwarded = req.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first) return first;

  return req.ip ?? 'unknown';
}
