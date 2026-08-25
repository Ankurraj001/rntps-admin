import type { NextFunction, Request, Response } from 'express';
import { Error as MongooseError } from 'mongoose';
import { logger } from '../config/logger.js';
import { isProduction } from '../config/env.js';
import { AppError } from '../lib/AppError.js';
import { isDuplicateKeyError, type DuplicateKeyError } from '../lib/mongoErrors.js';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, `Route not found: ${req.method} ${req.path}`, 'ROUTE_NOT_FOUND'));
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const normalised = normalise(error);

  const logPayload = { err: error, statusCode: normalised.statusCode, path: req.path, method: req.method };
  if (normalised.statusCode >= 500) logger.error(logPayload, normalised.message);
  else logger.warn(logPayload, normalised.message);

  res.status(normalised.statusCode).json({
    error: {
      code: normalised.code,
      message: normalised.statusCode >= 500 && isProduction ? 'Something went wrong' : normalised.message,
      ...(normalised.details ? { details: normalised.details } : {}),
    },
  });
}

function normalise(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message, details: error.details };
  }

  // Duplicate key: the composite _id patterns rely on this being reported cleanly.
  if (isDuplicateKeyError(error)) {
    return {
      statusCode: 409,
      code: 'DUPLICATE_KEY',
      message: describeDuplicate(error),
      details: error.keyValue,
    };
  }

  if (error instanceof MongooseError.ValidationError) {
    return {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Please correct the highlighted fields',
      details: Object.values(error.errors).map((e) => ({ field: e.path, message: e.message })),
    };
  }

  if (error instanceof MongooseError.CastError) {
    return { statusCode: 400, code: 'CAST_ERROR', message: `Invalid value for ${error.path}` };
  }

  return { statusCode: 500, code: 'INTERNAL_ERROR', message: (error as Error)?.message ?? 'Unknown error' };
}

function describeDuplicate(error: DuplicateKeyError): string {
  const keys = Object.keys(error.keyValue ?? {});
  if (keys.includes('_id')) return `A record with ID ${String(error.keyValue?._id)} already exists`;
  if (keys.includes('rollNo')) return 'Another active student in this class already has that roll number';
  if (keys.includes('aadhaar')) return 'Another student already has that Aadhaar number';
  if (keys.includes('apaarId')) return 'Another student already has that APAAR ID';
  return `A record with the same ${keys.join(', ')} already exists`;
}
