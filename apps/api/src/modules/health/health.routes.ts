import { Router } from 'express';
import { isDatabaseReady } from '../../config/db.js';
import { env } from '../../config/env.js';

export const healthRoutes = Router();

/** Liveness: the process is up. Used by the platform to decide whether to restart. */
healthRoutes.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), env: env.NODE_ENV });
});

/** Readiness: the process can actually serve traffic, i.e. the database answers. */
healthRoutes.get('/readyz', (_req, res) => {
  const ready = isDatabaseReady();
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', database: ready });
});
