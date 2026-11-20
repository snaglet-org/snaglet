import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { ErrorResponse, ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import { logger } from '../config/logger';

/**
 * Global error handler middleware.
 *
 * Converts all errors into standardized ErrorResponse format.
 *
 * Error handling flow:
 * 1. AppError instances → check isOperational flag
 * 2. Operational errors → return their code/status/message
 * 3. Non-operational errors or unknown errors → log and return generic INTERNAL_ERROR
 *
 * Stack traces are never serialized into the HTTP response — they are logged
 * server-side only (via logger.error) to avoid leaking internal paths/structure.
 */
export const errorHandler: ErrorRequestHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Default error response
  let statusCode: number = HTTP_STATUS.INTERNAL_SERVER_ERROR;
  let errorCode = ErrorCode.INTERNAL_ERROR;
  let message = 'An unexpected error occurred';
  let details;

  if (err instanceof AppError) {
    if (err.isOperational) {
      // Known, expected application errors — safe to expose to client
      statusCode = err.statusCode;
      errorCode = err.code;
      message = err.message;
      details = err.details;
    } else {
      // Programmer/non-operational AppError — log and return generic message
      logger.error('Non-operational AppError', { error: err, stack: err.stack });
    }
  } else {
    // Unknown errors - log and return generic message
    logger.error('Unexpected error', { error: err, stack: err.stack });
  }

  // Stack traces are intentionally never serialized into the HTTP response —
  // they are captured server-side via logger.error above. Leaking them to the
  // client exposes absolute server paths and internal structure.
  const response: ErrorResponse = {
    success: false,
    error: {
      code: errorCode,
      message,
      ...(details && { details }),
    },
  };

  res.status(statusCode).json(response);
};

/**
 * 404 Not Found handler.
 */
export const notFoundHandler = (req: Request, res: Response) => {
  const response: ErrorResponse = {
    success: false,
    error: {
      code: ErrorCode.NOT_FOUND,
      message: `Route ${req.method} ${req.path} not found`,
    },
  };

  res.status(HTTP_STATUS.NOT_FOUND).json(response);
};

/**
 * Async route wrapper that catches promise rejections.
 *
 * Usage:
 * ```ts
 * router.get('/user/:id', asyncHandler(async (req, res) => {
 *   const user = await getUserById(req.params.id);
 *   if (!user) throw new AppError('User not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
 *   res.json(user);
 * }));
 * ```
 */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: T, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
