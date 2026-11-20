// Mock @snaglet/db before importing the service
const mockListAgents = jest.fn();
const mockFindAgentById = jest.fn();
const mockFindAgentByName = jest.fn();
const mockCreateAgent = jest.fn();
const mockUpdateAgent = jest.fn();
const mockPurgeAgent = jest.fn();
const mockArchiveAgent = jest.fn();
const mockRestoreAgent = jest.fn();
const mockFindByProviderAndModelId = jest.fn();
const mockListDmIdsForAgent = jest.fn();
const mockWithThreadExecutionPurge = jest.fn();
const mockDeleteOfType = jest.fn();
const mockListByAgent = jest.fn();
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: { listByAgent: (...a: unknown[]) => mockListByAgent(...a) },
}));
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { listDmIdsForAgent: (...a: unknown[]) => mockListDmIdsForAgent(...a) },
}));
jest.mock('@snaglet/db/tables/nodes', () => ({
  Nodes: { deleteOfType: (...a: unknown[]) => mockDeleteOfType(...a) },
}));
const mockEmitThreadDeleted = jest.fn();
const mockEmitTreeNodeDeleted = jest.fn();
jest.mock('@server/realtime/surfaces/threads', () => ({
  ...jest.requireActual<object>('@server/realtime/surfaces/threads'),
  emitThreadDeleted: (...a: unknown[]) => mockEmitThreadDeleted(...a),
}));
jest.mock('@server/realtime/surfaces/tree', () => ({
  ...jest.requireActual<object>('@server/realtime/surfaces/tree'),
  emitTreeNodeDeleted: (...a: unknown[]) => mockEmitTreeNodeDeleted(...a),
}));
jest.mock('@server/services/ThreadExecutionPurgeService', () => ({
  withThreadExecutionPurge: (...a: unknown[]) => mockWithThreadExecutionPurge(...a),
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: {
    list: mockListAgents,
    findById: mockFindAgentById,
    findByName: mockFindAgentByName,
    create: mockCreateAgent,
    update: mockUpdateAgent,
    purge: mockPurgeAgent,
    archive: mockArchiveAgent,
    restore: mockRestoreAgent,
  },
}));

jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    findByProviderAndModelId: mockFindByProviderAndModelId,
  },
}));

// Realtime events are asserted at the broadcast funnel so the surface helper's
// "only fields that actually changed" filtering runs for real.
const mockEmitWorkspaceEvent = jest.fn();
jest.mock('@server/realtime/emit', () => ({
  emitWorkspaceEvent: (...args: unknown[]) => mockEmitWorkspaceEvent(...args),
}));

import { AppError, ConflictError } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';
import { agentService } from '@server/services/AgentService';
import { threadRosterVersion } from '@server/services/SocketService/dispatch/rosterVersion';

// Sample row matching the camelCase AgentRow shape (the Model layer
// transforms snake_case DB columns to camelCase before reaching the service).
function makeAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    name: 'Venus',
    role: 'CTO',
    avatarUrl: null,
    credentialId: null,
    modelId: 'claude-sonnet-4-5',
    defaultThreadId: null,
    systemPrompt: 'You are Venus.',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('AgentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Ensure ensureDefaults doesn't try to seed by returning at least one agent
    mockListAgents.mockResolvedValue([makeAgentRow()]);
    mockListDmIdsForAgent.mockResolvedValue([]);
    mockListByAgent.mockResolvedValue([]);
    // Model metadata check is advisory; resolve with full metadata to keep logs quiet
    mockFindByProviderAndModelId.mockResolvedValue({ maxOutputTokens: 8192 });
  });

  describe('list', () => {
    it('should return agents mapped from DB rows', async () => {
      mockListAgents.mockResolvedValue([
        makeAgentRow({ id: 'a1', name: 'Venus' }),
        makeAgentRow({ id: 'a2', name: 'Clio', role: null }),
      ]);

      const agents = await agentService.list();

      expect(agents).toHaveLength(2);
      expect(agents[0].id).toBe('a1');
      expect(agents[0].name).toBe('Venus');
      expect(agents[1].role).toBeUndefined(); // null → undefined
    });
  });

  describe('get', () => {
    it('should return mapped agent when found', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1' }));

      const agent = await agentService.get('a1');

      expect(agent).toBeDefined();
      expect(agent!.id).toBe('a1');
    });

    it('should return undefined when not found', async () => {
      mockFindAgentById.mockResolvedValue(null);

      const agent = await agentService.get('missing');

      expect(agent).toBeUndefined();
    });

    // The raw stored value ships as rawIdentity (mirroring rawSystemPrompt) so
    // the Identity editor can render `![](doc-id)` include chips as framed
    // embeds and round-trip saves; `identity` is the expanded form.
    it('exposes the raw stored identity as rawIdentity alongside the expanded identity', async () => {
      const rawIdentity = 'Core persona: ![](doc-123)';
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1', identity: rawIdentity }));

      const agent = await agentService.get('a1');

      expect(agent!.rawIdentity).toBe(rawIdentity);
      // The expanded channel is still the resolved form — never the raw
      // chip syntax (here the include collapses to a not-found marker since
      // no doc exists in this unit environment).
      expect(agent!.identity).not.toBe(rawIdentity);
      expect(agent!.identity).not.toContain('![](doc-123)');
      // Parity with the system-prompt raw channel.
      expect(agent!.rawSystemPrompt).toBe('You are Venus.');
    });
  });

  describe('create', () => {
    it('should insert and return the new agent', async () => {
      const row = makeAgentRow({ id: 'newbot', name: 'NewBot' });
      mockFindAgentByName.mockResolvedValue(null);
      mockFindAgentById.mockResolvedValue(null);
      mockCreateAgent.mockResolvedValue(row);

      const agent = await agentService.create({
        name: 'NewBot',
        provider: 'openai',
        modelId: 'gpt-4o',
        identity: null,
        systemPrompt: 'You are NewBot.',
        configJson: {},
      });

      expect(mockCreateAgent).toHaveBeenCalledTimes(1);
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'newbot', name: 'NewBot' })
      );
      expect(agent.name).toBe('NewBot');
    });
  });

  describe('purge (permanent delete; history moves to ghost)', () => {
    it('should delete the agent via Agents.purge and return the destroyed/repointed counts', async () => {
      mockPurgeAgent.mockResolvedValue({
        originalName: 'Bill',
        deletedMemories: 2,
        deletedSummaries: 1,
        repointedMessages: 5,
        repointedRuns: 3,
      });

      const result = await agentService.purge('a1');

      expect(mockPurgeAgent).toHaveBeenCalledWith('a1');
      expect(result).toMatchObject({
        originalName: 'Bill',
        repointedMessages: 5,
        repointedRuns: 3,
      });
    });

    it('should return null when the agent does not exist (idempotent)', async () => {
      mockPurgeAgent.mockResolvedValue(null);

      const result = await agentService.purge('missing');

      expect(result).toBeNull();
    });

    it('refuses to delete ghost and never calls Agents.purge (service-layer guard)', async () => {
      await expect(agentService.purge('ghost')).rejects.toThrow(/cannot be deleted/i);
      expect(mockPurgeAgent).not.toHaveBeenCalled();
    });
  });

  describe('purge removes the agent DM threads', () => {
    const tx = { query: jest.fn() };
    beforeEach(() => {
      mockWithThreadExecutionPurge.mockImplementation(async (...args: unknown[]) => {
        const op = args[1] as (ctx: { tx: unknown }) => Promise<void>;
        await op({ tx });
      });
    });

    it('deletes its DM threads before the agent row', async () => {
      const order: string[] = [];
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1' }));
      mockListDmIdsForAgent.mockResolvedValue(['thread-dm-1', 'thread-dm-2']);
      mockDeleteOfType.mockImplementation(async (id: unknown) => {
        order.push(`delete:${String(id)}`);
      });
      mockPurgeAgent.mockImplementation(async () => {
        order.push('purge');
        return { originalName: 'Bill', deletedMemories: 0, deletedSummaries: 0 };
      });

      await agentService.purge('a1');

      // The one delete that may take the user's home thread with the agent.
      expect(mockWithThreadExecutionPurge).toHaveBeenCalledWith(
        ['thread-dm-1', 'thread-dm-2'],
        expect.any(Function),
        { allowsHomeThreads: true }
      );
      expect(mockDeleteOfType).toHaveBeenCalledWith('thread-dm-1', 'thread', tx);
      expect(order).toEqual(['delete:thread-dm-1', 'delete:thread-dm-2', 'purge']);
      for (const id of ['thread-dm-1', 'thread-dm-2']) {
        expect(mockEmitThreadDeleted).toHaveBeenCalledWith(id);
        expect(mockEmitTreeNodeDeleted).toHaveBeenCalledWith(id, 'thread');
      }
    });

    it('fails the agent delete, leaving the agent, when a DM thread cannot be deleted', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1' }));
      mockListDmIdsForAgent.mockResolvedValue(['thread-dm-1']);
      mockWithThreadExecutionPurge.mockRejectedValue(new Error('thread has an active run'));

      await expect(agentService.purge('a1')).rejects.toThrow(/DM threads.*active run/i);
      expect(mockPurgeAgent).not.toHaveBeenCalled();
      expect(mockEmitThreadDeleted).not.toHaveBeenCalled();
      expect(mockEmitTreeNodeDeleted).not.toHaveBeenCalled();
    });

    it('rethrows a conflict from the DM purge unchanged, so an active run stays a 409', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1' }));
      mockListDmIdsForAgent.mockResolvedValue(['thread-dm-1']);
      const conflict = new ConflictError('Thread thread-dm-1 has an active run');
      mockWithThreadExecutionPurge.mockRejectedValue(conflict);

      await expect(agentService.purge('a1')).rejects.toBe(conflict);
      expect(mockPurgeAgent).not.toHaveBeenCalled();
    });

    it('rethrows any other app error unchanged instead of relabeling it a conflict', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1' }));
      mockListDmIdsForAgent.mockResolvedValue(['thread-dm-1']);
      const notFound = new AppError('Thread not found', ErrorCode.NOT_FOUND, 404);
      mockWithThreadExecutionPurge.mockRejectedValue(notFound);

      await expect(agentService.purge('a1')).rejects.toBe(notFound);
      expect(mockPurgeAgent).not.toHaveBeenCalled();
    });

    it('wraps an unexpected DM purge failure as a 500 that says the agent was not deleted', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1' }));
      mockListDmIdsForAgent.mockResolvedValue(['thread-dm-1']);
      mockWithThreadExecutionPurge.mockRejectedValue(new Error('connection reset'));

      const failure = await agentService.purge('a1').catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({ statusCode: 500, code: ErrorCode.INTERNAL_ERROR });
      expect((failure as AppError).message).toMatch(
        /DM threads.*agent was not deleted.*connection reset/i
      );
      expect(mockPurgeAgent).not.toHaveBeenCalled();
    });

    it('still deletes the agent when a thread-deleted emit throws after the DM threads are gone', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1' }));
      mockListDmIdsForAgent.mockResolvedValue(['thread-dm-1', 'thread-dm-2']);
      mockEmitThreadDeleted.mockImplementationOnce(() => {
        throw new Error('socket closed');
      });
      const purged = { originalName: 'Bill', deletedMemories: 0, deletedSummaries: 0 };
      mockPurgeAgent.mockResolvedValue(purged);

      await expect(agentService.purge('a1')).resolves.toBe(purged);
      expect(mockPurgeAgent).toHaveBeenCalledWith('a1');
      // The failed emit is best-effort: the next thread is still announced.
      expect(mockEmitThreadDeleted).toHaveBeenCalledWith('thread-dm-2');
      expect(mockEmitTreeNodeDeleted).toHaveBeenCalledWith('thread-dm-2', 'thread');
    });

    it('skips the thread purge when the agent has no DM threads, and for a missing agent', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1' }));
      mockListDmIdsForAgent.mockResolvedValue([]);
      mockPurgeAgent.mockResolvedValue({ originalName: 'Bill' });
      await agentService.purge('a1');
      expect(mockWithThreadExecutionPurge).not.toHaveBeenCalled();

      mockFindAgentById.mockResolvedValue(null);
      mockPurgeAgent.mockResolvedValue(null);
      expect(await agentService.purge('missing')).toBeNull();
      expect(mockListDmIdsForAgent).toHaveBeenCalledTimes(1);
    });
  });

  describe('dmEnabled', () => {
    it('update persists the flag', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1', dmEnabled: true }));
      mockUpdateAgent.mockResolvedValue(makeAgentRow({ id: 'a1', dmEnabled: false }));

      const updated = await agentService.update('a1', { dmEnabled: false });

      expect(mockUpdateAgent).toHaveBeenCalledWith('a1', { dmEnabled: false });
      expect(updated?.dmEnabled).toBe(false);
    });
  });

  describe('ghost + reserved-name guards', () => {
    it('create rejects the reserved name "ghost" (any case) before touching the DB', async () => {
      for (const name of ['ghost', 'GHOST', 'Ghost']) {
        mockCreateAgent.mockClear();
        await expect(agentService.create({ name } as never)).rejects.toThrow(/reserved/i);
        expect(mockCreateAgent).not.toHaveBeenCalled();
      }
    });

    it('create rejects "system" (the ghost hook label) in any case', async () => {
      for (const name of ['system', 'SYSTEM', ' System ']) {
        mockCreateAgent.mockClear();
        await expect(agentService.create({ name } as never)).rejects.toThrow(/reserved/i);
        expect(mockCreateAgent).not.toHaveBeenCalled();
      }
    });

    it('update rejects a rename to "system" and never calls Agents.update', async () => {
      await expect(agentService.update('a1', { name: 'System' } as never)).rejects.toThrow(
        /reserved/i
      );
      expect(mockUpdateAgent).not.toHaveBeenCalled();
    });

    it('update rejects a rename to "ghost" and never calls Agents.update', async () => {
      await expect(agentService.update('a1', { name: 'Ghost' } as never)).rejects.toThrow(
        /reserved/i
      );
      expect(mockUpdateAgent).not.toHaveBeenCalled();
    });

    it('update refuses to modify ghost itself', async () => {
      await expect(agentService.update('ghost', { role: 'x' } as never)).rejects.toThrow(
        /cannot be/i
      );
      expect(mockUpdateAgent).not.toHaveBeenCalled();
    });

    it('archive refuses to archive ghost', async () => {
      await expect(agentService.archive('ghost')).rejects.toThrow(/cannot be archived/i);
      expect(mockArchiveAgent).not.toHaveBeenCalled();
    });
  });

  describe('archive / restore', () => {
    it('archive delegates to Agents.archive and maps the archived row', async () => {
      mockArchiveAgent.mockResolvedValue(
        makeAgentRow({ id: 'a1', archived: true, archivedAt: '2026-07-06T00:00:00Z' })
      );

      const agent = await agentService.archive('a1');

      expect(mockArchiveAgent).toHaveBeenCalledWith('a1');
      expect(agent!.archived).toBe(true);
      expect(agent!.archivedAt).toBe('2026-07-06T00:00:00Z');
      // Archiving preserves history: it never routes through the destructive sweep
      expect(mockPurgeAgent).not.toHaveBeenCalled();
    });

    it('archive returns null when the agent does not exist', async () => {
      mockArchiveAgent.mockResolvedValue(null);
      expect(await agentService.archive('missing')).toBeNull();
    });

    it('restore delegates to Agents.restore and maps the restored row', async () => {
      mockRestoreAgent.mockResolvedValue(
        makeAgentRow({ id: 'a1', archived: false, archivedAt: null })
      );

      const agent = await agentService.restore('a1');

      expect(mockRestoreAgent).toHaveBeenCalledWith('a1');
      expect(agent!.archived).toBe(false);
      expect(agent!.archivedAt).toBeNull();
    });

    it('restore returns null when the agent does not exist', async () => {
      mockRestoreAgent.mockResolvedValue(null);
      expect(await agentService.restore('missing')).toBeNull();
    });
  });

  describe('realtime agent.updated', () => {
    it('update names only the fields whose stored value changed', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1', role: 'CTO', voice: 'v1' }));
      mockUpdateAgent.mockResolvedValue(makeAgentRow({ id: 'a1', role: 'CEO', voice: 'v1' }));

      await agentService.update('a1', { role: 'CEO', voice: 'v1' } as never);

      expect(mockEmitWorkspaceEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitWorkspaceEvent).toHaveBeenCalledWith({
        type: 'agent.updated',
        agentId: 'a1',
        changed: ['role'],
        updatedAt: '2026-01-01T00:00:00Z',
      });
    });

    it('update carries the revision of the written row, not the row read before it', async () => {
      mockFindAgentById.mockResolvedValue(
        makeAgentRow({ id: 'a1', identity: 'old', updatedAt: '2026-01-01T00:00:00Z' })
      );
      mockUpdateAgent.mockResolvedValue(
        makeAgentRow({ id: 'a1', identity: 'new', updatedAt: '2026-11-16T10:00:00.5+00:00' })
      );

      await agentService.update('a1', { identity: 'new' } as never);

      expect(mockEmitWorkspaceEvent).toHaveBeenCalledWith({
        type: 'agent.updated',
        agentId: 'a1',
        changed: ['identity'],
        updatedAt: '2026-11-16T10:00:00.5+00:00',
      });
    });

    it('update emits nothing when every written value is unchanged', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1', role: 'CTO' }));
      mockUpdateAgent.mockResolvedValue(makeAgentRow({ id: 'a1', role: 'CTO' }));

      await agentService.update('a1', { role: 'CTO' } as never);

      expect(mockEmitWorkspaceEvent).not.toHaveBeenCalled();
    });

    it('update emits nothing when the agent does not exist', async () => {
      mockFindAgentById.mockResolvedValue(null);
      mockUpdateAgent.mockResolvedValue(null);

      expect(await agentService.update('missing', { role: 'CEO' } as never)).toBeNull();
      expect(mockEmitWorkspaceEvent).not.toHaveBeenCalled();
    });

    it('archive and restore announce the archived flag, with no revision', async () => {
      // Archiving does not bump updated_at, so the row's revision is the one
      // an open pane already holds. Sending it would make the pane skip the
      // change as its own echo; without one the pane refetches.
      mockArchiveAgent.mockResolvedValue(makeAgentRow({ id: 'a1', archived: true }));
      mockRestoreAgent.mockResolvedValue(makeAgentRow({ id: 'a1', archived: false }));

      await agentService.archive('a1');
      await agentService.restore('a1');

      expect(mockEmitWorkspaceEvent).toHaveBeenNthCalledWith(1, {
        type: 'agent.updated',
        agentId: 'a1',
        changed: ['archived'],
      });
      expect(mockEmitWorkspaceEvent).toHaveBeenNthCalledWith(2, {
        type: 'agent.updated',
        agentId: 'a1',
        changed: ['archived'],
      });
    });

    it('archive and purge bump the roster of every thread the agent is in', async () => {
      mockListByAgent.mockResolvedValue([{ threadId: 't-archive-1' }, { threadId: 't-archive-2' }]);
      mockArchiveAgent.mockResolvedValue(makeAgentRow({ id: 'a1', archived: true }));
      const before = [threadRosterVersion('t-archive-1'), threadRosterVersion('t-archive-2')];

      await agentService.archive('a1');

      expect(threadRosterVersion('t-archive-1')).toBe(before[0]! + 1);
      expect(threadRosterVersion('t-archive-2')).toBe(before[1]! + 1);

      mockListByAgent.mockResolvedValue([{ threadId: 't-purge-1' }]);
      mockPurgeAgent.mockResolvedValueOnce({ originalName: 'Test Agent' });
      const purgeBefore = threadRosterVersion('t-purge-1');
      await agentService.purge('a1');
      expect(threadRosterVersion('t-purge-1')).toBe(purgeBefore + 1);
    });

    it('a failed thread lookup never fails the archive', async () => {
      mockListByAgent.mockRejectedValueOnce(new Error('db down'));
      mockArchiveAgent.mockResolvedValue(makeAgentRow({ id: 'a1', archived: true }));
      await expect(agentService.archive('a1')).resolves.not.toBeNull();
    });

    it('purge announces the deletion only when an agent was removed', async () => {
      mockPurgeAgent.mockResolvedValueOnce({ originalName: 'Test Agent' });
      await agentService.purge('a1');
      mockPurgeAgent.mockResolvedValueOnce(null);
      await agentService.purge('missing');

      expect(mockEmitWorkspaceEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitWorkspaceEvent).toHaveBeenCalledWith({
        type: 'agent.updated',
        agentId: 'a1',
        changed: ['deleted'],
      });
    });
  });

  describe('rowToAgent mapping', () => {
    it('should surface camelCase row fields on the SnagletAgent', async () => {
      mockFindAgentById.mockResolvedValue(
        makeAgentRow({
          avatarUrl: 'https://example.com/avatar.png',
          credentialId: 'cred-1',
          systemPrompt: 'Hello!',
          createdAt: '2026-03-01T00:00:00Z',
          updatedAt: '2026-03-02T00:00:00Z',
        })
      );

      const agent = await agentService.get('any');

      expect(agent!.avatarUrl).toBe('https://example.com/avatar.png');
      expect(agent!.credentialId).toBe('cred-1');
      expect(agent!.systemPrompt).toBe('Hello!');
      expect(agent!.createdAt).toBe('2026-03-01T00:00:00Z');
      expect(agent!.updatedAt).toBe('2026-03-02T00:00:00Z');
    });

    it('should convert null role to undefined', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ role: null }));
      const agent = await agentService.get('any');
      expect(agent!.role).toBeUndefined();
    });

    it('should convert null avatarUrl to undefined', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ avatarUrl: null }));
      const agent = await agentService.get('any');
      expect(agent!.avatarUrl).toBeUndefined();
    });
  });

  describe('trustedToolCalls round-trip', () => {
    it('maps a true column to trustedToolCalls: true on read', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1', trustedToolCalls: true }));

      const agent = await agentService.get('a1');

      expect(agent?.trustedToolCalls).toBe(true);
    });

    it('maps a false or missing column to false (legacy rows)', async () => {
      mockFindAgentById.mockResolvedValueOnce(makeAgentRow({ id: 'a1', trustedToolCalls: false }));
      expect((await agentService.get('a1'))?.trustedToolCalls).toBe(false);

      mockFindAgentById.mockResolvedValueOnce(makeAgentRow({ id: 'a1' }));
      expect((await agentService.get('a1'))?.trustedToolCalls).toBe(false);
    });

    it('update writes the boolean through and returns the mapped row', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1' }));
      mockUpdateAgent.mockResolvedValue(makeAgentRow({ id: 'a1', trustedToolCalls: true }));

      const updated = await agentService.update('a1', { trustedToolCalls: true } as never);

      expect(mockUpdateAgent).toHaveBeenCalledWith('a1', { trustedToolCalls: true });
      expect(updated?.trustedToolCalls).toBe(true);

      mockUpdateAgent.mockResolvedValue(makeAgentRow({ id: 'a1', trustedToolCalls: false }));
      const reverted = await agentService.update('a1', { trustedToolCalls: false } as never);
      expect(mockUpdateAgent).toHaveBeenLastCalledWith('a1', { trustedToolCalls: false });
      expect(reverted?.trustedToolCalls).toBe(false);
    });

    it('update leaves the flag untouched when the patch does not mention it', async () => {
      mockFindAgentById.mockResolvedValue(makeAgentRow({ id: 'a1', trustedToolCalls: true }));
      mockUpdateAgent.mockResolvedValue(
        makeAgentRow({ id: 'a1', role: 'CEO', trustedToolCalls: true })
      );

      await agentService.update('a1', { role: 'CEO' } as never);

      expect(mockUpdateAgent).toHaveBeenCalledWith(
        'a1',
        expect.not.objectContaining({ trustedToolCalls: expect.anything() })
      );
    });
  });
});
