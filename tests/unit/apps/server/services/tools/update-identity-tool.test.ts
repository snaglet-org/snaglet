/**
 * update_identity — self-only guard scope.
 *
 * The guard ("may only update the current agent") fires only when both
 * ctx.agentId and input.agent_id are set. With no agent context (the panel's
 * POST /api/tools/execute without act_as_agent_id), an explicit
 * input.agent_id can target any agent. The last test pins that on purpose: a
 * person editing any agent's identity from the panel is a deliberate admin
 * capability, attributed to them by the actor-context middleware. Gating it
 * server-side should flip that test rather than drift silently.
 */
import { beforeEach, describe, expect, it } from '@jest/globals';

const mockFindById = jest.fn();
const mockUpdate = jest.fn();

jest.mock('@snaglet/db', () => ({
  Agents: {
    findById: (...args: unknown[]) => mockFindById(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

jest.mock('@server/services/ConfigResolverService', () => ({
  invalidateAll: jest.fn(),
}));

const mockEmitWorkspaceEvent = jest.fn();
jest.mock('@server/realtime/emit', () => ({
  emitWorkspaceEvent: (...args: unknown[]) => mockEmitWorkspaceEvent(...args),
}));

import updateIdentityTool from '@server/services/ToolService/handlers/agents/updateIdentity';

describe('update_identity self-only guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindById.mockResolvedValue({ id: 'agent-2', name: 'Beta' });
    // The written row, read back.
    mockUpdate.mockImplementation(async (...args: unknown[]) => ({
      id: args[0],
      name: 'Beta',
      ...(args[1] as object),
      updatedAt: 'rev-2',
    }));
  });

  it('blocks cross-agent edits when agent context is present (agent-loop path)', async () => {
    await expect(
      updateIdentityTool({ agent_id: 'agent-2', identity: 'hijacked' }, {}, { agentId: 'agent-1' })
    ).rejects.toThrow('update_identity may only update the current agent');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('updates the context agent when no explicit agent_id is given', async () => {
    mockFindById.mockResolvedValue({ id: 'agent-1', name: 'Alpha' });

    const result = await updateIdentityTool({ identity: 'new self' }, {}, { agentId: 'agent-1' });

    expect(mockUpdate).toHaveBeenCalledWith('agent-1', { identity: 'new self' });
    expect(result).toContain('agent-1');
  });

  it('without agent context, an explicit agent_id may edit any agent (documented user-mode panel path)', async () => {
    // context === undefined is what /api/tools/execute passes when the panel
    // runs a tool without act_as_agent_id. The self-only guard needs a
    // contextAgentId to compare against, so it cannot fire here.
    const result = await updateIdentityTool(
      { agent_id: 'agent-2', identity: 'user-authored identity' },
      {},
      undefined
    );

    expect(mockUpdate).toHaveBeenCalledWith('agent-2', { identity: 'user-authored identity' });
    expect(result).toContain('agent-2');
  });
});

describe('update_identity realtime invalidation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindById.mockResolvedValue({
      id: 'agent-1',
      name: 'Alpha',
      role: 'Reviewer',
      identity: 'same identity',
      systemPrompt: null,
    });
  });

  it('announces agent.updated for the fields whose value changed, with the written revision', async () => {
    // The row read back after the write: its updated_at moved. An open pane
    // compares this revision with the one it holds, so the event must carry
    // the new one, not the revision of the row read before the write.
    mockUpdate.mockResolvedValue({
      id: 'agent-1',
      name: 'Alpha',
      role: 'Planner',
      identity: 'same identity',
      systemPrompt: null,
      updatedAt: '2026-11-16T10:00:00.000001+00:00',
    });

    await updateIdentityTool(
      { role: 'Planner', identity: 'same identity' },
      {},
      { agentId: 'agent-1' }
    );

    // Role goes through the same single write as identity and system prompt.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith('agent-1', {
      role: 'Planner',
      identity: 'same identity',
    });
    expect(mockEmitWorkspaceEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitWorkspaceEvent).toHaveBeenCalledWith({
      type: 'agent.updated',
      agentId: 'agent-1',
      changed: ['role'],
      updatedAt: '2026-11-16T10:00:00.000001+00:00',
    });
  });

  it('stays quiet when nothing changed', async () => {
    mockUpdate.mockResolvedValue({
      id: 'agent-1',
      name: 'Alpha',
      role: 'Reviewer',
      identity: 'same identity',
      systemPrompt: null,
      updatedAt: '2026-11-16T10:00:00.000001+00:00',
    });
    await updateIdentityTool({ role: 'Reviewer' }, {}, { agentId: 'agent-1' });
    expect(mockEmitWorkspaceEvent).not.toHaveBeenCalled();
  });

  it('fails, announcing nothing, when the agent was deleted under the write', async () => {
    mockUpdate.mockResolvedValue(null);
    await expect(
      updateIdentityTool({ role: 'Planner' }, {}, { agentId: 'agent-1' })
    ).rejects.toThrow('agent not found: agent-1');
    expect(mockEmitWorkspaceEvent).not.toHaveBeenCalled();
  });
});
