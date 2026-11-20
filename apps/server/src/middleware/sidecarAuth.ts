/**
 * Sidecar session-token auth, after the requestOriginGuard.ts checks that run
 * in every mode: an unknown Host gets 421 (DNS rebinding) and sensitive routes
 * refuse cross-site requests with 403.
 *
 * The desktop shell passes a per-session SNAGLET_AUTH_TOKEN. When set, /api requests
 * must present it (`x-snaglet-token` or `?snaglet_token=`), since any local process can
 * reach the loopback port; WebSocketService checks the same token. Exempt:
 * non-/api paths (assets, /health), the OAuth callback, the paths below.
 */

import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { isAllowedHostHeader, isCrossSiteRequest, isSensitiveApiPath } from './requestOriginGuard';

/**
 * /api paths reachable without the session token. Google redirects the system
 * browser here and cannot attach the token; a forged code just fails the exchange.
 */
const TOKENLESS_API_PATHS = new Set(['/api/providers/google-workspace/oauth/callback']);

/**
 * Tool-execution paths whose credentials (panel, sidecar CLI and child-dispatch
 * tokens; see panelAuth.ts) this middleware does not understand, so auth is left
 * to the path-scoped guards in tools.routes.ts. Exact matches only: never a
 * prefix check, so a new route under /api/tools still needs the session token.
 */
const EXECUTION_AUTH_DEFERRED_PATHS = new Set([
  '/api/tools/execute',
  '/api/tools/execute/log',
  '/api/tools/execute/test',
]);

/**
 * Constant-time compare: `===` leaks how many leading bytes a guess got right.
 * `timingSafeEqual` throws on a length mismatch, so lengths are checked first
 * (the shell fixes the token length, so that is no oracle).
 */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function sidecarAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isAllowedHostHeader(req.headers.host)) {
    res.status(421).json({ error: 'Misdirected request: unrecognized Host header' });
    return;
  }
  // Express routes are case-insensitive by default; auth must use the same
  // matching rules, including the exact-path downstream-auth exceptions.
  const requestPath = req.path.toLowerCase();
  if (isSensitiveApiPath(requestPath) && isCrossSiteRequest(req)) {
    res.status(403).json({ error: 'Forbidden: cross-site request to a sensitive endpoint' });
    return;
  }

  const token = process.env.SNAGLET_AUTH_TOKEN;
  if (!token) {
    next();
    return;
  }
  if (
    !requestPath.startsWith('/api') ||
    TOKENLESS_API_PATHS.has(requestPath) ||
    EXECUTION_AUTH_DEFERRED_PATHS.has(requestPath)
  ) {
    next();
    return;
  }
  const presented =
    req.get('x-snaglet-token') ??
    (typeof req.query.snaglet_token === 'string' ? req.query.snaglet_token : null);
  if (presented !== null && tokensMatch(presented, token)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized: missing or invalid Snaglet session token' });
}

/**
 * Whether to warn at startup that no session token is set. Running without one
 * is fine in development and single-user self-hosting, but anyone who can reach
 * an exposed port gets full /api access. Reachability can't be proven cheaply,
 * so the heuristic is: token unset and not development.
 */
export function shouldWarnOpenAuth(isDevelopment: boolean): boolean {
  return !process.env.SNAGLET_AUTH_TOKEN && !isDevelopment;
}
