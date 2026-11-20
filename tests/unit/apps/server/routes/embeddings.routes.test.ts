import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';

const getStorageStats = jest.fn();
const listEmbeddingLog = jest.fn();
const cancelMaintenanceJob = jest.fn();
const getMaintenanceStatus = jest.fn();
const listMaintenanceModels = jest.fn();
const startBackfillForActiveModel = jest.fn();
const startMaintenanceJob = jest.fn();

jest.mock('@server/services/EmbeddingQueryService', () => ({
  getStorageStats: (...args: unknown[]) => getStorageStats(...args),
  listEmbeddingLog: (...args: unknown[]) => listEmbeddingLog(...args),
}));

jest.mock('@server/services/EmbeddingMaintenanceService', () => ({
  cancelMaintenanceJob: (...args: unknown[]) => cancelMaintenanceJob(...args),
  getMaintenanceStatus: (...args: unknown[]) => getMaintenanceStatus(...args),
  listMaintenanceModels: (...args: unknown[]) => listMaintenanceModels(...args),
  startBackfillForActiveModel: (...args: unknown[]) => startBackfillForActiveModel(...args),
  startMaintenanceJob: (...args: unknown[]) => startMaintenanceJob(...args),
}));

import embeddingsRoutes from '@server/routes/embeddings';
import { errorHandler } from '@server/middleware/errorHandler';

describe('embeddings routes', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    getStorageStats.mockResolvedValue([]);
    listEmbeddingLog.mockResolvedValue([]);
    getMaintenanceStatus.mockReturnValue({ running: false });
    listMaintenanceModels.mockResolvedValue([]);
    cancelMaintenanceJob.mockReturnValue({ running: false });
    startBackfillForActiveModel.mockResolvedValue({ running: true });
    startMaintenanceJob.mockResolvedValue({ running: true });

    app = express();
    app.use(express.json());
    app.use('/api/embeddings', embeddingsRoutes);
    app.use(errorHandler);
  });

  it.each([
    ['get', '/api/embeddings/models'],
    ['get', '/api/embeddings'],
    ['get', '/api/embeddings/points'],
    ['post', '/api/embeddings/project-query'],
    ['post', '/api/embeddings/cosine'],
    ['post', '/api/embeddings/cosine-distribution'],
    ['get', '/api/embeddings/vector/node-1'],
    ['post', '/api/embeddings/projection/rebuild'],
    // Fed only the doc header's embedding status banner, which is gone.
    ['get', '/api/embeddings/node?nodeId=doc-1'],
    ['get', '/api/embeddings/settings/active'],
    ['post', '/api/embeddings/embed-node'],
  ] as const)('returns 404 for removed %s %s', async (method, path) => {
    const response = await request(app)[method](path).send({});
    expect(response.status).toBe(404);
  });

  it('removes ledger while preserving shared storage route', async () => {
    expect((await request(app).get('/api/embeddings/log')).status).toBe(404);
    expect((await request(app).get('/api/embeddings/storage')).status).toBe(200);
  });

  it.each(['purge_all', 'purge_model', 'purge_node_type', 'refresh_stale', 'backfill_missing'])(
    'rejects removed operation %s',
    async (operation) => {
      expect(
        (
          await request(app)
            .post('/api/embeddings/maintenance/jobs')
            .send({ operation, modelId: 'model-1' })
        ).status
      ).toBe(400);
      expect(startMaintenanceJob).not.toHaveBeenCalled();
    }
  );

  it('preserves maintenance and re-embed routes', async () => {
    expect((await request(app).get('/api/embeddings/maintenance/models')).status).toBe(200);
    expect((await request(app).get('/api/embeddings/maintenance/status')).status).toBe(200);
    expect((await request(app).post('/api/embeddings/maintenance/cancel')).status).toBe(200);
    expect(
      (
        await request(app).post('/api/embeddings/maintenance/jobs').send({
          operation: 'backfill',
          modelId: 'model-1',
          nodeType: 'file',
        })
      ).status
    ).toBe(200);
    expect(
      (
        await request(app)
          .post('/api/embeddings/reembed')
          .send({ nodeTypes: ['doc'] })
      ).status
    ).toBe(200);
  });
});
