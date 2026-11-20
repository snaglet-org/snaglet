/**
 * Sidecar session-token middleware — token gate on /api plus the OAuth
 * browser-callback exemption (Google's redirect can't carry the token).
 */

import type { Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import { sidecarAuthMiddleware } from '@server/middleware/sidecarAuth';

const makeReq = (path: string, token?: string): Request =>
  ({
    path,
    headers: { host: '127.0.0.1:4001' },
    query: {},
    get: (name: string) => (name === 'x-snaglet-token' ? token : undefined),
  }) as unknown as Request;

const makeRes = () => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
};

const savedToken = process.env.SNAGLET_AUTH_TOKEN;

afterEach(() => {
  if (savedToken === undefined) delete process.env.SNAGLET_AUTH_TOKEN;
  else process.env.SNAGLET_AUTH_TOKEN = savedToken;
});

describe('sidecarAuthMiddleware', () => {
  test.each(['/api/review-probe', '/API/review-probe', '/Api/review-probe'])(
    'protects the Express route %s regardless of path casing',
    async (path) => {
      process.env.SNAGLET_AUTH_TOKEN = 'test-session-token';
      const app = express();
      const reached = jest.fn();
      app.use(sidecarAuthMiddleware);
      app.get('/api/review-probe', (_req, res) => {
        reached();
        res.json({ ok: true });
      });
      expect((await request(app).get(path)).status).toBe(401);
      expect((await request(app).get(path).set('x-snaglet-token', 'invalid-token')).status).toBe(
        401
      );
      expect(reached).not.toHaveBeenCalled();
      expect(
        (await request(app).get(path).set('x-snaglet-token', 'test-session-token')).status
      ).toBe(200);
      expect(reached).toHaveBeenCalledTimes(1);
    }
  );
  test('no-op when SNAGLET_AUTH_TOKEN is unset', () => {
    delete process.env.SNAGLET_AUTH_TOKEN;
    const next = jest.fn();
    sidecarAuthMiddleware(makeReq('/api/providers'), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('rejects /api without the token', () => {
    process.env.SNAGLET_AUTH_TOKEN = 'secret';
    const next = jest.fn();
    const res = makeRes();
    sidecarAuthMiddleware(makeReq('/api/providers'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  test('passes /api with the correct token', () => {
    process.env.SNAGLET_AUTH_TOKEN = 'secret';
    const next = jest.fn();
    sidecarAuthMiddleware(makeReq('/api/providers', 'secret'), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('exempts the Google OAuth browser callback', () => {
    process.env.SNAGLET_AUTH_TOKEN = 'secret';
    const next = jest.fn();
    sidecarAuthMiddleware(
      makeReq('/api/providers/google-workspace/oauth/callback'),
      makeRes(),
      next
    );
    expect(next).toHaveBeenCalled();
  });

  test('does not exempt sibling oauth paths', () => {
    process.env.SNAGLET_AUTH_TOKEN = 'secret';
    const next = jest.fn();
    const res = makeRes();
    sidecarAuthMiddleware(makeReq('/api/providers/google-workspace/oauth/start'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  test('rejects a token of the same length but different bytes', () => {
    process.env.SNAGLET_AUTH_TOKEN = 'secret';
    const next = jest.fn();
    const res = makeRes();
    // Same length as 'secret' so the length guard passes and the actual
    // constant-time byte comparison is exercised.
    sidecarAuthMiddleware(makeReq('/api/providers', 'sacred'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  test('rejects a token that is a prefix of the real token (length mismatch)', () => {
    process.env.SNAGLET_AUTH_TOKEN = 'secret';
    const next = jest.fn();
    const res = makeRes();
    // Length mismatch must be rejected, never throw (timingSafeEqual throws on
    // unequal-length buffers — the length guard handles it).
    expect(() => sidecarAuthMiddleware(makeReq('/api/providers', 'sec'), res, next)).not.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  test('accepts the token supplied via the ?snaglet_token= query param', () => {
    process.env.SNAGLET_AUTH_TOKEN = 'secret';
    const next = jest.fn();
    const req = {
      path: '/api/providers',
      headers: { host: '127.0.0.1:4001' },
      query: { snaglet_token: 'secret' },
      get: () => undefined,
    } as unknown as Request;
    sidecarAuthMiddleware(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  // snaglet-fix-packaged-tool-exec-auth: the tool-execution route family is
  // deferred to tools.routes.ts's own path-scoped panel/child-dispatch
  // guards — see the module doc's execution-deferral section. These pin the
  // deferral at this middleware's level (no headers/tokens presented at
  // all); tests/unit/apps/server/middleware/sidecarAuthExecutionComposition.test.ts
  // pins the full production-order pipeline end to end.
  describe('execution-route deferral', () => {
    test.each(['/api/tools/execute', '/api/tools/execute/log', '/api/tools/execute/test'])(
      'defers %s with no x-snaglet-token presented at all',
      (path) => {
        process.env.SNAGLET_AUTH_TOKEN = 'secret';
        const next = jest.fn();
        sidecarAuthMiddleware(makeReq(path), makeRes(), next);
        expect(next).toHaveBeenCalled();
      }
    );

    test('does not defer a sibling /api/tools path (exact match only, not a prefix exemption)', () => {
      process.env.SNAGLET_AUTH_TOKEN = 'secret';
      const next = jest.fn();
      const res = makeRes();
      sidecarAuthMiddleware(makeReq('/api/tools/execute/other'), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    test('does not defer plain /api/tools (listing/CRUD still needs the session token)', () => {
      process.env.SNAGLET_AUTH_TOKEN = 'secret';
      const next = jest.fn();
      const res = makeRes();
      sidecarAuthMiddleware(makeReq('/api/tools'), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    test('does not defer /api/tools/workspaces (adjacent tool sub-resource stays gated)', () => {
      process.env.SNAGLET_AUTH_TOKEN = 'secret';
      const next = jest.fn();
      const res = makeRes();
      sidecarAuthMiddleware(makeReq('/api/tools/workspaces'), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });
  });
});
