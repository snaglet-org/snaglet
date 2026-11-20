import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const storeMemory = jest.fn();
const recallMemory = jest.fn();
const forgetMemory = jest.fn();
const resolveCurrentActorMemberId = jest.fn();

jest.mock('@server/services/MemoryService.js', () => ({
  memoryService: {
    store: (...args: unknown[]) => storeMemory(...args),
    recall: (...args: unknown[]) => recallMemory(...args),
    forget: (...args: unknown[]) => forgetMemory(...args),
  },
}));

// resolveMemoryOwner's user-actor branch resolves through this real server
// seam (@server/realtime/actorMember) — mocked here the same way the real
// module is (edit_doc's pattern), so tests can drive "a user with a member
// row" vs. "a user with none" without touching a real DB.
jest.mock('@server/realtime/actorMember.js', () => ({
  resolveCurrentActorMemberId: (...args: unknown[]) => resolveCurrentActorMemberId(...args),
}));

import memoryStoreTool from '@server/services/ToolService/handlers/memory/memoryStore';
import memoryRecallTool from '@server/services/ToolService/handlers/memory/memoryRecall';
import memoryForgetTool from '@server/services/ToolService/handlers/memory/memoryForget';
import { runWithActor } from '@server/realtime/actorContext';

describe('memory_store tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storeMemory.mockResolvedValue({ id: 'memory-1', key: 'project-plan', isDuplicate: false });
  });

  it('auto-generates a key from content when key is omitted', async () => {
    storeMemory.mockImplementationOnce(async (input: { key: string }) => ({
      id: 'memory-1',
      key: input.key,
      isDuplicate: false,
    }));

    const result = await memoryStoreTool(
      { content: 'Ship provenance wiring' },
      {},
      {
        agentId: 'agent-1',
        threadId: 'thread-1',
      }
    );

    // Agent path: resolveMemoryOwner short-circuits on ctx.agentId without
    // touching the actor/member seam at all.
    expect(storeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        key: 'ship-provenance-wiring',
      })
    );
    expect(resolveCurrentActorMemberId).not.toHaveBeenCalled();
    expect(result).toContain("Memory stored: 'ship-provenance-wiring'");
  });

  it('requires agent context when there is no actor at all', async () => {
    await expect(
      memoryStoreTool(
        { key: 'k', content: 'c' },
        {},
        {
          threadId: 'thread-1',
        }
      )
    ).rejects.toThrow('memory (create) requires agent context');
    expect(storeMemory).not.toHaveBeenCalled();
  });

  it('stores under the resolved member id for a user-actor call with no agent context', async () => {
    resolveCurrentActorMemberId.mockResolvedValue('member-42');

    const result = await runWithActor({ actorKind: 'user', actorId: 'user-42' }, () =>
      memoryStoreTool({ key: 'k', content: 'User note' }, {}, { threadId: 'thread-1' })
    );

    expect(storeMemory).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'member-42', content: 'User note' })
    );
    // Never both owner fields set on a member-owned store.
    expect(storeMemory.mock.calls[0]![0]).not.toHaveProperty('agentId');
    expect(result).toContain('Memory stored');
  });

  it('throws the standard error for a user actor with no resolvable member row', async () => {
    resolveCurrentActorMemberId.mockResolvedValue(null);

    await expect(
      runWithActor({ actorKind: 'user', actorId: 'user-orphan' }, () =>
        memoryStoreTool({ key: 'k', content: 'c' }, {}, {})
      )
    ).rejects.toThrow('memory (create) requires agent context');
    expect(storeMemory).not.toHaveBeenCalled();
  });
});

describe('memory_recall tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recallMemory.mockResolvedValue([]);
  });

  it('recalls under the agent owner — unchanged agent-run path', async () => {
    recallMemory.mockResolvedValue([
      { id: 'memory-1', key: 'plan', content: 'Ship it', combinedScore: 0.9 },
    ]);

    const result = await memoryRecallTool(
      { query: 'plan' },
      {},
      { agentId: 'agent-1', threadId: 'thread-1' }
    );

    expect(recallMemory).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', query: 'plan' })
    );
    expect(result).toContain('Ship it');
  });

  it('recalls under the resolved member id for a user-actor call', async () => {
    resolveCurrentActorMemberId.mockResolvedValue('member-42');
    recallMemory.mockResolvedValue([
      { id: 'memory-2', key: 'note', content: 'User content', combinedScore: 0.5 },
    ]);

    const result = await runWithActor({ actorKind: 'user', actorId: 'user-42' }, () =>
      memoryRecallTool({ query: 'note' }, {}, {})
    );

    expect(recallMemory).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'member-42' }));
    expect(result).toContain('User content');
  });

  it('requires agent context when there is no actor at all', async () => {
    await expect(memoryRecallTool({ query: 'x' }, {}, {})).rejects.toThrow(
      'memory (search) requires agent context'
    );
    expect(recallMemory).not.toHaveBeenCalled();
  });
});

describe('memory_forget tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    forgetMemory.mockResolvedValue({ count: 1 });
  });

  it('forgets under the agent owner — unchanged agent-run path', async () => {
    const result = await memoryForgetTool(
      { query: 'old plan' },
      {},
      { agentId: 'agent-1', threadId: 'thread-1' }
    );

    expect(forgetMemory).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', query: 'old plan' })
    );
    expect(result).toContain('Forgot 1 memory(ies)');
  });

  it('forgets under the resolved member id for a user-actor call', async () => {
    resolveCurrentActorMemberId.mockResolvedValue('member-42');

    await runWithActor({ actorKind: 'user', actorId: 'user-42' }, () =>
      memoryForgetTool({ query: 'old note' }, {}, {})
    );

    expect(forgetMemory).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'member-42', query: 'old note' })
    );
  });

  it('requires agent context when there is no actor at all', async () => {
    await expect(memoryForgetTool({ query: 'x' }, {}, {})).rejects.toThrow(
      'memory (delete) requires agent context'
    );
    expect(forgetMemory).not.toHaveBeenCalled();
  });
});
