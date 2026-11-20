import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const editMemory = jest.fn();
const resolveCurrentActorMemberId = jest.fn();

jest.mock('@server/services/MemoryService.js', () => ({
  memoryService: {
    edit: (...args: unknown[]) => editMemory(...args),
  },
}));

// Same actor/member seam the other memory tools resolve their owner through.
jest.mock('@server/realtime/actorMember.js', () => ({
  resolveCurrentActorMemberId: (...args: unknown[]) => resolveCurrentActorMemberId(...args),
}));

import memoryEditTool from '@server/services/ToolService/handlers/memory/memoryEdit';
import { runWithActor } from '@server/realtime/actorContext';

const AGENT_CTX = { agentId: 'agent-1', threadId: 'thread-1' };

describe('memory update handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    editMemory.mockResolvedValue({
      status: 'updated',
      id: 'memory-1',
      key: 'plan',
      content: 'updated content',
    });
  });

  describe('target selection', () => {
    it('edits by memory_id', async () => {
      const result = await memoryEditTool(
        { memory_id: 'memory-1', mode: 'overwrite', content: 'updated content' },
        {},
        AGENT_CTX
      );

      expect(editMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          memoryId: 'memory-1',
          edit: { mode: 'overwrite', content: 'updated content' },
        })
      );
      expect(result).toContain("Memory updated: 'plan' (id: memory-1)");
      expect(result).toContain('updated content');
    });

    it('edits by key', async () => {
      await memoryEditTool(
        { key: 'plan', mode: 'overwrite', content: 'updated content' },
        {},
        AGENT_CTX
      );

      expect(editMemory).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-1', key: 'plan' })
      );
      const call = editMemory.mock.calls[0]![0] as { memoryId?: string };
      expect(call.memoryId).toBeUndefined();
    });

    it('rejects both memory_id and key', async () => {
      await expect(
        memoryEditTool(
          { memory_id: 'memory-1', key: 'plan', mode: 'overwrite', content: 'x' },
          {},
          AGENT_CTX
        )
      ).rejects.toThrow('pass memory_id or key, not both');
      expect(editMemory).not.toHaveBeenCalled();
    });

    it('rejects neither memory_id nor key', async () => {
      await expect(
        memoryEditTool({ mode: 'overwrite', content: 'x' }, {}, AGENT_CTX)
      ).rejects.toThrow('memory update requires one of memory_id or key');
      expect(editMemory).not.toHaveBeenCalled();
    });
  });

  describe('modes', () => {
    it('rejects a missing or unknown mode', async () => {
      await expect(
        memoryEditTool({ memory_id: 'memory-1', content: 'x' }, {}, AGENT_CTX)
      ).rejects.toThrow('mode is required and must be one of overwrite | append | replace');

      await expect(
        memoryEditTool({ memory_id: 'memory-1', mode: 'prepend', content: 'x' }, {}, AGENT_CTX)
      ).rejects.toThrow('mode is required and must be one of overwrite | append | replace');

      expect(editMemory).not.toHaveBeenCalled();
    });

    it('passes append through with an explicit separator, and omits it otherwise', async () => {
      await memoryEditTool(
        { memory_id: 'memory-1', mode: 'append', content: 'more', separator: ' — ' },
        {},
        AGENT_CTX
      );
      expect(editMemory).toHaveBeenCalledWith(
        expect.objectContaining({ edit: { mode: 'append', content: 'more', separator: ' — ' } })
      );

      await memoryEditTool(
        { memory_id: 'memory-1', mode: 'append', content: 'more' },
        {},
        AGENT_CTX
      );
      // No separator key at all — the service owns the newline default.
      expect(editMemory).toHaveBeenLastCalledWith(
        expect.objectContaining({ edit: { mode: 'append', content: 'more' } })
      );
    });

    it('passes replace through, defaulting all to false', async () => {
      await memoryEditTool(
        { memory_id: 'memory-1', mode: 'replace', find: 'old', replace_with: 'new' },
        {},
        AGENT_CTX
      );

      expect(editMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          edit: { mode: 'replace', find: 'old', replaceWith: 'new', all: false },
        })
      );
    });

    it('honors all: true on replace', async () => {
      await memoryEditTool(
        { memory_id: 'memory-1', mode: 'replace', find: 'old', replace_with: 'new', all: true },
        {},
        AGENT_CTX
      );

      expect(editMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          edit: expect.objectContaining({ all: true }),
        })
      );
    });

    it('accepts an empty replace_with as a deletion', async () => {
      await memoryEditTool(
        { memory_id: 'memory-1', mode: 'replace', find: 'old', replace_with: '' },
        {},
        AGENT_CTX
      );

      expect(editMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          edit: expect.objectContaining({ replaceWith: '' }),
        })
      );
    });

    it('requires non-empty content for overwrite and append', async () => {
      await expect(
        memoryEditTool({ memory_id: 'memory-1', mode: 'overwrite', content: '   ' }, {}, AGENT_CTX)
      ).rejects.toThrow('overwrite mode requires non-empty `content`');

      await expect(
        memoryEditTool({ memory_id: 'memory-1', mode: 'append' }, {}, AGENT_CTX)
      ).rejects.toThrow('append mode requires non-empty `content`');

      expect(editMemory).not.toHaveBeenCalled();
    });
  });

  describe('errors and misses', () => {
    it('fails loudly when replace has no find', async () => {
      await expect(
        memoryEditTool(
          { memory_id: 'memory-1', mode: 'replace', replace_with: 'new' },
          {},
          AGENT_CTX
        )
      ).rejects.toThrow('replace mode requires a non-empty `find` string');
      expect(editMemory).not.toHaveBeenCalled();
    });

    it('fails loudly when replace has no replace_with', async () => {
      await expect(
        memoryEditTool({ memory_id: 'memory-1', mode: 'replace', find: 'old' }, {}, AGENT_CTX)
      ).rejects.toThrow('replace mode requires `replace_with`');
      expect(editMemory).not.toHaveBeenCalled();
    });

    it('fails loudly when the find string is absent from the memory', async () => {
      editMemory.mockResolvedValue({ status: 'find_absent' });

      await expect(
        memoryEditTool(
          { memory_id: 'memory-1', mode: 'replace', find: 'typo', replace_with: 'new' },
          {},
          AGENT_CTX
        )
      ).rejects.toThrow("replace failed: 'typo' does not appear in that memory's content");
    });

    it('refuses an edit that would blank the memory', async () => {
      editMemory.mockResolvedValue({ status: 'would_blank' });

      await expect(
        memoryEditTool(
          { memory_id: 'memory-1', mode: 'replace', find: 'everything', replace_with: '' },
          {},
          AGENT_CTX
        )
      ).rejects.toThrow('would leave the memory empty');
    });

    it('reports a miss plainly and points at op create instead of creating', async () => {
      editMemory.mockResolvedValue({ status: 'not_found' });

      const result = await memoryEditTool(
        { key: 'never-saved', mode: 'overwrite', content: 'new' },
        {},
        AGENT_CTX
      );

      expect(result).toContain('No matching memory');
      expect(result).toContain("key 'never-saved'");
      expect(result).toContain('op "create"');
    });

    it("reports another owner's memory as a plain miss (no cross-owner write)", async () => {
      // The service collapses cross-owner into not_found; the tool must not
      // dress that up as anything more informative.
      editMemory.mockResolvedValue({ status: 'not_found' });

      const result = await memoryEditTool(
        { memory_id: 'memory-owned-by-someone-else', mode: 'overwrite', content: 'mine now' },
        {},
        AGENT_CTX
      );

      expect(result).toContain('No matching memory');
      expect(result).toContain("id 'memory-owned-by-someone-else'");
      expect(result).not.toMatch(/permission|owner|denied/i);
    });
  });

  describe('owner resolution', () => {
    it('edits under the resolved member id for a user-actor call with no agent context', async () => {
      resolveCurrentActorMemberId.mockResolvedValue('member-42');

      await runWithActor({ actorKind: 'user', actorId: 'user-42' }, () =>
        memoryEditTool({ key: 'plan', mode: 'overwrite', content: 'user edit' }, {}, {})
      );

      expect(editMemory).toHaveBeenCalledWith(
        expect.objectContaining({ memberId: 'member-42', key: 'plan' })
      );
      expect(editMemory.mock.calls[0]![0]).not.toHaveProperty('agentId');
    });

    it('requires agent context when there is no actor at all', async () => {
      await expect(
        memoryEditTool({ key: 'plan', mode: 'overwrite', content: 'x' }, {}, {})
      ).rejects.toThrow('memory (update) requires agent context');
      expect(editMemory).not.toHaveBeenCalled();
    });
  });
});
