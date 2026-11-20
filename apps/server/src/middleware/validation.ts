import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodSchema, ZodError } from 'zod';

/**
 * Validate request body against a Zod schema.
 * Returns 400 with validation errors if schema validation fails.
 *
 * @example
 * const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
 * router.post('/login', validateBody(loginSchema), loginHandler);
 */
export function validateBody<T extends ZodSchema>(schema: T): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: error.errors.map((err) => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        });
        return;
      }
      res.status(400).json({ error: 'Invalid request body' });
    }
  };
}

/**
 * Validate request query parameters against a Zod schema.
 * Returns 400 with validation errors if schema validation fails.
 *
 * @example
 * const paginationSchema = z.object({ page: z.coerce.number().min(1), limit: z.coerce.number().min(1).max(100) });
 * router.get('/items', validateQuery(paginationSchema), itemsHandler);
 */
export function validateQuery<T extends ZodSchema>(schema: T): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(req.query);
      // Express 5 makes req.query read-only via getter; use defineProperty to override
      Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: error.errors.map((err) => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        });
        return;
      }
      res.status(400).json({ error: 'Invalid query parameters' });
    }
  };
}

/**
 * Validate request params against a Zod schema.
 * Returns 400 with validation errors if schema validation fails.
 *
 * @example
 * const idSchema = z.object({ id: z.coerce.number().positive() });
 * router.get('/items/:id', validateParams(idSchema), itemHandler);
 */
export function validateParams<T extends ZodSchema>(schema: T): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(req.params);
      Object.defineProperty(req, 'params', { value: parsed, writable: true, configurable: true });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: error.errors.map((err) => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        });
        return;
      }
      res.status(400).json({ error: 'Invalid route parameters' });
    }
  };
}
