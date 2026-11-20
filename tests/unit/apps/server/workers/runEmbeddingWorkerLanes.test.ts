import { describe, expect, it, jest } from '@jest/globals';
import { runEmbeddingWorkerLanes } from '@server/workers/runEmbeddingWorkerLanes';

function lanes(enabled: boolean) {
  return {
    automaticLocalIntelligenceEnabled: enabled,
    sweepAutomaticEmbeddings: jest.fn(async () => undefined),
    sweepSettledEdits: jest.fn(async () => undefined),
  };
}

describe('embedding worker policy lanes', () => {
  it('runs no lanes (including the settled-doc re-embed) while automatic inference is off', async () => {
    const callbacks = lanes(false);
    await runEmbeddingWorkerLanes(callbacks);

    expect(callbacks.sweepSettledEdits).not.toHaveBeenCalled();
    expect(callbacks.sweepAutomaticEmbeddings).not.toHaveBeenCalled();
  });

  it('runs every lane after explicit opt-in', async () => {
    const callbacks = lanes(true);
    await runEmbeddingWorkerLanes(callbacks);

    expect(callbacks.sweepAutomaticEmbeddings).toHaveBeenCalledTimes(1);
    expect(callbacks.sweepSettledEdits).toHaveBeenCalledTimes(1);
  });
});
