import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  __resetRerankerReseedForTests,
  bootstrapLocalReranker,
  reseedRerankerIfMissing,
} from '@server/services/reranking/RerankerBootstrap';
import { ModelFetchAbortedError } from '@server/services/localModels/fetchModelFiles';

function dependencies(ready: boolean, flagOn = true) {
  return {
    isFlagEnabled: jest.fn(async () => flagOn),
    getStatus: jest.fn(async () => ({
      providerId: 'local-onnx-reranker',
      modelId: 'ms-marco-MiniLM-L2-v2',
      registered: true,
      ready,
    })),
    fetchModel: jest.fn(async () => ({ downloaded: [], skipped: [] }) as never),
    info: jest.fn(),
    debug: jest.fn(),
  };
}

describe('automatic reranker bootstrap', () => {
  it('touches no model path when local intelligence is not opted in', async () => {
    const deps = dependencies(false);
    await expect(bootstrapLocalReranker({}, deps as never)).resolves.toBe('disabled');

    expect(deps.getStatus).not.toHaveBeenCalled();
    expect(deps.fetchModel).not.toHaveBeenCalled();
  });

  it('downloads a missing model after explicit opt-in', async () => {
    const deps = dependencies(false);
    await expect(
      bootstrapLocalReranker({ SNAGLET_LOCAL_INTELLIGENCE: 'true' }, deps as never)
    ).resolves.toBe('ready');

    expect(deps.fetchModel).toHaveBeenCalledTimes(1);
    expect(deps.fetchModel).toHaveBeenCalledWith(
      expect.objectContaining({ shouldInstall: deps.isFlagEnabled })
    );
  });

  it('skips download when the model is already ready', async () => {
    const deps = dependencies(true);
    await expect(
      bootstrapLocalReranker({ SNAGLET_LOCAL_INTELLIGENCE: 'true' }, deps as never)
    ).resolves.toBe('ready');

    expect(deps.fetchModel).not.toHaveBeenCalled();
  });

  it('downloads nothing while the reranker flag is off', async () => {
    const deps = dependencies(false, false);
    await expect(
      bootstrapLocalReranker({ SNAGLET_LOCAL_INTELLIGENCE: 'true' }, deps as never)
    ).resolves.toBe('disabled');

    expect(deps.isFlagEnabled).toHaveBeenCalledTimes(1);
    expect(deps.getStatus).not.toHaveBeenCalled();
    expect(deps.fetchModel).not.toHaveBeenCalled();
    expect(deps.debug).toHaveBeenCalledWith(expect.stringContaining('feature flag `reranker`'));
    expect(deps.info).not.toHaveBeenCalled();
  });

  it('reports disabled, not a failure, when the flag turns off mid-download', async () => {
    const deps = dependencies(false);
    deps.fetchModel.mockRejectedValueOnce(new ModelFetchAbortedError('called off') as never);

    await expect(
      bootstrapLocalReranker({ SNAGLET_LOCAL_INTELLIGENCE: 'true' }, deps as never)
    ).resolves.toBe('disabled');

    expect(deps.debug).toHaveBeenCalledWith(expect.stringContaining('Download stopped'));
  });
});

describe('on-demand reranker auto-reseed', () => {
  function reseedDependencies(flagOn = true) {
    return {
      isFlagEnabled: jest.fn(async () => flagOn),
      fetchModel: jest.fn(async () => ({ downloaded: [], skipped: [] }) as never),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };
  }

  beforeEach(() => {
    __resetRerankerReseedForTests();
  });

  it('downloads nothing when local intelligence is not opted in', async () => {
    const deps = reseedDependencies();
    await expect(reseedRerankerIfMissing('rerank', {}, deps as never)).resolves.toBe(false);
    expect(deps.fetchModel).not.toHaveBeenCalled();
  });

  it('re-runs the pinned-manifest fetch and logs the error state loudly', async () => {
    const deps = reseedDependencies();
    await expect(
      reseedRerankerIfMissing(
        'opening retrieval',
        { SNAGLET_LOCAL_INTELLIGENCE: 'true' },
        deps as never
      )
    ).resolves.toBe(true);

    expect(deps.fetchModel).toHaveBeenCalledTimes(1);
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('opening retrieval'));
  });

  it('is single-flight with a cooldown between attempts', async () => {
    const deps = reseedDependencies();
    deps.fetchModel.mockRejectedValueOnce(new Error('offline') as never);

    const env = { SNAGLET_LOCAL_INTELLIGENCE: 'true' };
    await expect(reseedRerankerIfMissing('rerank', env, deps as never)).resolves.toBe(false);
    await expect(reseedRerankerIfMissing('rerank', env, deps as never)).resolves.toBe(false);
    expect(deps.fetchModel).toHaveBeenCalledTimes(1);
  });

  it('downloads nothing and logs no error while the reranker flag is off', async () => {
    const deps = reseedDependencies(false);
    await expect(
      reseedRerankerIfMissing('rerank', { SNAGLET_LOCAL_INTELLIGENCE: 'true' }, deps as never)
    ).resolves.toBe(false);

    expect(deps.isFlagEnabled).toHaveBeenCalledTimes(1);
    expect(deps.fetchModel).not.toHaveBeenCalled();
    expect(deps.error).not.toHaveBeenCalled();
  });

  it('starts no cooldown while the flag is off', async () => {
    const env = { SNAGLET_LOCAL_INTELLIGENCE: 'true' };
    await expect(
      reseedRerankerIfMissing('rerank', env, reseedDependencies(false) as never)
    ).resolves.toBe(false);

    const deps = reseedDependencies(true);
    await expect(reseedRerankerIfMissing('rerank', env, deps as never)).resolves.toBe(true);
    expect(deps.fetchModel).toHaveBeenCalledTimes(1);
  });

  it('logs no error when the flag turns off mid-download', async () => {
    const deps = reseedDependencies();
    deps.fetchModel.mockRejectedValueOnce(new ModelFetchAbortedError('called off') as never);

    await expect(
      reseedRerankerIfMissing('rerank', { SNAGLET_LOCAL_INTELLIGENCE: 'true' }, deps as never)
    ).resolves.toBe(false);

    expect(deps.fetchModel).toHaveBeenCalledWith(
      expect.objectContaining({ shouldInstall: deps.isFlagEnabled })
    );
    expect(deps.error).toHaveBeenCalledTimes(1);
    expect(deps.error).not.toHaveBeenCalledWith(expect.stringContaining('auto-reseed failed'));
    expect(deps.debug).toHaveBeenCalledWith(expect.stringContaining('Reseed stopped'));
  });
});
