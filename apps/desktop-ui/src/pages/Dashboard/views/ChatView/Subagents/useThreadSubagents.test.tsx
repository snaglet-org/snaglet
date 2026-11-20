/**
 * useThreadSubagents / useHelperThread / useChatSubagents — the strip's and
 * the helper header's data (seeded over REST, then kept live by
 * `subagent:changed` frames on the parent thread's channel and the workspace
 * `thread.deleted` event) and ChatView's pane navigation for helpers.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUBAGENT_CHANGED_FRAME,
  type SubagentChangedPayload,
  type SubagentSummary,
  type WsMessage,
} from '@snaglet/shared/types';

const ws = vi.hoisted(() => ({
  handlers: new Set<(raw: WsMessage) => void>(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  connectionState: 'open',
}));

vi.mock('@desktop/ws/useWs', () => ({
  useWs: () => ({
    addMessageListener: (handler: (raw: WsMessage) => void) => {
      ws.handlers.add(handler);
      return () => {
        ws.handlers.delete(handler);
      };
    },
    subscribe: ws.subscribe,
    unsubscribe: ws.unsubscribe,
    connectionState: ws.connectionState,
  }),
}));

const api = vi.hoisted(() => {
  class FetchError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  }
  return { listSubagents: vi.fn(), get: vi.fn(), FetchError };
});

vi.mock('@desktop/utils/api', () => ({
  threadsApi: { listSubagents: api.listSubagents, get: api.get },
  FetchError: api.FetchError,
}));

import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { useChatSubagents } from './useChatSubagents';
import { useHelperThread } from './useHelperThread';
import { useThreadSubagents } from './useThreadSubagents';

const PARENT = 'thread-parent-1';

function helper(over: Partial<SubagentSummary> = {}): SubagentSummary {
  return {
    id: 'subagent-1',
    name: 'Scout',
    parentThreadId: PARENT,
    threadId: 'thread-helper-1',
    orchestratorAgentId: 'test-agent-a',
    orchestratorName: 'Agent A',
    agentId: 'test-agent-helper-1',
    providerId: 'provider-1',
    modelId: 'model-small',
    status: 'running',
    error: null,
    resumeAt: null,
    taskCount: 1,
    createdAt: '2026-10-12T11:58:00.000Z',
    lastTaskAt: '2026-10-12T11:58:00.000Z',
    finishedAt: null,
    ...over,
  };
}

function frame(payload: SubagentChangedPayload, channel = PARENT): void {
  act(() => {
    for (const handler of [...ws.handlers]) {
      handler({ type: SUBAGENT_CHANGED_FRAME, channel, payload });
    }
  });
}

beforeEach(() => {
  ws.handlers.clear();
  api.listSubagents.mockReset();
  api.get.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useThreadSubagents', () => {
  it('seeds from REST and subscribes the thread channel', async () => {
    api.listSubagents.mockResolvedValue([helper()]);
    const { result, unmount } = renderHook(() => useThreadSubagents(PARENT));

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(api.listSubagents).toHaveBeenCalledWith(PARENT);
    expect(ws.subscribe).toHaveBeenCalledWith(PARENT);
    expect(result.current.subagents.map((s) => s.name)).toEqual(['Scout']);

    unmount();
    expect(ws.unsubscribe).toHaveBeenCalledWith(PARENT);
  });

  it('follows subagent:changed — start, status change and removal', async () => {
    api.listSubagents.mockResolvedValue([]);
    const { result } = renderHook(() => useThreadSubagents(PARENT));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    frame({ parentThreadId: PARENT, subagent: helper() });
    expect(result.current.subagents.map((s) => s.status)).toEqual(['running']);

    frame({ parentThreadId: PARENT, subagent: helper({ status: 'finished' }) });
    expect(result.current.subagents.map((s) => s.status)).toEqual(['finished']);

    frame({ parentThreadId: PARENT, subagent: null, removedId: 'subagent-1' });
    expect(result.current.subagents).toEqual([]);
  });

  it("ignores another thread's frames", async () => {
    api.listSubagents.mockResolvedValue([]);
    const { result } = renderHook(() => useThreadSubagents(PARENT));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    frame({ parentThreadId: 'thread-other', subagent: helper() }, 'thread-other');
    expect(result.current.subagents).toEqual([]);
  });

  it('drops a helper when the workspace reports its thread deleted', async () => {
    api.listSubagents.mockResolvedValue([helper()]);
    const { result } = renderHook(() => useThreadSubagents(PARENT));
    await waitFor(() => expect(result.current.subagents).toHaveLength(1));

    act(() => emitLibraryEvent({ type: 'deleted', kind: 'thread', id: 'thread-helper-1' }));
    expect(result.current.subagents).toEqual([]);
  });

  it('stays inert for an empty thread id', () => {
    const { result } = renderHook(() => useThreadSubagents(''));
    expect(result.current).toEqual({ subagents: [], loaded: false });
    expect(api.listSubagents).not.toHaveBeenCalled();
    expect(ws.subscribe).not.toHaveBeenCalled();
  });
});

describe('useHelperThread', () => {
  it('is null for an ordinary thread', async () => {
    api.get.mockResolvedValue({ id: PARENT, parentThreadId: null });
    api.listSubagents.mockResolvedValue([]);
    const { result } = renderHook(() => useHelperThread(PARENT));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(PARENT));
    expect(result.current).toBeNull();
  });

  it("names a helper thread from its parent's list and reports its removal", async () => {
    api.get.mockResolvedValue({ id: 'thread-helper-1', parentThreadId: PARENT });
    api.listSubagents.mockResolvedValue([helper()]);
    const { result } = renderHook(() => useHelperThread('thread-helper-1'));

    await waitFor(() => expect(result.current?.subagent?.name).toBe('Scout'));
    expect(result.current).toMatchObject({ parentThreadId: PARENT, removed: false });
    // The removal frame arrives on the parent's channel.
    expect(ws.subscribe).toHaveBeenCalledWith(PARENT);

    frame({ parentThreadId: PARENT, subagent: null, removedId: 'subagent-1' });
    expect(result.current).toMatchObject({ subagent: null, removed: true });
  });

  it('reports removal from the workspace thread.deleted event too', async () => {
    api.get.mockResolvedValue({ id: 'thread-helper-1', parentThreadId: PARENT });
    api.listSubagents.mockResolvedValue([helper()]);
    const { result } = renderHook(() => useHelperThread('thread-helper-1'));
    await waitFor(() => expect(result.current?.subagent).not.toBeNull());

    act(() => emitLibraryEvent({ type: 'deleted', kind: 'thread', id: 'thread-helper-1' }));
    expect(result.current?.removed).toBe(true);
  });

  it('reports a marked pane whose thread is gone as a removed helper (restored after a reload)', async () => {
    api.get.mockRejectedValue(new api.FetchError('Thread not found', 404));
    api.listSubagents.mockResolvedValue([]);
    const { result } = renderHook(() => useHelperThread('thread-helper-1', PARENT));

    await waitFor(() => expect(result.current?.removed).toBe(true));
    expect(result.current).toMatchObject({ parentThreadId: PARENT, subagent: null });
  });

  it('leaves an unmarked missing thread to the ordinary not-found path', async () => {
    api.get.mockRejectedValue(new api.FetchError('Thread not found', 404));
    const { result } = renderHook(() => useHelperThread('thread-gone-1'));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('thread-gone-1'));
    await act(async () => {});
    expect(result.current).toBeNull();
    expect(api.listSubagents).not.toHaveBeenCalled();
  });
});

describe('useChatSubagents — pane navigation', () => {
  it("opens a helper's thread in the same pane as a titled thread selection", async () => {
    api.get.mockResolvedValue({ id: PARENT, parentThreadId: null });
    api.listSubagents.mockResolvedValue([helper()]);
    const onReplaceSelection = vi.fn();
    const { result } = renderHook(() =>
      useChatSubagents(PARENT, 'Parent thread', onReplaceSelection)
    );
    await waitFor(() =>
      expect(result.current.navigation.liveThreadIds.has('thread-helper-1')).toBe(true)
    );
    expect(result.current.helper).toBeNull();
    expect(result.current.openParentThread).toBeUndefined();

    act(() => result.current.openHelperThread?.('thread-helper-1', 'Agent A › Scout'));

    expect(onReplaceSelection).toHaveBeenCalledWith({
      kind: 'thread',
      thread_id: 'thread-helper-1',
      node: expect.objectContaining({ id: 'thread-helper-1', title: 'Agent A › Scout' }),
      helperParentThreadId: PARENT,
    });
  });

  it('links a helper thread back to its parent', async () => {
    api.get.mockResolvedValue({ id: 'thread-helper-1', parentThreadId: PARENT });
    api.listSubagents.mockImplementation(async (id: string) => (id === PARENT ? [helper()] : []));
    const onReplaceSelection = vi.fn();
    const { result } = renderHook(() =>
      useChatSubagents('thread-helper-1', 'Agent A › Scout', onReplaceSelection)
    );
    await waitFor(() => expect(result.current.helper?.subagent?.name).toBe('Scout'));

    act(() => result.current.openParentThread?.());

    expect(onReplaceSelection).toHaveBeenCalledWith({ kind: 'thread', thread_id: PARENT });
  });

  it('titles a helper pane restored id-only after a reload, without a history step', async () => {
    api.get.mockResolvedValue({
      id: 'thread-helper-1',
      parentThreadId: PARENT,
      title: 'Agent A › Scout',
    });
    api.listSubagents.mockImplementation(async (id: string) => (id === PARENT ? [helper()] : []));
    const onReplaceSelection = vi.fn();
    renderHook(() => useChatSubagents('thread-helper-1', null, onReplaceSelection));

    await waitFor(() =>
      expect(onReplaceSelection).toHaveBeenCalledWith({
        kind: 'thread',
        thread_id: 'thread-helper-1',
        node: expect.objectContaining({ id: 'thread-helper-1', title: 'Agent A › Scout' }),
        helperParentThreadId: PARENT,
      })
    );
  });

  it('marks a helper pane opened some other way (a notification) so a reload knows it', async () => {
    api.get.mockResolvedValue({ id: 'thread-helper-1', parentThreadId: PARENT, title: null });
    api.listSubagents.mockImplementation(async (id: string) => (id === PARENT ? [helper()] : []));
    const onReplaceSelection = vi.fn();
    renderHook(() => useChatSubagents('thread-helper-1', 'Agent A › Scout', onReplaceSelection));

    await waitFor(() =>
      expect(onReplaceSelection).toHaveBeenCalledWith(
        expect.objectContaining({ thread_id: 'thread-helper-1', helperParentThreadId: PARENT })
      )
    );
  });

  it('leaves an already marked and titled helper pane alone', async () => {
    api.get.mockResolvedValue({ id: 'thread-helper-1', parentThreadId: PARENT, title: null });
    api.listSubagents.mockImplementation(async (id: string) => (id === PARENT ? [helper()] : []));
    const onReplaceSelection = vi.fn();
    const { result } = renderHook(() =>
      useChatSubagents('thread-helper-1', 'Agent A › Scout', onReplaceSelection, PARENT)
    );

    await waitFor(() => expect(result.current.helper?.subagent?.name).toBe('Scout'));
    expect(onReplaceSelection).not.toHaveBeenCalled();
  });

  it('cannot navigate without the pane (previews)', async () => {
    api.get.mockResolvedValue({ id: PARENT, parentThreadId: null });
    api.listSubagents.mockResolvedValue([helper()]);
    const { result } = renderHook(() => useChatSubagents(PARENT, null, undefined));
    await waitFor(() => expect(result.current.subagents).toHaveLength(1));
    expect(result.current.openHelperThread).toBeNull();
    expect(result.current.navigation.openHelperThread).toBeNull();
  });
});
