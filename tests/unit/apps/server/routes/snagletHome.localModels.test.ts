/**
 * DELETE /api/snaglet-home/storage/local-models/:id — removing a downloaded local
 * model from Settings → Storage. Pins the status mapping: bad input keeps the
 * 404/400 the service gave it, and an internal failure (the delete itself, or
 * the storage report read after it) answers 500, never a 400 that blames the
 * request. The snagletHome service is mocked so the route's own mapping is visible.
 * Also pins the `reranker` feature flag: while it is off the reranker is never
 * offered or fetched.
 */
import express from 'express';
import request from 'supertest';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';

const mockClearModel = jest.fn();
const mockGetStorage = jest.fn();
const mockGetVoiceStorage = jest.fn();
const mockReleaseReranker = jest.fn();
const mockGetVoiceStorageModel = jest.fn();
const mockFetchReranker = jest.fn();
const mockFlagEnabled = jest.fn();

jest.mock('@server/services/snagletHome', () => ({
  clearSnagletVoiceStorageModel: (id: string) => mockClearModel(id),
  getSnagletStorage: () => mockGetStorage(),
  getSnagletVoiceStorage: () => mockGetVoiceStorage(),
  getSnagletVoiceStorageModel: (id: string) => mockGetVoiceStorageModel(id),
}));
jest.mock('@server/services/customHooks/HookRegistryService', () => ({
  getHookRegistry: jest.fn(),
}));
jest.mock('@server/services/reranking/fetchRerankerModel', () => ({
  fetchRerankerModel: () => mockFetchReranker(),
}));
jest.mock('@server/services/reranking/rerankerFlag', () => ({
  RERANKER_OFF_MESSAGE: 'Reranking is turned off (feature flag `reranker`).',
  isRerankerEnabled: () => mockFlagEnabled(),
}));
jest.mock('@server/services/reranking/LocalRerankerService', () => ({
  releaseLocalReranker: () => mockReleaseReranker(),
}));
jest.mock('@server/services/voice/fetchVoiceModels', () => ({ fetchVoiceModels: jest.fn() }));
jest.mock('@server/services/localModels/localModelPreferences', () => ({
  setLocalModelEnabled: jest.fn(),
}));

import { snagletHomeRouter } from '@server/routes/snagletHome.route';

function app(): express.Application {
  const a = express();
  a.use(express.json());
  a.use('/api/snaglet-home', snagletHomeRouter);
  return a;
}

const remove = (id: string) =>
  request(app()).delete(`/api/snaglet-home/storage/local-models/${encodeURIComponent(id)}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockClearModel.mockResolvedValue(undefined);
  mockGetStorage.mockResolvedValue([{ key: 'models', bytes: 0 }]);
  mockGetVoiceStorage.mockResolvedValue([]);
  mockReleaseReranker.mockResolvedValue(undefined);
  mockGetVoiceStorageModel.mockResolvedValue({});
  mockFetchReranker.mockResolvedValue(undefined);
  mockFlagEnabled.mockResolvedValue(true);
});

describe('DELETE /api/snaglet-home/storage/local-models/:id', () => {
  it('removes the model and answers the fresh storage report', async () => {
    const res = await remove('reranker');
    expect(res.status).toBe(200);
    expect(mockClearModel).toHaveBeenCalledWith('reranker');
    expect(mockReleaseReranker).toHaveBeenCalled();
    expect(res.body).toEqual({
      categories: [{ key: 'models', bytes: 0 }],
      localModels: [],
      totalBytes: 0,
    });
  });

  it('answers 404 for an unknown model id', async () => {
    mockClearModel.mockRejectedValue(
      new AppError('Unknown local model.', ErrorCode.NOT_FOUND, 404)
    );
    const res = await remove('not-a-model');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Unknown local model.' });
  });

  it('answers 400 for a model that cannot be removed', async () => {
    mockClearModel.mockRejectedValue(
      new AppError('This local model cannot be removed.', ErrorCode.VALIDATION_ERROR, 400)
    );
    const res = await remove('stt-streaming');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'This local model cannot be removed.' });
  });

  it('answers 500 when the delete itself fails', async () => {
    mockClearModel.mockRejectedValue(new Error('EACCES: permission denied'));
    const res = await remove('stt-streaming');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'EACCES: permission denied' });
  });

  it('answers 500 when the storage report after the delete fails', async () => {
    mockGetStorage.mockRejectedValue(new Error('EIO: i/o error'));
    const res = await remove('stt-streaming');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'EIO: i/o error' });
  });
});

describe('local models and the reranker feature flag', () => {
  const reranker = (installed: boolean, disabled = false) => ({
    id: 'reranker',
    component: 'reranker',
    installed,
    disabled,
  });
  const vad = { id: 'vad', component: 'vad', installed: false, disabled: false };

  it('refuses to download the reranker while the flag is off', async () => {
    mockFlagEnabled.mockResolvedValue(false);

    const res = await request(app()).post('/api/snaglet-home/storage/local-models/reranker/enable');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Reranking is turned off (feature flag `reranker`).' });
    expect(mockFetchReranker).not.toHaveBeenCalled();
  });

  it('downloads the reranker when the flag is on', async () => {
    const res = await request(app()).post('/api/snaglet-home/storage/local-models/reranker/enable');

    expect(res.status).toBe(200);
    expect(mockFetchReranker).toHaveBeenCalledTimes(1);
  });

  it('leaves a reranker that is not on disk out of the storage report while the flag is off', async () => {
    mockFlagEnabled.mockResolvedValue(false);
    mockGetVoiceStorage.mockResolvedValue([reranker(false), vad]);

    const res = await request(app()).get('/api/snaglet-home/storage');

    expect(res.status).toBe(200);
    expect(res.body.localModels).toEqual([vad]);
  });

  it('leaves a removed reranker out so it is not offered for download while the flag is off', async () => {
    mockFlagEnabled.mockResolvedValue(false);
    mockGetVoiceStorage.mockResolvedValue([reranker(false, true), vad]);

    const res = await request(app()).get('/api/snaglet-home/storage');

    expect(res.body.localModels).toEqual([vad]);
  });

  it('keeps a reranker that is on disk listed while the flag is off, so it can be removed', async () => {
    mockFlagEnabled.mockResolvedValue(false);
    mockGetVoiceStorage.mockResolvedValue([reranker(true), vad]);

    const res = await request(app()).get('/api/snaglet-home/storage');

    expect(res.body.localModels).toEqual([reranker(true), vad]);
  });

  it('lists the reranker as today when the flag is on', async () => {
    mockGetVoiceStorage.mockResolvedValue([reranker(false), vad]);

    const res = await request(app()).get('/api/snaglet-home/storage');

    expect(res.body.localModels).toEqual([reranker(false), vad]);
  });
});
