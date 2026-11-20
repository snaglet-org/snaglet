/**
 * redispatchPersistedMessage — the chain context a queued wave runs in when a
 * covered message's row fails to load.
 *
 * An unloadable row's stamp is unknown, not absent: it may be a hook's message
 * at some depth. Snaglet does not refuse on depth, so this only keeps the wave
 * from reading as a person's message (depth 0): it records depth 1.
 *
 * Mocked: message rows, the thread lookup (it records the bound chain context
 * and ends the dispatch as no_dispatch), logs.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { currentChainDepth, currentHookChain } from '@server/realtime/runContext';

interface FakeRow {
  id: string;
  content: string;
  agentId?: string;
  metadata?: unknown;
}
const mockRows = new Map<string, FakeRow | 'throws'>();
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    findById: async (id: string) => {
      const row = mockRows.get(id);
      if (row === 'throws') throw new Error('SQLITE_BUSY: database is locked');
      return row ?? null;
    },
  },
}));

/** The chain context each dispatch ran in (read at the first await of dispatchToThread). */
const mockBound: Array<{ depth: number; hooks: readonly string[] }> = [];
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: {
    findById: async () => {
      mockBound.push({ depth: currentChainDepth(), hooks: currentHookChain() });
      return null;
    },
  },
}));

const mockWarn = jest.fn();
const makeLogsProxy = (): unknown =>
  new Proxy(jest.fn(), {
    get: (_t, prop) => (prop === 'warn' ? mockWarn : makeLogsProxy()),
    apply: () => undefined,
  });
jest.mock('@server/services/LogsService', () => ({ LogsService: makeLogsProxy() }));

import { redispatchPersistedMessage } from '@server/services/SocketService/dispatch/dispatchToThread';

const THREAD = 'thread-chainstamp-redispatch';
const SEED: FakeRow = { id: 'message-seed', content: 'hello', agentId: 'agent-a' };

function redispatch(coveredMessageIds: string[]) {
  return redispatchPersistedMessage({
    threadId: THREAD,
    threadName: 'T',
    messageId: SEED.id,
    coveredMessageIds,
    undeliveredCount: coveredMessageIds.length,
    reason: 'test',
  });
}

beforeEach(() => {
  mockRows.clear();
  mockRows.set(SEED.id, SEED);
  mockBound.length = 0;
  mockWarn.mockClear();
});

describe('redispatchPersistedMessage — chain context of covered messages', () => {
  it('loaded, unstamped messages run at depth 0 (a person’s messages)', async () => {
    mockRows.set('message-b', { id: 'message-b', content: 'b' });
    await redispatch([SEED.id, 'message-b']);
    expect(mockBound).toEqual([{ depth: 0, hooks: [] }]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('a loaded stamped message keeps its depth', async () => {
    mockRows.set('message-b', {
      id: 'message-b',
      content: 'b',
      metadata: { chain: { depth: 2, hooks: ['h'] } },
    });
    await redispatch([SEED.id, 'message-b']);
    expect(mockBound).toEqual([{ depth: 2, hooks: ['h'] }]);
  });

  it.each([
    ['throws', 'throws' as const],
    ['is missing', undefined],
  ])('a covered row that %s records a hook-caused depth 1, never depth 0', async (_label, row) => {
    if (row) mockRows.set('message-lost', row);
    await redispatch([SEED.id, 'message-lost']);
    // Still delivered (no lost wake); recorded as a hook-caused depth, not a
    // person's message. Depth refuses nothing.
    expect(mockBound).toEqual([{ depth: 1, hooks: [] }]);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('failed to load'),
      expect.objectContaining({ unloadedIds: ['message-lost'], chainDepth: 1 })
    );
  });

  it('an unloadable row never lowers a deeper stamp and keeps its chain', async () => {
    mockRows.set(SEED.id, { ...SEED, metadata: { chain: { depth: 7, hooks: ['a', 'b'] } } });
    mockRows.set('message-lost', 'throws');
    await redispatch([SEED.id, 'message-lost']);
    expect(mockBound).toEqual([{ depth: 7, hooks: ['a', 'b'] }]);
  });
});
