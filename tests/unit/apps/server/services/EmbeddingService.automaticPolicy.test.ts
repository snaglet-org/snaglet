import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const embedNode = jest.fn(async () => ({ ok: true }));

jest.mock('@server/services/embedding/EmbeddingOrchestrator', () => ({
  embedNode: (...args: unknown[]) => embedNode(...args),
}));
jest.mock('@server/services/embedding/EmbeddingProvider', () => ({
  resolveEmbeddingProvider: jest.fn(async () => null),
}));
jest.mock('@snaglet/db/tables/models', () => ({ Models: {} }));

import { syncMessageEmbedding } from '@server/services/EmbeddingService';

const previousLocalIntelligence = process.env.SNAGLET_LOCAL_INTELLIGENCE;

describe('automatic message embedding policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
  });

  afterAll(() => {
    if (previousLocalIntelligence === undefined) delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
    else process.env.SNAGLET_LOCAL_INTELLIGENCE = previousLocalIntelligence;
  });

  it('does not embed an ordinary message write by default', async () => {
    await syncMessageEmbedding('message-1', 'quiet write');

    expect(embedNode).not.toHaveBeenCalled();
  });

  it('embeds an ordinary message write after explicit opt-in', async () => {
    process.env.SNAGLET_LOCAL_INTELLIGENCE = 'true';

    await syncMessageEmbedding('message-1', 'indexed write');

    expect(embedNode).toHaveBeenCalledWith({ nodeId: 'message-1', content: 'indexed write' });
  });
});
