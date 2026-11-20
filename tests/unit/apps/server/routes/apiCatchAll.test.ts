/**
 * The /api 404 handler mount in apps/server/src/index.ts. The server runs
 * Express 4 (path-to-regexp 0.1.x), where an Express-5-style `/api/{*splat}`
 * pattern matches nothing and unmatched requests get Express's HTML 404. The
 * JSON `notFoundHandler` is mounted under a bare `/api` prefix after every
 * real router, so it runs only when none of them matched.
 *
 * Resolution note: the repo-root `node_modules/express` hoists to Express 5,
 * while apps/server pins its own Express 4. A plain `import express` from this
 * file would get Express 5 and make the `{*splat}` syntax appear to work, so
 * express is resolved via `require.resolve(..., { paths })` anchored at a real
 * apps/server/src file.
 */
import request from 'supertest';
import type express from 'express';

jest.mock('../../../../../apps/server/src/config/logger', () => ({
  logger: {
    error: jest.fn(),
    http: jest.fn(),
  },
  httpLogStream: {
    write: jest.fn(),
  },
}));

// Mock @snaglet/db to avoid import.meta.url issues in Jest (same as api.test.ts).
jest.mock('../../../../../packages/db/index.ts', () => ({
  isDatabaseEnabled: () => false,
  getPool: jest.fn(),
  getDb: jest.fn(),
  getDatabase: jest.fn(),
  initializeDatabase: jest.fn(),
  closeDatabase: jest.fn(),
}));

import apiRoutes from '@server/routes/api';
import { errorHandler, notFoundHandler } from '@server/middleware';

// See the file-level comment: resolve express relative to a real
// apps/server/src module (not this test file) to get the server's actual
// pinned express@4.22.1 install instead of the repo-root hoisted 5.2.1.
const expressLib: typeof express = require(
  require.resolve('express', { paths: [require.resolve('@server/routes/api')] })
);

describe('/api catch-all 404 (mirrors apps/server/src/index.ts mount order)', () => {
  let app: express.Application;

  beforeAll(() => {
    app = expressLib();
    app.use(expressLib.json());
    // Real /api router(s) first, exactly like index.ts.
    app.use('/api', apiRoutes);
    // A bare `/api` prefix, mounted after all real routers, needs no wildcard
    // syntax to act as the catch-all.
    app.use('/api', notFoundHandler);
    app.use(errorHandler);
  });

  it('still serves a real, matched /api route (matched routes are unaffected)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('returns a JSON NOT_FOUND envelope — not an HTML page — for an unmatched POST route (e.g. tools/execute when unmounted)', async () => {
    const res = await request(app).post('/api/tools/execute').send({});

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(typeof res.body.error.message).toBe('string');
  });

  it('returns the same JSON envelope for any other unmatched /api/* path', async () => {
    const res = await request(app).get('/api/this-route-does-not-exist');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
