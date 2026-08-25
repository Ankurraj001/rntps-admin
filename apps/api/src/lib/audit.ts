import type { Request } from 'express';
import { clientIp } from '../app.js';
import { logger } from '../config/logger.js';
import { AuditLog } from '../models/AuditLog.js';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

const REDACTED_FIELDS = new Set([
  'passwordHash',
  'password',
  'plaintextPassword',
  'refreshTokens',
  'temporaryPassword',
]);

/** Strips secrets before they reach a long-lived audit record. */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_FIELDS.has(key) ? '[redacted]' : scrub(child, depth + 1);
  }
  return out;
}

/**
 * Writes an audit record. Deliberately never throws: an audit failure must not turn a
 * successful mutation into a 500 the caller retries.
 */
export async function recordAudit(req: Request, entry: AuditEntry): Promise<void> {
  try {
    await AuditLog.create({
      actorId: req.user?.id ?? null,
      actorName: req.user?.role ?? 'system',
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      before: scrub(entry.before ?? null),
      after: scrub(entry.after ?? null),
      ip: clientIp(req),
      at: new Date(),
    });
  } catch (error) {
    logger.error({ err: error, action: entry.action }, 'failed to write audit log');
  }
}
