import express from 'express';
import request from 'supertest';
import serverRoutes, { configureServerShutdown } from '@server/routes/server';
import { sidecarAuthMiddleware } from '@server/middleware/sidecarAuth';

describe('server shutdown route', () => {
  const originalToken = process.env.SNAGLET_SHUTDOWN_TOKEN;
  const originalSidecarToken = process.env.SNAGLET_AUTH_TOKEN;

  beforeEach(() => {
    process.env.SNAGLET_SHUTDOWN_TOKEN = 'private-shutdown-token';
    process.env.SNAGLET_AUTH_TOKEN = 'sidecar-token';
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.SNAGLET_SHUTDOWN_TOKEN;
    else process.env.SNAGLET_SHUTDOWN_TOKEN = originalToken;
    if (originalSidecarToken === undefined) delete process.env.SNAGLET_AUTH_TOKEN;
    else process.env.SNAGLET_AUTH_TOKEN = originalSidecarToken;
  });

  it('rejects absent or mismatched private shutdown tokens', async () => {
    configureServerShutdown(async () => {});
    const app = express().use(sidecarAuthMiddleware).use('/api/server', serverRoutes);
    await request(app).post('/api/server/shutdown').expect(401);
    await request(app)
      .post('/api/server/shutdown')
      .set('x-snaglet-token', 'sidecar-token')
      .set('x-snaglet-shutdown-token', 'wrong')
      .expect(403);
  });

  it('accepts a matching token and invokes shutdown only once', async () => {
    const shutdown = jest.fn(async () => {});
    configureServerShutdown(shutdown);
    const app = express().use(sidecarAuthMiddleware).use('/api/server', serverRoutes);
    await request(app)
      .post('/api/server/shutdown')
      .set('x-snaglet-token', 'sidecar-token')
      .set('x-snaglet-shutdown-token', 'private-shutdown-token')
      .expect(202);
    await request(app)
      .post('/api/server/shutdown')
      .set('x-snaglet-token', 'sidecar-token')
      .set('x-snaglet-shutdown-token', 'private-shutdown-token')
      .expect(202);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
