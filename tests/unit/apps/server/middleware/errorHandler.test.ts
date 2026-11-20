import type { Request, Response, NextFunction } from 'express';
import { errorHandler, notFoundHandler, asyncHandler } from '@server/middleware/errorHandler';
import { AppError, AuthError } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';

jest.mock('@server/config/logger', () => ({
  logger: {
    error: jest.fn(),
    http: jest.fn(),
  },
  httpLogStream: {
    write: jest.fn(),
  },
}));

describe('errorHandler middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let jsonSpy: jest.Mock;
  let statusSpy: jest.Mock;

  beforeEach(() => {
    mockReq = {
      method: 'GET',
      path: '/test',
    };
    jsonSpy = jest.fn();
    statusSpy = jest.fn(() => ({ json: jsonSpy }));
    mockRes = {
      status: statusSpy as unknown as Response['status'],
    };
    mockNext = jest.fn();

    process.env.NODE_ENV = 'test';
  });

  it('should handle AppError instances with correct status and response', () => {
    const error = new AppError(
      'Test error message',
      ErrorCode.INVALID_INPUT,
      HTTP_STATUS.BAD_REQUEST
    );

    errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

    expect(statusSpy).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST);
    expect(jsonSpy).toHaveBeenCalledWith({
      success: false,
      error: {
        code: ErrorCode.INVALID_INPUT,
        message: 'Test error message',
      },
    });
  });

  it('should handle AuthError with 401 status', () => {
    const error = new AuthError('Authentication required');

    errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

    expect(statusSpy).toHaveBeenCalledWith(HTTP_STATUS.UNAUTHORIZED);
    expect(jsonSpy).toHaveBeenCalledWith({
      success: false,
      error: {
        code: ErrorCode.AUTH_REQUIRED,
        message: 'Authentication required',
      },
    });
  });

  // The handler reads code/status/details off AppError itself, so validation
  // and not-found behaviors are pinned through the base class.
  it('should forward validation details from AppError', () => {
    const validationDetails = [
      { field: 'email', message: 'Email is required' },
      { field: 'password', message: 'Password must be at least 8 characters' },
    ];
    const error = new AppError(
      'Validation failed',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST,
      true,
      validationDetails
    );

    errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

    expect(statusSpy).toHaveBeenCalledWith(HTTP_STATUS.BAD_REQUEST);
    expect(jsonSpy).toHaveBeenCalledWith({
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Validation failed',
        details: validationDetails,
      },
    });
  });

  it('should handle not-found AppError with 404 status', () => {
    const error = new AppError('User not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

    expect(statusSpy).toHaveBeenCalledWith(HTTP_STATUS.NOT_FOUND);
    expect(jsonSpy).toHaveBeenCalledWith({
      success: false,
      error: {
        code: ErrorCode.NOT_FOUND,
        message: 'User not found',
      },
    });
  });

  it('should handle unknown errors as internal server errors', () => {
    const error = new Error('Something went wrong');

    errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

    expect(statusSpy).toHaveBeenCalledWith(HTTP_STATUS.INTERNAL_SERVER_ERROR);
    expect(jsonSpy).toHaveBeenCalledWith({
      success: false,
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred',
      },
    });
    expect(logger.error).toHaveBeenCalledWith('Unexpected error', {
      error,
      stack: error.stack,
    });
  });

  it('never includes a stack trace in the response, even in development', () => {
    // Stacks are logged server-side only and never reach the response,
    // regardless of NODE_ENV.
    process.env.NODE_ENV = 'development';
    const error = new AppError('Test error', ErrorCode.INVALID_INPUT, HTTP_STATUS.BAD_REQUEST);

    errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

    const response = jsonSpy.mock.calls[0][0];
    expect(response.error.stack).toBeUndefined();
  });

  it('should not include stack trace in production mode', () => {
    process.env.NODE_ENV = 'production';
    const error = new AppError('Test error', ErrorCode.INVALID_INPUT, HTTP_STATUS.BAD_REQUEST);

    errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

    const response = jsonSpy.mock.calls[0][0];
    expect(response.error.stack).toBeUndefined();
  });
});

describe('notFoundHandler middleware', () => {
  it('should return 404 with route information', () => {
    const mockReq = {
      method: 'GET',
      path: '/api/unknown',
    } as Request;
    const jsonSpy = jest.fn();
    const statusSpy = jest.fn(() => ({ json: jsonSpy }));
    const mockRes = {
      status: statusSpy as unknown as Response['status'],
    } as Response;

    notFoundHandler(mockReq, mockRes);

    expect(statusSpy).toHaveBeenCalledWith(HTTP_STATUS.NOT_FOUND);
    expect(jsonSpy).toHaveBeenCalledWith({
      success: false,
      error: {
        code: ErrorCode.NOT_FOUND,
        message: 'Route GET /api/unknown not found',
      },
    });
  });
});

describe('asyncHandler wrapper', () => {
  it('should catch async errors and pass to next', async () => {
    const error = new Error('Async error');
    const asyncFn = jest.fn().mockRejectedValue(error);
    const mockNext = jest.fn();

    const handler = asyncHandler(asyncFn);
    await handler({} as Request, {} as Response, mockNext);

    expect(mockNext).toHaveBeenCalledWith(error);
  });

  it('should not call next if async function succeeds', async () => {
    const asyncFn = jest.fn().mockResolvedValue(undefined);
    const mockNext = jest.fn();

    const handler = asyncHandler(asyncFn);
    await handler({} as Request, {} as Response, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
  });
});
