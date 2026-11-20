/**
 * A subagent's thread runs with no wave cap and the largest output budget the
 * server allows, whatever its row or the settings profile say: its settings
 * show neither limit. A regular thread keeps its own values.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const findById = jest.fn<(id: string) => Promise<unknown>>();

jest.mock('@snaglet/db', () => ({
  getPool: jest.fn(() => ({ query: jest.fn() })),
  getDb: jest.fn(() => ({ query: jest.fn() })),
}));
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (id: string) => findById(id) },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: { listByThread: async () => [] },
}));

import { resolveThreadRuntimeConfig } from '@server/services/ConfigResolverService';
import { DEFAULT_CONVERSATION_OUTPUT_TOKENS } from '@snaglet/shared/constants';

const base = {
  threadSystemPrompt: null,
  maxAgentDispatches: null,
  toolAccessAllowList: null,
  toolAccessDenyList: null,
};

describe('thread runtime budget', () => {
  beforeEach(() => findById.mockReset());

  it("a subagent's thread has no wave cap and the maximum output budget", async () => {
    findById.mockResolvedValue({
      ...base,
      id: 'thread-helper',
      parentThreadId: 'thread-parent',
      maxWaves: 3,
      maxTotalOutputTokens: 1000,
    });
    const config = await resolveThreadRuntimeConfig('thread-helper');
    expect(config?.budget?.maxWaves).toBeNull();
    expect(config?.budget?.maxTotalOutputTokens).toBe(DEFAULT_CONVERSATION_OUTPUT_TOKENS);
  });

  it('a regular thread keeps its own limits', async () => {
    findById.mockResolvedValue({
      ...base,
      id: 'thread-1',
      parentThreadId: null,
      maxWaves: 3,
      maxTotalOutputTokens: 1000,
    });
    const config = await resolveThreadRuntimeConfig('thread-1');
    expect(config?.budget?.maxWaves).toBe(3);
    expect(config?.budget?.maxTotalOutputTokens).toBe(1000);
  });
});
