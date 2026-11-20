/**
 * Server-specific middleware and Express types
 */

import { Request, Response } from 'express';

/**
 * Route handler with proper typing
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors Express's own Response<T = any>; callers provide concrete TResponse
export type RouteHandler<TResponse = any> = (
  req: Request,
  res: Response<TResponse>
) => void | Promise<void>;
