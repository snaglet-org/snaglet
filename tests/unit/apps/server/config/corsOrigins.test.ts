/**
 * corsOriginCheck: a disallowed Origin is an expected, client-caused refusal,
 * so the pipeline answers 403 without logging an error stack, not a 500.
 */

jest.mock('@server/config/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), http: jest.fn() },
  httpLogStream: { write: jest.fn() },
}));

import cors from 'cors';
import express from 'express';
import request from 'supertest';
import { buildAllowedOrigins, corsOriginCheck } from '@server/config/corsOrigins';
import { errorHandler } from '@server/middleware/errorHandler';
import { logger } from '@server/config/logger';

function buildApp() {
  const app = express();
  app.use(cors({ origin: corsOriginCheck(new Set(['http://localhost:3001'])) }));
  app.get('/api/probe', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe('corsOriginCheck', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects a foreign Origin with 403 and no logged stack', async () => {
    const res = await request(buildApp()).get('/api/probe').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts:\d+/);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('allows an allowlisted Origin and requests without one', async () => {
    const app = buildApp();
    const allowed = await request(app).get('/api/probe').set('Origin', 'http://localhost:3001');
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    expect((await request(app).get('/api/probe')).status).toBe(200);
  });

  test('the default allowlist covers the dev UI and the Tauri webview', () => {
    const origins = buildAllowedOrigins({});
    expect(origins.has('http://localhost:3001')).toBe(true);
    expect(origins.has('tauri://localhost')).toBe(true);
    expect(origins.has('https://evil.example')).toBe(false);
  });
});
