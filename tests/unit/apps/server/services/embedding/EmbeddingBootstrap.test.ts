import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  __resetEmbedderReseedForTests,
  bootstrapLocalEmbedder,
  reseedEmbedderIfMissing,
} from '@server/services/embedding/EmbeddingBootstrap';

function dependencies(ready: boolean) {
  return {
    getStatus: jest.fn(async () => ({ ready })),
    fetchModel: jest.fn(async () => ({ downloaded: [], skipped: [] })),
    shouldWarm: jest.fn(() => true),
    warm: jest.fn(),
    info: jest.fn(),
  };
}

describe('automatic embedder bootstrap', () => {
  it('touches no model path when local intelligence is not opted in', async () => {
    const deps = dependencies(false);
    await expect(bootstrapLocalEmbedder({}, deps)).resolves.toBe('disabled');

    expect(deps.getStatus).not.toHaveBeenCalled();
    expect(deps.fetchModel).not.toHaveBeenCalled();
    expect(deps.shouldWarm).not.toHaveBeenCalled();
    expect(deps.warm).not.toHaveBeenCalled();
  });

  it('downloads a missing model and warms after explicit opt-in', async () => {
    const deps = dependencies(false);
    await expect(
      bootstrapLocalEmbedder({ SNAGLET_LOCAL_INTELLIGENCE: 'true' }, deps)
    ).resolves.toBe('ready');

    expect(deps.fetchModel).toHaveBeenCalledTimes(1);
    expect(deps.shouldWarm).toHaveBeenCalledTimes(1);
    expect(deps.warm).toHaveBeenCalledTimes(1);
  });

  it('skips download for a ready model and respects the background-worker warm gate', async () => {
    const deps = dependencies(true);
    deps.shouldWarm.mockReturnValue(false);
    await bootstrapLocalEmbedder(
      { SNAGLET_LOCAL_INTELLIGENCE: 'true', RUN_BACKGROUND_WORKERS: 'false' },
      deps
    );

    expect(deps.fetchModel).not.toHaveBeenCalled();
    expect(deps.warm).not.toHaveBeenCalled();
  });
});

describe('on-demand embedder auto-reseed', () => {
  function reseedDependencies() {
    return {
      fetchModel: jest.fn(async () => ({ downloaded: [], skipped: [] })),
      info: jest.fn(),
      error: jest.fn(),
    };
  }

  beforeEach(() => {
    __resetEmbedderReseedForTests();
  });

  it('downloads nothing when local intelligence is not opted in', async () => {
    const deps = reseedDependencies();
    await expect(reseedEmbedderIfMissing('sweep', {}, deps)).resolves.toBe(false);
    expect(deps.fetchModel).not.toHaveBeenCalled();
  });

  it('re-runs the pinned-manifest fetch and logs the error state loudly', async () => {
    const deps = reseedDependencies();
    await expect(
      reseedEmbedderIfMissing('embedding sweep', { SNAGLET_LOCAL_INTELLIGENCE: 'true' }, deps)
    ).resolves.toBe(true);

    expect(deps.fetchModel).toHaveBeenCalledTimes(1);
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('embedding sweep'));
  });

  it('is single-flight: concurrent callers share one fetch attempt', async () => {
    const deps = reseedDependencies();
    let release!: () => void;
    deps.fetchModel.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ downloaded: [], skipped: [] });
        }) as never
    );

    const env = { SNAGLET_LOCAL_INTELLIGENCE: 'true' };
    const first = reseedEmbedderIfMissing('a', env, deps);
    const second = reseedEmbedderIfMissing('b', env, deps);
    release();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(deps.fetchModel).toHaveBeenCalledTimes(1);
  });

  it('applies a cooldown after an attempt so a failing download is not hammered', async () => {
    const deps = reseedDependencies();
    deps.fetchModel.mockRejectedValueOnce(new Error('offline') as never);

    const env = { SNAGLET_LOCAL_INTELLIGENCE: 'true' };
    await expect(reseedEmbedderIfMissing('sweep', env, deps)).resolves.toBe(false);
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('auto-reseed failed'));

    // Within the cooldown window a new attempt is refused outright.
    await expect(reseedEmbedderIfMissing('sweep', env, deps)).resolves.toBe(false);
    expect(deps.fetchModel).toHaveBeenCalledTimes(1);
  });
});
