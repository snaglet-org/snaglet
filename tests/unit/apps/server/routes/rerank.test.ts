import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';

const mockRerank = jest.fn();
const mockStatus = jest.fn();
const mockFlagEnabled = jest.fn<() => Promise<boolean>>();

jest.mock('@server/services/reranking/LocalRerankerService', () => ({
  rerank: (...args: unknown[]) => mockRerank(...args),
  getLocalRerankerStatus: (...args: unknown[]) => mockStatus(...args),
}));

jest.mock('@server/services/reranking/rerankerFlag', () => ({
  RERANKER_OFF_MESSAGE: 'Reranking is turned off (feature flag `reranker`).',
  isRerankerEnabled: () => mockFlagEnabled(),
}));

import rerankRoutes from '@server/routes/rerank';
import { errorHandler } from '@server/middleware/errorHandler';

describe('rerank routes', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFlagEnabled.mockResolvedValue(true);
    app = express();
    app.use(express.json());
    app.use('/api/rerank', rerankRoutes);
    app.use(errorHandler);
  });

  it('returns local reranker status', async () => {
    mockStatus.mockResolvedValue({
      providerId: 'snaglet-local',
      modelId: 'ms-marco-MiniLM-L6-v2-qint8-arm64',
      registered: true,
      ready: true,
    });

    const response = await request(app).get('/api/rerank/status');

    expect(response.status).toBe(200);
    expect(response.body.data.ready).toBe(true);
    expect(response.body.data.enabled).toBe(true);
  });

  it('reports the reranker as turned off without probing the model while the flag is off', async () => {
    mockFlagEnabled.mockResolvedValue(false);

    const response = await request(app).get('/api/rerank/status');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      enabled: false,
      ready: false,
      message: 'Reranking is turned off (feature flag `reranker`).',
    });
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('refuses to score while the flag is off, without loading the model', async () => {
    mockFlagEnabled.mockResolvedValue(false);

    const response = await request(app)
      .post('/api/rerank')
      .send({ query: 'red planet', candidates: [{ id: 'a', text: 'Mars is red' }] });

    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toContain('feature flag `reranker`');
    expect(mockRerank).not.toHaveBeenCalled();
  });

  it('scores candidates through the reranker service', async () => {
    mockRerank.mockResolvedValue({
      providerId: 'snaglet-local',
      modelId: 'ms-marco-MiniLM-L6-v2-qint8-arm64',
      modelRowId: 'model-1',
      candidateCount: 2,
      elapsedMs: 12,
      results: [{ index: 1, id: 'b', score: 8.2, text: 'Mars is red' }],
    });

    const response = await request(app)
      .post('/api/rerank')
      .send({
        query: 'red planet',
        candidates: [
          { id: 'a', text: 'Venus is hot' },
          { id: 'b', text: 'Mars is red', metadata: { kind: 'doc' } },
        ],
        topK: 1,
      });

    expect(response.status).toBe(200);
    expect(mockRerank).toHaveBeenCalledWith({
      query: 'red planet',
      candidates: [
        { id: 'a', text: 'Venus is hot', metadata: undefined },
        { id: 'b', text: 'Mars is red', metadata: { kind: 'doc' } },
      ],
      providerId: undefined,
      modelId: undefined,
      topK: 1,
      maxSequenceTokens: undefined,
      batchSize: undefined,
    });
    expect(response.body.data.results[0].id).toBe('b');
  });

  it('rejects missing candidates before calling the service', async () => {
    const response = await request(app).post('/api/rerank').send({ query: 'red planet' });

    expect(response.status).toBe(400);
    expect(mockRerank).not.toHaveBeenCalled();
  });
});
