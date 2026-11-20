import { ErrorCode, type ValidationError } from '../types/error';

/**
 * Extract a human-readable message from an unknown caught value.
 *
 * Prefers `Error.message`, falls back to the provided default (or a generic string).
 * Duck-types the message rather than relying on `instanceof Error`: a genuine
 * Error thrown across a module realm (e.g. an `fs` error under Node's VM-module
 * loader, which the test harness uses) fails `instanceof` against this realm's
 * Error while still carrying a real string `message`, and we must surface that.
 */
export function getErrorMessage(error: unknown, fallback = 'An unexpected error occurred'): string {
  if (typeof error === 'string') return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string' &&
    (error as { message: string }).message.length > 0
  ) {
    return (error as { message: string }).message;
  }
  return fallback;
}

/**
 * Base application error class.
 *
 * Extends Error with error code, HTTP status, and optional validation details.
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly details?: ValidationError[] | Record<string, unknown>;

  constructor(
    message: string,
    code: ErrorCode,
    statusCode: number,
    isOperational = true,
    details?: ValidationError[] | Record<string, unknown>
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;

    const captureStackTrace = (
      Error as unknown as {
        captureStackTrace?: (target: object, ctor: Function) => void;
      }
    ).captureStackTrace;
    if (typeof captureStackTrace === 'function') {
      captureStackTrace(this, this.constructor);
    }

    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class AuthError extends AppError {
  constructor(message: string, code: ErrorCode = ErrorCode.AUTH_REQUIRED) {
    const statusCode = code === ErrorCode.FORBIDDEN ? 403 : 401;
    super(message, code, statusCode);
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, ErrorCode.CONFLICT, 409);
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests, please try again later') {
    super(message, ErrorCode.RATE_LIMIT_EXCEEDED, 429);
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}
