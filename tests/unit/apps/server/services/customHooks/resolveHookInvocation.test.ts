import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const query = jest.fn();
jest.mock('@snaglet/db', () => ({ getDb: () => ({ query }) }));

import { resolveHookInvocations } from '@server/services/customHooks/resolveHookInvocation';

describe('resolveHookInvocations', () => {
  beforeEach(() => query.mockReset());

  it('runs directly as schedule:fire when no ids are supplied', async () => {
    const [invocation] = await resolveHookInvocations('daily-report', {});
    expect(invocation?.eventName).toBe('schedule:fire');
    expect(invocation?.event).toEqual(
      expect.objectContaining({
        scheduleId: 'manual:daily-report',
        scheduledFor: expect.any(String),
      })
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves a message node into the real message:create wire shape', async () => {
    query.mockResolvedValueOnce({ rows: [{ type: 'message' }] }).mockResolvedValueOnce({
      rows: [
        {
          id: 'message-1',
          thread_id: 'thread-1',
          role: 'assistant',
          agent_id: 'agent-1',
          content: 'hello',
        },
      ],
    });
    const [invocation] = await resolveHookInvocations('tracker', { nodeIds: 'message-1' });
    expect(invocation).toEqual(
      expect.objectContaining({
        nodeId: 'message-1',
        eventName: 'message:create',
        event: {
          id: 'message-1',
          threadId: 'thread-1',
          role: 'agent',
          agentId: 'agent-1',
          text: 'hello',
          chars: 5,
        },
      })
    );
  });

  it('resolves a thread node into the full thread:create payload (creator, roster, models, prompts)', async () => {
    query
      // resolveId: nodes-type lookup
      .mockResolvedValueOnce({ rows: [{ type: 'thread' }] })
      // buildThreadCreateEvent: thread meta
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'thread-1',
            title: 'Release planning',
            dispatch_mode: 'mentioned',
            system_prompt: 'Be terse.',
          },
        ],
      })
      // buildThreadCreateEvent: participant roster (join order)
      .mockResolvedValueOnce({
        rows: [
          {
            kind: 'user',
            agent_id: null,
            user_id: 'user-1',
            provider_id: null,
            model_id: null,
            system_prompt_addendum: null,
          },
          {
            kind: 'agent',
            agent_id: 'clio',
            user_id: null,
            provider_id: 'anthropic',
            model_id: 'claude-haiku-4-5',
            system_prompt_addendum: 'Watch the board.',
          },
        ],
      });

    const [invocation] = await resolveHookInvocations('t', { nodeIds: 'thread-1' });
    expect(invocation).toEqual(
      expect.objectContaining({
        nodeId: 'thread-1',
        eventName: 'thread:create',
        context: { agentId: 'clio', threadId: 'thread-1' },
        event: {
          id: 'thread-1',
          title: 'Release planning',
          // No ambient actor in a unit test — the builder falls back to system.
          createdBy: { kind: 'system' },
          agentId: 'clio',
          participants: [
            { kind: 'user', id: 'user-1' },
            {
              kind: 'agent',
              id: 'clio',
              providerId: 'anthropic',
              modelId: 'claude-haiku-4-5',
              systemPromptAddendum: 'Watch the board.',
            },
          ],
          systemPrompt: 'Be terse.',
          dispatchMode: 'mentioned',
        },
      })
    );
  });

  it('resolves agent:create into the full configuration payload', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'clio',
          name: 'Clio',
          role: 'Ops lead',
          identity: 'Calm and precise.',
          system_prompt: 'You are Clio.',
          provider_id: 'anthropic',
          model_id: 'claude-haiku-4-5',
          tool_access_mode: 'all',
          tool_access_allow_list: ['workspace_search'],
          tool_access_deny_list: null,
          mcp_servers: ['github', 'snaglet-console'],
        },
      ],
    });

    const [invocation] = await resolveHookInvocations('t', {
      nodeIds: 'clio',
      eventName: 'agent:create',
    });
    expect(invocation).toEqual(
      expect.objectContaining({
        nodeId: 'clio',
        eventName: 'agent:create',
        context: { agentId: 'clio' },
        event: {
          id: 'clio',
          // No ambient actor in a unit test — the builder falls back to system.
          createdBy: { kind: 'system' },
          name: 'Clio',
          role: 'Ops lead',
          identity: 'Calm and precise.',
          providerId: 'anthropic',
          modelId: 'claude-haiku-4-5',
          systemPrompt: 'You are Clio.',
          toolAccess: { mode: 'all', allowList: ['workspace_search'], denyList: null },
          mcpServers: ['github', 'snaglet-console'],
        },
      })
    );
  });

  it('resolves lifecycle doc and archive events from canonical rows', async () => {
    query.mockResolvedValueOnce({ rows: [{ type: 'doc' }] }).mockResolvedValueOnce({
      rows: [
        {
          id: 'doc-1',
          type: 'doc',
          title: 'Plan',
          container_id: 'todo',
          parent_id: null,
          created_by: 'member-1',
          last_edited_by: 'member-2',
          archived: false,
          archived_at: null,
        },
      ],
    });
    const [created] = await resolveHookInvocations('t', {
      nodeIds: 'doc-1',
      eventName: 'doc:create',
    });
    expect(created?.event).toEqual({
      id: 'doc-1',
      title: 'Plan',
      parentContainerId: 'todo',
      createdBy: 'member-1',
    });

    query
      .mockResolvedValueOnce({ rows: [{ type: 'container' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'c-1',
            type: 'container',
            title: 'Project',
            archived: true,
            archived_at: '2026-08-01T00:00:00Z',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'c-1' }, { id: 'doc-1' }] });
    const [archived] = await resolveHookInvocations('t', {
      nodeIds: 'c-1',
      eventName: 'node:archive',
    });
    expect(archived?.event).toEqual({
      rootId: 'c-1',
      rootKind: 'container',
      cohortIds: ['c-1', 'doc-1'],
      count: 2,
      archivedBy: null,
    });
  });

  it('resolves thread:move as a move within the current project, aliases filled', async () => {
    query.mockResolvedValueOnce({ rows: [{ type: 'thread' }] }).mockResolvedValueOnce({
      rows: [
        {
          id: 'thread-1',
          type: 'thread',
          title: 'Standup',
          container_id: null,
          project_id: 'container-project',
          parent_id: null,
          created_by: null,
          last_edited_by: null,
          archived: false,
          archived_at: null,
        },
      ],
    });
    const [moved] = await resolveHookInvocations('t', {
      nodeIds: 'thread-1',
      eventName: 'thread:move',
    });
    expect(moved).toEqual(
      expect.objectContaining({
        eventName: 'thread:move',
        context: { threadId: 'thread-1' },
        event: {
          id: 'thread-1',
          fromProjectId: 'container-project',
          toProjectId: 'container-project',
          fromContainerId: 'container-project',
          toContainerId: 'container-project',
        },
      })
    );
    expect(String(query.mock.calls[1]?.[0])).toContain('n.project_id');
  });

  it('accepts an explicit event without inventing a sample record', async () => {
    const event = { id: 'provider-1' };
    const [invocation] = await resolveHookInvocations('provider-hook', {
      eventName: 'provider:update',
      event,
    });
    expect(invocation).toEqual({
      nodeId: null,
      eventName: 'provider:update',
      event,
      context: {},
    });
  });

  it('rejects mixing node ids with a hand-written event', async () => {
    await expect(
      resolveHookInvocations('bad', { nodeIds: ['message-1'], event: { id: 'other' } })
    ).rejects.toThrow(/nodeIds or event/i);
  });
});
