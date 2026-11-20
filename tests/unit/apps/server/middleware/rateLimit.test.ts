import { createServer, type Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import {
  DEFAULT_API_RATE_LIMIT_BURST,
  DEFAULT_API_RATE_LIMIT_PER_SECOND,
  createApiRateLimiter,
  oauthRateLimiter,
  resolveApiRateLimitConfig,
} from '@server/middleware/rateLimit';

function createRemoteApp(
  middleware: express.RequestHandler,
  method: 'get' | 'post' = 'get'
): express.Application {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app[method]('/test', middleware, (_req, res) => res.json({ success: true }));
  return app;
}

const servers: Server[] = [];

/**
 * Serve `app` from one listener bound to 127.0.0.1. Handed a bare app,
 * supertest opens a new wildcard-address listener per request yet connects to
 * 127.0.0.1, so whenever the kernel picks a port another local process has
 * bound on 127.0.0.1, that process answers instead of the app under test.
 */
async function serveOnLoopback(app: express.Application): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(server);
  return server;
}

/**
 * Send requests one at a time. Concurrent requests reach the limiter in
 * arrival order, not array order, so "the 21st response" is only the 21st
 * request the bucket saw when each finishes before the next starts.
 */
async function sendInOrder(count: number, send: () => request.Test): Promise<request.Response[]> {
  const responses: request.Response[] = [];
  for (let i = 0; i < count; i += 1) responses.push(await send());
  return responses;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe('Rate Limiting Middleware', () => {
  describe('direct loopback behavior', () => {
    it('never throttles the local application, including production-shaped servers', async () => {
      const app = express();
      app.get('/test', createApiRateLimiter({ ratePerSecond: 1, burst: 10 }), (_req, res) =>
        res.json({ success: true })
      );
      const server = await serveOnLoopback(app);

      const responses = await Promise.all(
        Array.from({ length: 150 }, () => request(server).get('/test'))
      );

      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(responses[0].headers['ratelimit-limit']).toBeUndefined();
    });

    it('also keeps local OAuth flows from locking out the app', async () => {
      const app = express();
      app.post('/test', oauthRateLimiter, (_req, res) => res.json({ success: true }));
      const server = await serveOnLoopback(app);

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => request(server).post('/test'))
      );

      expect(responses.every((response) => response.status === 200)).toBe(true);
    });
  });

  describe('remote API token bucket', () => {
    let nowMs: number;
    let server: Server;
    const remoteIp = '198.51.100.21';
    const getAs = (ip: string) => () => request(server).get('/test').set('X-Forwarded-For', ip);

    beforeEach(async () => {
      nowMs = 1_000;
      server = await serveOnLoopback(
        createRemoteApp(
          createApiRateLimiter({
            ratePerSecond: 10,
            burst: 20,
            now: () => nowMs,
          })
        )
      );
    });

    it('allows a startup burst and exposes the sustained policy', async () => {
      const responses = await sendInOrder(20, getAs(remoteIp));

      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(responses[0].headers['ratelimit-policy']).toBe('10;w=1;burst=20');
      expect(responses[0].headers['ratelimit-limit']).toBe('20');
      expect(responses[responses.length - 1].headers['ratelimit-remaining']).toBe('0');
    });

    it('rejects only after the burst and permits a retry as tokens refill', async () => {
      const initial = await sendInOrder(21, getAs(remoteIp));

      expect(initial.slice(0, 20).every((response) => response.status === 200)).toBe(true);
      expect(initial[20].status).toBe(429);
      expect(initial[20].body).toEqual({
        error: 'Too many requests',
        retryAfter: '1 second',
      });
      expect(initial[20].headers['retry-after']).toBe('1');

      nowMs += 100;
      const retry = await getAs(remoteIp)();
      expect(retry.status).toBe(200);
    });

    it('refills at ten requests per second after the burst is consumed', async () => {
      await sendInOrder(20, getAs(remoteIp));
      nowMs += 1_000;

      const nextSecond = await sendInOrder(11, getAs(remoteIp));

      expect(nextSecond.slice(0, 10).every((response) => response.status === 200)).toBe(true);
      expect(nextSecond[10].status).toBe(429);
    });

    it('keeps separate buckets for separate remote clients', async () => {
      const firstClient = await sendInOrder(21, getAs(remoteIp));
      const secondClient = await getAs('198.51.100.22')();

      expect(firstClient[20].status).toBe(429);
      expect(secondClient.status).toBe(200);
    });
  });

  describe('configuration', () => {
    it('defaults to ten per second with a 100-request burst and clamps overrides', () => {
      expect(resolveApiRateLimitConfig({})).toEqual({
        ratePerSecond: DEFAULT_API_RATE_LIMIT_PER_SECOND,
        burst: DEFAULT_API_RATE_LIMIT_BURST,
      });
      expect(DEFAULT_API_RATE_LIMIT_PER_SECOND).toBe(10);
      expect(DEFAULT_API_RATE_LIMIT_BURST).toBe(100);
      expect(
        resolveApiRateLimitConfig({
          SNAGLET_API_RATE_LIMIT_PER_SECOND: '25',
          SNAGLET_API_RATE_LIMIT_BURST: '250',
        })
      ).toEqual({ ratePerSecond: 25, burst: 250 });
      expect(
        resolveApiRateLimitConfig({
          SNAGLET_API_RATE_LIMIT_PER_SECOND: '0',
          SNAGLET_API_RATE_LIMIT_BURST: '2',
        })
      ).toEqual({ ratePerSecond: 1, burst: 10 });
      expect(
        resolveApiRateLimitConfig({
          SNAGLET_API_RATE_LIMIT_PER_SECOND: '2000',
          SNAGLET_API_RATE_LIMIT_BURST: '20000',
        })
      ).toEqual({ ratePerSecond: 1_000, burst: 10_000 });
      expect(
        resolveApiRateLimitConfig({
          SNAGLET_API_RATE_LIMIT_PER_SECOND: 'invalid',
          SNAGLET_API_RATE_LIMIT_BURST: 'invalid',
        })
      ).toEqual({ ratePerSecond: 10, burst: 100 });
      expect(
        resolveApiRateLimitConfig({
          SNAGLET_API_RATE_LIMIT_PER_SECOND: '200',
          SNAGLET_API_RATE_LIMIT_BURST: '20',
        })
      ).toEqual({ ratePerSecond: 200, burst: 200 });
    });
  });

  describe('remote OAuth isolation', () => {
    it('retains the stricter OAuth window without consuming general API tokens', async () => {
      const app = express();
      app.set('trust proxy', 1);
      app.post('/oauth', oauthRateLimiter, (_req, res) => res.json({ success: true }));
      app.get(
        '/api',
        createApiRateLimiter({ ratePerSecond: 10, burst: 20, now: () => 1_000 }),
        (_req, res) => res.json({ success: true })
      );
      const server = await serveOnLoopback(app);
      const remoteIp = '198.51.100.40';

      const oauthResponses = await sendInOrder(11, () =>
        request(server).post('/oauth').set('X-Forwarded-For', remoteIp)
      );
      const apiResponse = await request(server).get('/api').set('X-Forwarded-For', remoteIp);

      expect(oauthResponses[10].status).toBe(429);
      expect(oauthResponses[10].body.error).toBe('Too many OAuth attempts');
      expect(apiResponse.status).toBe(200);
      expect(apiResponse.headers['ratelimit-policy']).toBe('10;w=1;burst=20');
    });
  });
});
