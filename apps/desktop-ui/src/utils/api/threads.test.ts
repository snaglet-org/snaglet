import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { parseThreadDispatchMode, threadsApi } from './threads';

afterEach(() => vi.unstubAllGlobals());

describe('parseThreadDispatchMode', () => {
  it.each(['all', 'mentioned'] as const)('recognizes the runtime %s value', (mode) => {
    expect(parseThreadDispatchMode({ dispatchMode: mode })).toEqual({
      status: 'supported',
      mode,
    });
  });

  it('accepts the legacy snake-case field', () => {
    expect(parseThreadDispatchMode({ dispatch_mode: 'mentioned' })).toEqual({
      status: 'supported',
      mode: 'mentioned',
    });
  });

  it('keeps an omitted legacy value distinct from an explicit unknown value', () => {
    expect(parseThreadDispatchMode({})).toEqual({ status: 'missing' });
    expect(parseThreadDispatchMode({ dispatchMode: 'future-fanout' })).toEqual({
      status: 'unsupported',
    });
  });
});

describe('threadsApi.getDispatchModeState', () => {
  it('preserves an explicit unknown runtime value as unsupported', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: { id: 'thread-1', dispatchMode: 'future-fanout' },
        }),
      })
    );

    await expect(threadsApi.getDispatchModeState('thread-1')).resolves.toBe('unsupported');
  });

  it('retains the canonical all-mode default when the field is omitted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { id: 'thread-1' } }),
      })
    );

    await expect(threadsApi.getDispatchModeState('thread-1')).resolves.toBe('all');
  });
});

describe('threadsApi.getMessage — external-sender fields survive REST hydration', () => {
  it('carries externalSenderLabel (from-param provenance) through to the normalized message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'message-1',
            threadId: 'thread-1',
            role: 'user',
            agentId: null,
            content: 'hello from the orchestrator',
            createdAt: '2026-07-17T00:00:00.000Z',
            externalSenderLabel: 'vega',
          },
        }),
      })
    );

    const message = await threadsApi.getMessage('message-1');
    expect(message.externalSenderLabel).toBe('vega');
  });

  it('carries the older connection-level externalSender through on this REST path too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'message-2',
            threadId: 'thread-1',
            role: 'user',
            agentId: null,
            content: 'hi',
            createdAt: '2026-07-17T00:00:00.000Z',
            externalSender: { memberId: 'member-1', name: 'Some MCP Caller' },
          },
        }),
      })
    );

    const message = await threadsApi.getMessage('message-2');
    expect(message.externalSender).toEqual({ memberId: 'member-1', name: 'Some MCP Caller' });
  });

  it('both fields default to null when absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id: 'message-3',
            threadId: 'thread-1',
            role: 'user',
            agentId: null,
            content: 'plain',
            createdAt: '2026-07-17T00:00:00.000Z',
          },
        }),
      })
    );

    const message = await threadsApi.getMessage('message-3');
    expect(message.externalSender).toBeNull();
    expect(message.externalSenderLabel).toBeNull();
  });
});

describe('threadsApi.get — project scope', () => {
  it('reads the camelCase projectId the server emits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: { id: 'thread-1', projectId: 'container-1111111111111-aaaaaaaaa' },
        }),
      })
    );
    await expect(threadsApi.get('thread-1')).resolves.toMatchObject({
      projectId: 'container-1111111111111-aaaaaaaaa',
    });
  });

  it('accepts the snake_case key and defaults a missing scope to null (flat thread)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: { id: 'thread-1', project_id: 'container-2222222222222-bbbbbbbbb' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { id: 'thread-1' } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    await expect(threadsApi.get('thread-1')).resolves.toMatchObject({
      projectId: 'container-2222222222222-bbbbbbbbb',
    });
    await expect(threadsApi.get('thread-1')).resolves.toMatchObject({ projectId: null });
  });
});

describe('threadsApi.get — thread kind', () => {
  it('carries a DM thread’s kind, and leaves it unset when the server omits it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { id: 'thread-dm-1', kind: 'dm' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { id: 'thread-1', kind: 'chat' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { id: 'thread-2' } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    await expect(threadsApi.get('thread-dm-1')).resolves.toMatchObject({ kind: 'dm' });
    await expect(threadsApi.get('thread-1')).resolves.toMatchObject({ kind: 'chat' });
    expect((await threadsApi.get('thread-2')).kind).toBeUndefined();
  });
});

describe('threadsApi.createInProjectWithAgents', () => {
  const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
  const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';

  function ok(data: unknown) {
    return { ok: true, json: async () => ({ success: true, data }) };
  }

  it('rejects before any request when no agent is given', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(threadsApi.createInProjectWithAgents('Title', PROJECT_ID, [])).rejects.toThrow(
      /at least one agent/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the first agent with the project scope and adds the rest as participants', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ id: THREAD_ID, projectId: PROJECT_ID }))
      .mockResolvedValueOnce(ok({ id: 'tp-1', threadId: THREAD_ID, agentId: 'test-agent-b' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await threadsApi.createInProjectWithAgents('Title', PROJECT_ID, [
      'test-agent-a',
      'test-agent-b',
    ]);

    expect(result.thread).toMatchObject({ id: THREAD_ID, projectId: PROJECT_ID });
    expect(result.failedAgentIds).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      title: 'Title',
      project_id: PROJECT_ID,
      agentId: 'test-agent-a',
    });
    expect(fetchMock.mock.calls[1][0]).toContain(`/threads/${THREAD_ID}/participants`);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ agentId: 'test-agent-b' });
  });

  it('sends project_id: null for a flat thread', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ id: THREAD_ID, projectId: null }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await threadsApi.createInProjectWithAgents('Title', null, ['test-agent-a']);
    expect(result.thread.projectId).toBeNull();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      title: 'Title',
      project_id: null,
      agentId: 'test-agent-a',
    });
  });

  it('keeps the created thread and reports the agents that could not be added', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ id: THREAD_ID, projectId: PROJECT_ID }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false, error: 'Agent not found' }),
      })
      .mockResolvedValueOnce(ok({ id: 'tp-3', threadId: THREAD_ID, agentId: 'test-agent-c' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await threadsApi.createInProjectWithAgents('Title', PROJECT_ID, [
      'test-agent-a',
      'test-agent-b',
      'test-agent-c',
    ]);

    expect(result.thread.id).toBe(THREAD_ID);
    expect(result.failedAgentIds).toEqual(['test-agent-b']);
    // The failure of one participant does not stop the remaining adds.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects when the create itself fails (nothing to keep)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: false, error: 'Project not found' }),
      })
    );
    await expect(
      threadsApi.createInProjectWithAgents('Title', PROJECT_ID, ['test-agent-a'])
    ).rejects.toThrow('Project not found');
  });
});

describe('threadsApi.setPlacement', () => {
  const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
  const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';

  function ok(data: unknown) {
    return { ok: true, json: async () => ({ success: true, data }) };
  }

  it('sends only the placement keys it was given, in the server’s snake_case', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(ok({ id: THREAD_ID, projectId: PROJECT_ID, sortOrder: 2 }));
    vi.stubGlobal('fetch', fetchMock);

    await threadsApi.setPlacement(THREAD_ID, { sortOrder: 2 });
    await threadsApi.setPlacement(THREAD_ID, { projectId: PROJECT_ID, sortOrder: 0 });
    await threadsApi.setPlacement(THREAD_ID, { projectId: null });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/threads/${THREAD_ID}`,
      `/api/threads/${THREAD_ID}`,
      `/api/threads/${THREAD_ID}`,
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual([
      'PATCH',
      'PATCH',
      'PATCH',
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { sort_order: 2 },
      { project_id: PROJECT_ID, sort_order: 0 },
      { project_id: null },
    ]);
  });
});

describe('threadsApi — subagent helpers', () => {
  function stubData(data: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data }) })
    );
  }

  it('reads a subagent result row from its metadata on the history path', async () => {
    stubData({
      id: 'message-result-1',
      threadId: 'thread-parent-1',
      role: 'user',
      agentId: null,
      content: '[subagent Scout stopped]\n(no reply)\n(… op:send …)',
      createdAt: '2026-10-12T12:00:00.000Z',
      messageType: 'thread_event',
      visibleToAgentId: 'test-agent-a',
      metadata: {
        event_kind: 'subagent_finished',
        subagent_id: 'subagent-1',
        subagent_name: 'Scout',
        subagent_thread_id: 'thread-helper-1',
        orchestrator_agent_id: 'test-agent-a',
        orchestrator_name: 'Agent A',
        subagent_status: 'stopped',
      },
    });

    const message = await threadsApi.getMessage('message-result-1');
    expect(message.subagentResult).toEqual({
      subagentId: 'subagent-1',
      name: 'Scout',
      threadId: 'thread-helper-1',
      orchestratorAgentId: 'test-agent-a',
      orchestratorName: 'Agent A',
      status: 'stopped',
    });
  });

  it('gives other rows no subagent result', async () => {
    stubData({
      id: 'message-1',
      threadId: 'thread-1',
      role: 'user',
      content: '[participant added: Agent B]',
      messageType: 'thread_event',
      metadata: { event_kind: 'participant_added' },
    });
    expect((await threadsApi.getMessage('message-1')).subagentResult).toBeNull();
  });

  it("surfaces a helper thread's parent thread id", async () => {
    stubData({ id: 'thread-helper-1', parentThreadId: 'thread-parent-1' });
    expect((await threadsApi.get('thread-helper-1')).parentThreadId).toBe('thread-parent-1');
    stubData({ id: 'thread-parent-1' });
    expect((await threadsApi.get('thread-parent-1')).parentThreadId).toBeNull();
  });

  it('lists a thread’s live subagents', async () => {
    stubData({ subagents: [{ id: 'subagent-1', name: 'Scout' }] });
    await expect(threadsApi.listSubagents('thread-parent-1')).resolves.toEqual([
      { id: 'subagent-1', name: 'Scout' },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/threads/thread-parent-1/subagents'),
      expect.anything()
    );
  });
});
