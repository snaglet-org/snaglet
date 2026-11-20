import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { embeddingsApi } from './embeddings';

afterEach(() => vi.unstubAllGlobals());

function ok(data: unknown) {
  return {
    ok: true,
    json: async () => ({ success: true, data }),
  };
}

describe('embeddingsApi maintenance', () => {
  it('loads model coverage and the lightweight current status', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok([{ id: 'model-1', fresh: 4, missing: 0 }]))
      .mockResolvedValueOnce(ok({ running: false, jobId: null }));
    vi.stubGlobal('fetch', fetchMock);

    await embeddingsApi.listMaintenanceModels();
    await embeddingsApi.getMaintenanceStatus();

    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/embeddings/maintenance/models');
    expect(String(fetchMock.mock.calls[1]![0])).toBe('/api/embeddings/maintenance/status');
  });

  it('starts a typed maintenance operation and requests cancellation with POST', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ running: true, jobId: 'job-1' }))
      .mockResolvedValueOnce(ok({ running: true, cancelRequested: true }));
    vi.stubGlobal('fetch', fetchMock);

    await embeddingsApi.startMaintenanceJob({
      operation: 'backfill',
      modelId: 'model-1',
      nodeType: 'file',
    });
    await embeddingsApi.cancelMaintenanceJob();

    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/embeddings/maintenance/jobs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          operation: 'backfill',
          modelId: 'model-1',
          nodeType: 'file',
        }),
      }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/embeddings/maintenance/cancel',
      expect.objectContaining({ method: 'POST' }),
    ]);
  });
});
