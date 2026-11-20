import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';

export const DEFAULT_API_RATE_LIMIT_PER_SECOND = 10;
export const DEFAULT_API_RATE_LIMIT_BURST = 100;
const MIN_API_RATE_LIMIT_PER_SECOND = 1;
const MAX_API_RATE_LIMIT_PER_SECOND = 1_000;
const MIN_API_RATE_LIMIT_BURST = 10;
const MAX_API_RATE_LIMIT_BURST = 10_000;

export interface ApiRateLimitConfig {
  ratePerSecond: number;
  burst: number;
}

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
  lastSeenMs: number;
}

interface ApiRateLimiterOptions extends Partial<ApiRateLimitConfig> {
  now?: () => number;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

export function resolveApiRateLimitConfig(
  env: {
    SNAGLET_API_RATE_LIMIT_PER_SECOND?: string;
    SNAGLET_API_RATE_LIMIT_BURST?: string;
  } = process.env
): ApiRateLimitConfig {
  const ratePerSecond = boundedInteger(
    env.SNAGLET_API_RATE_LIMIT_PER_SECOND,
    DEFAULT_API_RATE_LIMIT_PER_SECOND,
    MIN_API_RATE_LIMIT_PER_SECOND,
    MAX_API_RATE_LIMIT_PER_SECOND
  );
  const burst = boundedInteger(
    env.SNAGLET_API_RATE_LIMIT_BURST,
    DEFAULT_API_RATE_LIMIT_BURST,
    MIN_API_RATE_LIMIT_BURST,
    MAX_API_RATE_LIMIT_BURST
  );
  return { ratePerSecond, burst: Math.max(ratePerSecond, burst) };
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Direct loopback callers are the local Snaglet UI/desktop process, not an external
 * abuse surface. Forwarded requests do not receive this exemption: a local
 * reverse proxy may represent a remote client, and its forwarded identity
 * must still pass through the remote limiter.
 */
function isDirectLoopbackRequest(req: Request): boolean {
  const hasForwardedClient =
    req.headers['x-forwarded-for'] !== undefined || req.headers.forwarded !== undefined;
  return !hasForwardedClient && isLoopbackAddress(req.socket.remoteAddress);
}

/**
 * OAuth remains deliberately strict for remote clients. Direct loopback
 * requests are exempt in every runtime mode so the local application cannot
 * lock itself out of its own auth flow.
 */
export const oauthRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: 'Too many OAuth attempts',
    retryAfter: '15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isDirectLoopbackRequest,
});

/**
 * General remote API protection uses a token bucket instead of a fixed window.
 * It permits a normal UI startup burst, then refills at the configured
 * sustained rate. A rejected remote request can retry within one second; no
 * multi-minute lockout is possible.
 *
 * Direct loopback requests bypass this middleware entirely.
 */
export function createApiRateLimiter(options: ApiRateLimiterOptions = {}): RequestHandler {
  const resolved = resolveApiRateLimitConfig();
  const ratePerSecond = options.ratePerSecond ?? resolved.ratePerSecond;
  const burst = Math.max(ratePerSecond, options.burst ?? resolved.burst);
  const now = options.now ?? Date.now;
  const buckets = new Map<string, TokenBucket>();
  let handledRequests = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (isDirectLoopbackRequest(req)) {
      next();
      return;
    }

    const currentTime = now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const existing = buckets.get(key);
    const bucket: TokenBucket = existing ?? {
      tokens: burst,
      lastRefillMs: currentTime,
      lastSeenMs: currentTime,
    };
    const elapsedMs = Math.max(0, currentTime - bucket.lastRefillMs);
    bucket.tokens = Math.min(burst, bucket.tokens + (elapsedMs / 1_000) * ratePerSecond);
    bucket.lastRefillMs = currentTime;
    bucket.lastSeenMs = currentTime;
    buckets.set(key, bucket);

    handledRequests += 1;
    if (handledRequests % 1_000 === 0) {
      const idleExpiryMs = Math.max(60_000, (burst / ratePerSecond) * 2_000);
      for (const [bucketKey, candidate] of buckets) {
        if (currentTime - candidate.lastSeenMs > idleExpiryMs) buckets.delete(bucketKey);
      }
    }

    res.setHeader('RateLimit-Policy', `${ratePerSecond};w=1;burst=${burst}`);
    res.setHeader('RateLimit-Limit', String(burst));

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      const refillToFullSeconds = Math.ceil((burst - bucket.tokens) / ratePerSecond);
      res.setHeader('RateLimit-Remaining', String(Math.floor(bucket.tokens)));
      res.setHeader('RateLimit-Reset', String(refillToFullSeconds));
      next();
      return;
    }

    const retryMs = Math.ceil(((1 - bucket.tokens) / ratePerSecond) * 1_000);
    const retrySeconds = Math.max(1, Math.ceil(retryMs / 1_000));
    res.setHeader('RateLimit-Remaining', '0');
    res.setHeader('RateLimit-Reset', String(retrySeconds));
    res.setHeader('Retry-After', String(retrySeconds));
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: '1 second',
    });
  };
}

export const apiRateLimiter = createApiRateLimiter();
