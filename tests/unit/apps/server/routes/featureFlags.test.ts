import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getFrontendFlags = jest.fn();

jest.mock('@server/services/FeatureFlagService', () => ({
  featureFlagService: {
    getFrontendFlags: (...args: unknown[]) => getFrontendFlags(...args),
  },
}));

import featureFlagsRouter from '@server/routes/featureFlags';
import { sidecarAuthMiddleware } from '@server/middleware/sidecarAuth';

const previousToken = process.env.SNAGLET_AUTH_TOKEN;

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(sidecarAuthMiddleware);
  app.use('/api/feature-flags', featureFlagsRouter);
  return app;
}

describe('feature flags route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SNAGLET_AUTH_TOKEN = 'feature-flag-test-token';
    getFrontendFlags.mockResolvedValue({ local_model_removal_ui: false });
  });

  afterAll(() => {
    if (previousToken === undefined) delete process.env.SNAGLET_AUTH_TOKEN;
    else process.env.SNAGLET_AUTH_TOKEN = previousToken;
  });

  it('requires the existing sidecar session authentication', async () => {
    const response = await request(makeApp()).get('/api/feature-flags');
    expect(response.status).toBe(401);
    expect(getFrontendFlags).not.toHaveBeenCalled();
  });

  it('returns the frontend snapshot through the standard envelope', async () => {
    const response = await request(makeApp())
      .get('/api/feature-flags')
      .set('x-snaglet-token', 'feature-flag-test-token');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: { local_model_removal_ui: false },
    });
  });

  it('does not expose a mutation endpoint', async () => {
    const response = await request(makeApp())
      .post('/api/feature-flags')
      .set('x-snaglet-token', 'feature-flag-test-token')
      .send({ local_model_removal_ui: true });

    expect(response.status).toBe(404);
    expect(getFrontendFlags).not.toHaveBeenCalled();
  });
});
