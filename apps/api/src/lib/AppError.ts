/** An error with an intentional HTTP status and a message that is safe to show a user. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: string = 'ERROR',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, message, 'BAD_REQUEST', details);
  }

  static notFound(message = 'Not found'): AppError {
    return new AppError(404, message, 'NOT_FOUND');
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError(409, message, 'CONFLICT', details);
  }

  static forbidden(message = 'You do not have access to this resource'): AppError {
    return new AppError(403, message, 'FORBIDDEN');
  }
}
