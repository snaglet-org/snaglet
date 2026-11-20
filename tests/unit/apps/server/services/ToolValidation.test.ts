import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const resolveCurrentActorMemberId = jest.fn();

jest.mock('@server/realtime/actorMember.js', () => ({
  resolveCurrentActorMemberId: (...args: unknown[]) => resolveCurrentActorMemberId(...args),
}));

import { requireAgentId, resolveMemoryOwner } from '@server/services/ToolService/ToolValidation';
import { runWithActor } from '@server/realtime/actorContext';

describe('requireAgentId', () => {
  it('returns the agent id from context', () => {
    expect(requireAgentId({ agentId: 'agent-1' }, 'memory_store')).toBe('agent-1');
  });

  it('throws when context is missing', () => {
    expect(() => requireAgentId(undefined, 'memory_store')).toThrow(
      'memory_store requires agent context'
    );
  });

  it('throws when agent id is missing from context', () => {
    expect(() => requireAgentId({}, 'memory_store')).toThrow('memory_store requires agent context');
  });
});

describe('resolveMemoryOwner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves the agent owner from context.agentId — the unchanged agent-run path', async () => {
    const owner = await resolveMemoryOwner({ agentId: 'agent-1' }, 'memory_store');
    expect(owner).toEqual({ agentId: 'agent-1' });
    // The ambient-actor seam is never even consulted when ctx.agentId is set.
    expect(resolveCurrentActorMemberId).not.toHaveBeenCalled();
  });

  it('context.agentId takes priority over an ambient user actor', async () => {
    resolveCurrentActorMemberId.mockResolvedValue('member-other');
    const owner = await runWithActor({ actorKind: 'user', actorId: 'user-1' }, () =>
      resolveMemoryOwner({ agentId: 'agent-1' }, 'memory_store')
    );
    expect(owner).toEqual({ agentId: 'agent-1' });
  });

  it('falls back to the ambient user actor, resolved to a member id, when there is no agent context', async () => {
    resolveCurrentActorMemberId.mockResolvedValue('member-42');
    const owner = await runWithActor({ actorKind: 'user', actorId: 'user-42' }, () =>
      resolveMemoryOwner(undefined, 'memory_recall')
    );
    expect(owner).toEqual({ memberId: 'member-42' });
    expect(resolveCurrentActorMemberId).toHaveBeenCalledTimes(1);
  });

  it('throws the standard error when no actor is bound at all', async () => {
    await expect(resolveMemoryOwner(undefined, 'memory_store')).rejects.toThrow(
      'memory_store requires agent context'
    );
    expect(resolveCurrentActorMemberId).not.toHaveBeenCalled();
  });

  it('throws the standard error for a non-user, non-agent-context actor (e.g. external)', async () => {
    await expect(
      runWithActor({ actorKind: 'external', actorId: 'ext-1' }, () =>
        resolveMemoryOwner(undefined, 'memory_save')
      )
    ).rejects.toThrow('memory_save requires agent context');
    expect(resolveCurrentActorMemberId).not.toHaveBeenCalled();
  });

  it('throws the standard error when a user actor has no resolvable member row', async () => {
    resolveCurrentActorMemberId.mockResolvedValue(null);
    await expect(
      runWithActor({ actorKind: 'user', actorId: 'user-orphan' }, () =>
        resolveMemoryOwner(undefined, 'memory_forget')
      )
    ).rejects.toThrow('memory_forget requires agent context');
  });
});
