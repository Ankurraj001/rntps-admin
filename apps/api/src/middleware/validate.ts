import type { NextFunction, Request, Response } from 'express';
import { ZodError, type z, type ZodTypeAny } from 'zod';
import { AppError } from '../lib/AppError.js';

type Source = 'body' | 'query' | 'params';

/**
 * Validates and *replaces* the request part with the parsed output, so handlers work
 * with coerced, defaulted, normalised values rather than raw strings.
 */
export function validate(schema: ZodTypeAny, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(req[source]);
      if (source === 'query') {
        // Express 5 exposes req.query via a getter, so it is redefined rather than assigned.
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      } else {
        req[source] = parsed;
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(
          AppError.badRequest(
            'Please correct the highlighted fields',
            error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
          ),
        );
        return;
      }
      next(error);
    }
  };
}

/**
 * Blocks Mongo operator injection: a JSON body such as {"fullName": {"$ne": null}} would
 * otherwise reach a query untouched.
 */
export function rejectMongoOperators(req: Request, _res: Response, next: NextFunction): void {
  const offending = findOperatorKey(req.body) ?? findOperatorKey(req.query);
  if (offending) {
    next(AppError.badRequest(`Invalid field name: ${offending}`));
    return;
  }
  next();
}

function findOperatorKey(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // `$` and `.` are checked anywhere in the key, not just at the start: Express's
    // default query parser leaves `status[$ne]=x` as one flat literal key, so a
    // startsWith check would wave it straight through.
    if (key.includes('$') || key.includes('.')) return key;
    const nested = findOperatorKey(child, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * Typed readers for data that `validate()` has already parsed. The schema argument is
 * only there for inference — it is not re-run, so handlers stay a single parse deep.
 */
export function validatedBody<T extends ZodTypeAny>(req: Request, _schema: T): z.output<T> {
  return req.body as z.output<T>;
}

export function validatedQuery<T extends ZodTypeAny>(req: Request, _schema: T): z.output<T> {
  return req.query as unknown as z.output<T>;
}
