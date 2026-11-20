/**
 * useThreadHistory: pagination cursors. The cursor for an older/newer page is
 * read out of the loaded window and has to be readable at call time from
 * anywhere, including an effect (the trim panel's seek), where React does not
 * evaluate a `setMessages` updater eagerly.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  getMessages: vi.fn(),
  getActivityLog: vi.fn(),
  listParticipants: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({ threadsApi: api }));

import { useThreadHistory } from './useThreadHistory';

const msg = (i: number) => ({
  id: `m${i}`,
  threadId: 't1',
  role: 'user' as const,
  agentId: null,
  content: `message ${i}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
});

const page = (from: number, to: number, over: Record<string, unknown> = {}) => ({
  messages: Array.from({ length: to - from }, (_, k) => msg(from + k)),
  hasMoreOlder: false,
  hasMoreNewer: false,
  ...over,
});

beforeEach(() => {
  api.getMessages.mockReset();
  api.getActivityLog.mockReset().mockResolvedValue([]);
  api.listParticipants.mockReset().mockResolvedValue([]);
});

describe('useThreadHistory — paging cursors', () => {
  it('pages older from the OLDEST loaded id, and again from the new oldest', async () => {
    api.getMessages.mockResolvedValueOnce(page(100, 110, { hasMoreOlder: true }));
    const { result } = renderHook(() => useThreadHistory('t1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(10));

    api.getMessages.mockResolvedValueOnce(page(90, 100, { hasMoreOlder: true }));
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(api.getMessages).toHaveBeenLastCalledWith('t1', { before: 'm100', limit: 50 });
    await waitFor(() => expect(result.current.messages).toHaveLength(20));

    // The window grew at the top, so the next page must start from that edge;
    // a stale cursor would re-fetch the page already loaded.
    api.getMessages.mockResolvedValueOnce(page(80, 90));
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(api.getMessages).toHaveBeenLastCalledWith('t1', { before: 'm90', limit: 50 });
    await waitFor(() => expect(result.current.messages).toHaveLength(30));
  });

  it('pages newer from the NEWEST loaded id', async () => {
    api.getMessages.mockResolvedValueOnce(page(100, 110, { hasMoreNewer: true }));
    const { result } = renderHook(() => useThreadHistory('t1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(10));

    api.getMessages.mockResolvedValueOnce(page(110, 115));
    await act(async () => {
      await result.current.loadNewer();
    });
    expect(api.getMessages).toHaveBeenLastCalledWith('t1', { after: 'm109', limit: 50 });
    await waitFor(() => expect(result.current.messages).toHaveLength(15));
  });

  it('pages from an effect, not only from an event handler', async () => {
    // The regression this file exists for: the seek that pages toward an
    // unloaded trim boundary fires from a useEffect.
    api.getMessages.mockResolvedValueOnce(page(100, 110, { hasMoreOlder: true }));
    const { result } = renderHook(() => useThreadHistory('t1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(10));

    api.getMessages.mockResolvedValueOnce(page(90, 100));
    const { loadOlder } = result.current;
    await act(async () => {
      // Queue an unrelated update first: with a non-empty update queue React
      // does not evaluate a setState updater eagerly.
      result.current.setMessages((prev) => [...prev]);
      await loadOlder();
    });
    expect(api.getMessages).toHaveBeenLastCalledWith('t1', { before: 'm100', limit: 50 });
    await waitFor(() => expect(result.current.messages).toHaveLength(20));
  });

  it('does not fetch before the first page has landed', async () => {
    api.getMessages.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useThreadHistory('t1'));
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(api.getMessages).toHaveBeenCalledTimes(1); // the initial fetch only
  });
});

describe('useThreadHistory — exact-message seek (focusRequestId)', () => {
  const aroundCall = (id: string) => ['t1', { limit: 50, around: id }];

  it('opens centered on the focus message when the thread mounts with a request', async () => {
    api.getMessages.mockResolvedValueOnce({ ...page(100, 110), anchorId: 'm105' });
    const { result } = renderHook(() =>
      useThreadHistory('t1', { focusMessageId: 'm105', focusRequestId: 1 })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(api.getMessages).toHaveBeenCalledTimes(1);
    expect(api.getMessages).toHaveBeenLastCalledWith(...aroundCall('m105'));
    expect(result.current.initialFocusMessageId).toBe('m105');
  });

  it('a new request on the already-open thread seeks again to a different message', async () => {
    api.getMessages.mockResolvedValueOnce({ ...page(100, 110), anchorId: 'm105' });
    const { result, rerender } = renderHook(
      (props: { focusMessageId: string; focusRequestId: number }) => useThreadHistory('t1', props),
      { initialProps: { focusMessageId: 'm105', focusRequestId: 1 } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    api.getMessages.mockResolvedValueOnce({ ...page(20, 30), anchorId: 'm25' });
    rerender({ focusMessageId: 'm25', focusRequestId: 2 });

    await waitFor(() => expect(result.current.initialFocusMessageId).toBe('m25'));
    expect(api.getMessages).toHaveBeenCalledTimes(2);
    expect(api.getMessages).toHaveBeenLastCalledWith(...aroundCall('m25'));
    expect(result.current.messages.map((m) => m.id)).toEqual(
      page(20, 30).messages.map((m) => m.id)
    );
  });

  it('re-seeks the SAME message when a fresh request id arrives', async () => {
    api.getMessages.mockResolvedValue({ ...page(100, 110), anchorId: 'm105' });
    const { result, rerender } = renderHook(
      (props: { focusMessageId: string; focusRequestId: number }) => useThreadHistory('t1', props),
      { initialProps: { focusMessageId: 'm105', focusRequestId: 1 } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.getMessages).toHaveBeenCalledTimes(1);

    rerender({ focusMessageId: 'm105', focusRequestId: 2 });

    await waitFor(() => expect(api.getMessages).toHaveBeenCalledTimes(2));
    expect(api.getMessages).toHaveBeenLastCalledWith(...aroundCall('m105'));
    await waitFor(() => expect(result.current.initialFocusMessageId).toBe('m105'));
  });

  it('ordinary rerenders with the same request do not refetch or reset', async () => {
    api.getMessages.mockResolvedValueOnce({ ...page(100, 110), anchorId: 'm105' });
    const { result, rerender } = renderHook(
      (props: { focusMessageId: string; focusRequestId: number }) => useThreadHistory('t1', props),
      { initialProps: { focusMessageId: 'm105', focusRequestId: 1 } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ focusMessageId: 'm105', focusRequestId: 1 });
    rerender({ focusMessageId: 'm105', focusRequestId: 1 });

    expect(api.getMessages).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toHaveLength(10);
  });

  it('a stale message falls back to the latest page once, without looping', async () => {
    api.getMessages.mockResolvedValueOnce(page(100, 110));
    const { result, rerender } = renderHook(
      (props: { focusMessageId: string | null; focusRequestId: number | null }) =>
        useThreadHistory('t1', props),
      {
        initialProps: {
          focusMessageId: null as string | null,
          focusRequestId: null as number | null,
        },
      }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    api.getMessages.mockRejectedValueOnce(new Error('404 message not found'));
    api.getMessages.mockResolvedValueOnce(page(100, 110));
    rerender({ focusMessageId: 'm-deleted', focusRequestId: 7 });

    await waitFor(() => expect(api.getMessages).toHaveBeenCalledTimes(3));
    expect(api.getMessages.mock.calls[1]).toEqual(aroundCall('m-deleted'));
    expect(api.getMessages.mock.calls[2]).toEqual(['t1', { limit: 50 }]);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.initialFocusMessageId).toBeNull();
    expect(result.current.messages).toHaveLength(10);
    // Nothing else fires afterward.
    await new Promise((r) => setTimeout(r, 20));
    expect(api.getMessages).toHaveBeenCalledTimes(3);
  });
});

describe('useThreadHistory — anchor and request id travel together', () => {
  it('clears both while a re-seek is loading and publishes them in one update', async () => {
    api.getMessages.mockResolvedValueOnce({ ...page(100, 110), anchorId: 'm105' });
    const { result, rerender } = renderHook(
      (props: { focusMessageId: string; focusRequestId: number }) => useThreadHistory('t1', props),
      { initialProps: { focusMessageId: 'm105', focusRequestId: 1 } }
    );
    await waitFor(() => expect(result.current.initialFocusMessageId).toBe('m105'));
    expect(result.current.initialFocusRequestId).toBe(1);

    let resolveSecond: (value: unknown) => void = () => {};
    api.getMessages.mockReturnValueOnce(new Promise((r) => (resolveSecond = r)));
    rerender({ focusMessageId: 'm105', focusRequestId: 2 });

    // In flight: the list must not see request 2 next to the previous anchor.
    await waitFor(() => expect(api.getMessages).toHaveBeenCalledTimes(2));
    expect(result.current.initialFocusMessageId).toBeNull();
    expect(result.current.initialFocusRequestId).toBeNull();
    expect(result.current.messages).toHaveLength(0);

    await act(async () => {
      resolveSecond({ ...page(100, 110), anchorId: 'm105' });
    });

    await waitFor(() => expect(result.current.initialFocusMessageId).toBe('m105'));
    expect(result.current.initialFocusRequestId).toBe(2);
  });

  it('marks a navigation anchor as one, and a trim reload anchor as not', async () => {
    api.getMessages.mockResolvedValueOnce({ ...page(100, 110), anchorId: 'm105' });
    const { result, rerender } = renderHook(
      (props: { focusMessageId: string; focusRequestId: number }) => useThreadHistory('t1', props),
      { initialProps: { focusMessageId: 'm105', focusRequestId: 1 } }
    );
    await waitFor(() => expect(result.current.initialFocusMessageId).toBe('m105'));
    expect(result.current.initialFocusIsNavigation).toBe(true);

    api.getMessages.mockResolvedValueOnce({ ...page(100, 110), anchorId: 'm107' });
    act(() => result.current.reload('m107'));
    await waitFor(() => expect(result.current.initialFocusMessageId).toBe('m107'));
    expect(result.current.initialFocusIsNavigation).toBe(false);

    api.getMessages.mockResolvedValueOnce({ ...page(100, 110), anchorId: 'm103' });
    rerender({ focusMessageId: 'm103', focusRequestId: 2 });
    await waitFor(() => expect(result.current.initialFocusMessageId).toBe('m103'));
    expect(result.current.initialFocusIsNavigation).toBe(true);
  });
});

describe('useThreadHistory — paging cursors ignore live appends', () => {
  const live = (i: number) => ({ ...msg(i), content: `live ${i}` });

  it('pages newer from the end of the REST window, not from a live row past the gap', async () => {
    api.getMessages.mockResolvedValueOnce({
      ...page(100, 110, { hasMoreOlder: true, hasMoreNewer: true }),
      anchorId: 'm105',
    });
    const { result } = renderHook(() =>
      useThreadHistory('t1', { focusMessageId: 'm105', focusRequestId: 1 })
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(10));

    // A live message_created lands at the tail while the chunk is parked
    // mid-thread, plus a provisional bubble the server has never seen.
    act(() => {
      result.current.setMessages((prev) => [
        ...prev,
        live(500),
        { ...msg(501), id: 'done:agent-1:R9', role: 'assistant' as const },
      ]);
    });

    api.getMessages.mockResolvedValueOnce(page(110, 120, { hasMoreNewer: true }));
    await act(async () => {
      await result.current.loadNewer();
    });
    expect(api.getMessages).toHaveBeenLastCalledWith('t1', { after: 'm109', limit: 50 });

    // …and the next page continues from where REST left off.
    api.getMessages.mockResolvedValueOnce(page(120, 125));
    await act(async () => {
      await result.current.loadNewer();
    });
    expect(api.getMessages).toHaveBeenLastCalledWith('t1', { after: 'm119', limit: 50 });

    const ids = result.current.messages.map((m) => m.id);
    expect(ids.indexOf('m124')).toBeLessThan(ids.indexOf('m500'));
    expect(ids.slice(0, 25)).toEqual(Array.from({ length: 25 }, (_, k) => `m${100 + k}`));
  });

  it('pages older from the start of the REST window', async () => {
    api.getMessages.mockResolvedValueOnce(page(100, 110, { hasMoreOlder: true }));
    const { result } = renderHook(() => useThreadHistory('t1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(10));
    act(() => {
      result.current.setMessages((prev) => [live(1), ...prev]);
    });

    api.getMessages.mockResolvedValueOnce(page(90, 100));
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(api.getMessages).toHaveBeenLastCalledWith('t1', { before: 'm100', limit: 50 });
  });
});

describe('useThreadHistory — load failure', () => {
  it('surfaces a failed message load as an error and recovers on retry', async () => {
    api.getMessages.mockRejectedValueOnce(new Error('server unavailable'));
    const { result } = renderHook(() => useThreadHistory('t1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('server unavailable');

    api.getMessages.mockResolvedValueOnce(page(100, 110));
    api.listParticipants.mockResolvedValueOnce([{ agentId: 'test-agent-a' }]);
    act(() => result.current.retry());

    await waitFor(() => expect(result.current.messages).toHaveLength(10));
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(result.current.participantAgentIds).toEqual(['test-agent-a']));
  });

  it('a failed participant load is an error, not an empty roster', async () => {
    api.getMessages.mockResolvedValueOnce(page(100, 110));
    api.listParticipants.mockRejectedValueOnce(new Error('participants unavailable'));
    const { result } = renderHook(() => useThreadHistory('t1'));

    await waitFor(() => expect(result.current.error).toBe('participants unavailable'));
    expect(result.current.participantAgentIds).toEqual([]);
  });

  it('reports an error when both the focus window and the latest-page fallback fail', async () => {
    api.getMessages
      .mockRejectedValueOnce(new Error('404 message not found'))
      .mockRejectedValueOnce(new Error('server unavailable'));
    const { result } = renderHook(() =>
      useThreadHistory('t1', { focusMessageId: 'm105', focusRequestId: 1 })
    );
    await waitFor(() => expect(result.current.error).toBe('server unavailable'));
    expect(result.current.loading).toBe(false);
  });
});

describe('useThreadHistory — participant refresh', () => {
  it('drops a roster refresh that lands after the view moved to another thread', async () => {
    api.getMessages.mockResolvedValue(page(100, 110));
    api.listParticipants.mockResolvedValueOnce([{ agentId: 'test-agent-a' }]);
    const { result, rerender } = renderHook(({ threadId }) => useThreadHistory(threadId), {
      initialProps: { threadId: 't1' },
    });
    await waitFor(() => expect(result.current.participantAgentIds).toEqual(['test-agent-a']));

    let resolveStale!: (parts: Array<{ agentId: string }>) => void;
    api.listParticipants.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStale = resolve;
      })
    );
    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refetchParticipants();
    });

    api.listParticipants.mockResolvedValueOnce([{ agentId: 'test-agent-b' }]);
    rerender({ threadId: 't2' });
    await waitFor(() => expect(result.current.participantAgentIds).toEqual(['test-agent-b']));

    await act(async () => {
      resolveStale([{ agentId: 'test-agent-a' }]);
      await refresh;
    });
    expect(result.current.participantAgentIds).toEqual(['test-agent-b']);
  });
});

describe('useThreadHistory — refreshLatest (catch-up after a reconnect)', () => {
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();

  it('merges rows missed while disconnected, without duplicates, and reports only the new ones', async () => {
    api.getMessages.mockResolvedValueOnce(page(100, 110, { hasMoreOlder: true }));
    const { result } = renderHook(() => useThreadHistory('t1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(10));

    // m110 arrived live; then the socket dropped. A provisional done: bubble
    // is waiting on the persisted row of run R1.
    act(() => {
      result.current.setMessages((prev) => [
        ...prev,
        msg(110),
        {
          id: 'done:test-agent-a:R1',
          threadId: 't1',
          role: 'assistant' as const,
          agentId: 'test-agent-a',
          runId: 'R1',
          content: 'streamed text',
          createdAt: at(111),
        },
      ]);
    });

    const reply = {
      id: 'm112',
      threadId: 't1',
      role: 'assistant' as const,
      agentId: 'test-agent-a',
      runId: 'R1',
      content: 'the persisted reply',
      createdAt: at(112),
    };
    api.getMessages.mockResolvedValueOnce({
      messages: [...page(95, 112).messages, reply],
      hasMoreOlder: true,
      hasMoreNewer: false,
    });
    let added: Array<{ id: string }> = [];
    await act(async () => {
      added = await result.current.refreshLatest();
    });

    expect(api.getMessages).toHaveBeenLastCalledWith('t1', { limit: 50 });
    const ids = result.current.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('m111');
    expect(ids).toContain('m112');
    expect(ids).not.toContain('done:test-agent-a:R1');
    expect(ids[ids.length - 1]).toBe('m112');
    // m110 was already held; m95..m99 predate the window, so they are history
    // rather than missed frames and must not retire an optimistic echo.
    expect(added.map((m) => m.id)).toEqual(['m111', 'm112']);
  });

  it('adopts the latest page when more was missed than one page can stitch', async () => {
    api.getMessages.mockResolvedValueOnce(page(100, 110, { hasMoreOlder: true }));
    const { result } = renderHook(() => useThreadHistory('t1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(10));

    api.getMessages.mockResolvedValueOnce(page(200, 250, { hasMoreOlder: true }));
    await act(async () => {
      await result.current.refreshLatest();
    });

    // No invisible gap: the stale window is dropped, the older edge re-armed.
    expect(result.current.messages.map((m) => m.id)[0]).toBe('m200');
    expect(result.current.messages).toHaveLength(50);
    expect(result.current.hasMoreOlder).toBe(true);
    api.getMessages.mockResolvedValueOnce(page(150, 200, { hasMoreOlder: true }));
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(api.getMessages).toHaveBeenLastCalledWith('t1', { before: 'm200', limit: 50 });
  });

  it('leaves a window parked mid-thread alone — paging newer fills that gap', async () => {
    api.getMessages.mockResolvedValueOnce({
      ...page(100, 110, { hasMoreNewer: true }),
      anchorId: 'm105',
    });
    const { result } = renderHook(() =>
      useThreadHistory('t1', { focusMessageId: 'm105', focusRequestId: 1 })
    );
    await waitFor(() => expect(result.current.hasMoreNewer).toBe(true));

    let added: unknown[] = ['sentinel'];
    await act(async () => {
      added = await result.current.refreshLatest();
    });
    expect(added).toEqual([]);
    expect(api.getMessages).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toHaveLength(10);
  });

  it('adds activity for runs that happened while disconnected', async () => {
    api.getMessages.mockResolvedValue(page(100, 110));
    const { result } = renderHook(() => useThreadHistory('t1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    api.getActivityLog.mockResolvedValueOnce([
      {
        id: 'act-1',
        threadId: 't1',
        agentId: 'test-agent-a',
        runId: 'R7',
        actionType: 'tool_call',
        tool: 'search',
        toolInput: { query: 'q' },
        toolOutput: { output: 'found' },
        content: null,
        durationMs: 5,
        createdAt: at(120),
        runStartedAt: at(119),
        runFinishedAt: at(121),
      },
    ]);
    await act(async () => {
      await result.current.refreshLatest();
    });

    expect(result.current.activities.get('R7')?.status).toBe('complete');
    expect(result.current.activities.get('R7')?.steps).toHaveLength(1);
  });

  it('does not race an initial load that is still in flight', async () => {
    api.getMessages.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useThreadHistory('t1'));
    await act(async () => {
      await result.current.refreshLatest();
    });
    expect(api.getMessages).toHaveBeenCalledTimes(1);
  });
});

describe('useThreadHistory — a page that fails to load', () => {
  it('reports the failed edge, keeps the window, and clears once a page loads', async () => {
    api.getMessages.mockResolvedValueOnce(page(100, 110, { hasMoreOlder: true }));
    const { result } = renderHook(() => useThreadHistory('t1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(10));

    api.getMessages.mockRejectedValueOnce(new Error('server unavailable'));
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(result.current.pageError).toEqual({ edge: 'older', message: 'server unavailable' });
    expect(result.current.messages).toHaveLength(10);
    expect(result.current.hasMoreOlder).toBe(true);

    api.getMessages.mockResolvedValueOnce(page(90, 100));
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(result.current.pageError).toBeNull();
    expect(result.current.messages).toHaveLength(20);
  });
});
