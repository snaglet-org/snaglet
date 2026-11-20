import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@server/services/workers/workerPolicy', () => ({
  resolveWorkerPolicy: jest.fn(async () => ({ active: true, embeddingsEnabled: true })),
  peekWorkerPolicy: jest.fn(() => ({ active: true, embeddingsEnabled: true })),
}));
jest.mock('@server/services/workers/workerStatus', () => ({ listWorkerStatus: () => [] }));
const mockSettingsWrite = jest.fn(async (_def: unknown, value: unknown) => value);
jest.mock('@server/services/settings/settingsService', () => ({
  settingsService: {
    write: (def: unknown, value: unknown) => mockSettingsWrite(def, value),
  },
}));
jest.mock('@server/workers/EmbeddingWorker', () => ({
  getEmbeddingQueueDepth: async () => ({
    total: 0,
    capped: false,
    cap: 0,
    byKind: {},
    ready: true,
  }),
}));

import workersRoutes from '@server/routes/workers';
import { errorHandler } from '@server/middleware/errorHandler';

describe('workers automatic local intelligence status', () => {
  const previous = process.env.SNAGLET_LOCAL_INTELLIGENCE;
  beforeEach(() => {
    delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
    else process.env.SNAGLET_LOCAL_INTELLIGENCE = previous;
  });
  it.each([undefined, 'false', 'true'])(
    'reports the environment gate separately from the worker policy (%s)',
    async (setting) => {
      if (setting !== undefined) process.env.SNAGLET_LOCAL_INTELLIGENCE = setting;
      const app = express();
      app.use('/workers', workersRoutes);
      const response = await request(app).get('/workers/status');
      expect(response.status).toBe(200);
      expect(response.body.data.automaticLocalIntelligenceEnabled).toBe(setting === 'true');
      expect(response.body.data.policy).toMatchObject({ active: true, embeddingsEnabled: true });
    }
  );
});

describe('PUT /workers/policy', () => {
  const app = express().use(express.json()).use('/workers', workersRoutes).use(errorHandler);
  beforeEach(() => mockSettingsWrite.mockClear());

  it('writes nothing when any field is invalid, even after a valid one', async () => {
    const response = await request(app)
      .put('/workers/policy')
      .send({ mode: 'paused', embeddingsEnabled: false, batchSize: 'many' });
    expect(response.status).toBe(400);
    expect(mockSettingsWrite).not.toHaveBeenCalled();
  });

  it('writes every field of a valid update', async () => {
    const response = await request(app)
      .put('/workers/policy')
      .send({ mode: 'paused', embeddingsEnabled: false });
    expect(response.status).toBe(200);
    expect(mockSettingsWrite).toHaveBeenCalledTimes(2);
    expect(mockSettingsWrite.mock.calls.map(([, value]) => value)).toEqual(['paused', false]);
  });
});
