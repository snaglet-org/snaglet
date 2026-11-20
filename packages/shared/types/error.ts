/**
 * Standardized error response structure for all API endpoints.
 *
 * All errors follow this format to ensure consistent client-side handling.
 */

/**
 * Standard error codes for consistent client-side handling.
 */
export enum ErrorCode {
  // Authentication & Authorization
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  AUTH_INVALID = 'AUTH_INVALID',
  AUTH_EXPIRED = 'AUTH_EXPIRED',
  FORBIDDEN = 'FORBIDDEN',

  // Validation
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_INPUT = 'INVALID_INPUT',

  // Resources
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',

  // Server
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',

  // Rate Limiting
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
}

/**
 * Validation error detail for a specific field.
 */
export type ValidationError = {
  field: string;
  message: string;
  value?: unknown;
};

/**
 * Standardized error response body.
 *
 * @example
 * {
 *   error: {
 *     code: 'VALIDATION_ERROR',
 *     message: 'Invalid request data',
 *     details: [
 *       { field: 'email', message: 'Email is required' }
 *     ]
 *   }
 * }
 */
export type ErrorResponse = {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level validation errors, or a structured details object. */
    details?: ValidationError[] | Record<string, unknown>;
    stack?: string; // Only included in development
  };
};

/**
 * HTTP status codes used by the API.
 *
 * Mapping from error codes to HTTP status codes:
 * - AUTH_REQUIRED, AUTH_INVALID, AUTH_EXPIRED → 401 Unauthorized
 * - FORBIDDEN → 403 Forbidden
 * - NOT_FOUND → 404 Not Found
 * - VALIDATION_ERROR, INVALID_INPUT → 400 Bad Request
 * - CONFLICT → 409 Conflict
 * - VALIDATION_ERROR for a body or file over its size limit → 413 Payload Too Large
 * - RATE_LIMIT_EXCEEDED → 429 Too Many Requests
 * - INTERNAL_ERROR → 500 Internal Server Error
 * - SERVICE_UNAVAILABLE → 503 Service Unavailable, or 504 Gateway Timeout
 *   when an internal pipeline or upstream call exceeds its time budget
 */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;
