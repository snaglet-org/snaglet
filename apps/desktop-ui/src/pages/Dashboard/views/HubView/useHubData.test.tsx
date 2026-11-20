/**
 * useHubPins: the active user's pins come from the `home.pinned` setting and
 * are written one entry at a time; a refused write puts the list back.
 * useThreadDetails: a recent thread's preview is its last real message.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const settings = vi.hoisted(() => ({
  get: vi.fn(),
  putEntry: vi.fn(),
  deleteEntry: vi.fn(),
}));
const threadReads = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listParticipants: vi.fn(),
  getMessages: vi.fn(),
}));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    settingsApi: { ...actual.settingsApi, ...settings },
    agentsApi: { ...actual.agentsApi, list: threadReads.listAgents },
    threadsApi: {
      ...actual.threadsApi,
      listParticipants: threadReads.listParticipants,
      getMessages: threadReads.getMessages,
    },
  };
});

import type { ThreadMessage } from '@desktop/utils/api';
import type { IndexedThread } from './hubModel';
import { useHubPins, useThreadDetails } from './useHubData';

const docPin = { kind: 'doc', id: 'doc-1', title: 'Plan', pinnedAt: '2026-11-16T01:00:00.000Z' };

beforeEach(() => {
  settings.get.mockReset();
  settings.putEntry.mockReset();
  settings.deleteEntry.mockReset();
  settings.get.mockResolvedValue({
    category: 'home',
    key: 'pinned',
    isOverridden: true,
    value: {
      'user-1': { 'doc:doc-1': docPin },
      'user-2': { 'doc:doc-9': { ...docPin, id: 'doc-9' } },
    },
  });
});

describe('useHubPins', () => {
  it('waits for a user, then reads only that user’s pins', async () => {
    const { result, rerender } = renderHook(({ userId }) => useHubPins(userId), {
      initialProps: { userId: null as string | null },
    });
    expect(result.current.status).toBe('loading');
    expect(settings.get).not.toHaveBeenCalled();

    rerender({ userId: 'user-1' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(settings.get).toHaveBeenCalledWith('home', 'pinned');
    expect(result.current.pins).toEqual([docPin]);
    expect(result.current.isPinned('doc', 'doc-1')).toBe(true);
    expect(result.current.isPinned('doc', 'doc-9')).toBe(false);
  });

  it('pins by writing one entry under the user', async () => {
    const { result } = renderHook(() => useHubPins('user-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    settings.putEntry.mockImplementation(async (_c, _k, _path, value) => ({
      'user-1': { 'doc:doc-1': docPin, 'table:table-1': value },
    }));

    await act(() => result.current.pin({ kind: 'table', id: 'table-1', title: 'Budget' }));

    expect(settings.putEntry).toHaveBeenCalledWith(
      'home',
      'pinned',
      ['user-1', 'table:table-1'],
      expect.objectContaining({ kind: 'table', id: 'table-1', title: 'Budget' })
    );
    expect(result.current.isPinned('table', 'table-1')).toBe(true);
  });

  it('puts the list back and says why when a pin is refused', async () => {
    const { result } = renderHook(() => useHubPins('user-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    settings.putEntry.mockRejectedValue(new Error('Server is down'));

    await act(() => result.current.pin({ kind: 'thread', id: 'thread-1', title: 'Chat' }));

    expect(result.current.isPinned('thread', 'thread-1')).toBe(false);
    expect(result.current.error).toBe('Server is down');
  });

  it('unpins by removing the entry', async () => {
    const { result } = renderHook(() => useHubPins('user-1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    settings.deleteEntry.mockResolvedValue({});

    await act(() => result.current.unpin('doc', 'doc-1'));

    expect(settings.deleteEntry).toHaveBeenCalledWith('home', 'pinned', ['user-1', 'doc:doc-1']);
    expect(result.current.pins).toEqual([]);
  });
});

describe('useThreadDetails', () => {
  const thread = {
    node: {
      kind: 'thread',
      id: 'thread-1',
      title: 'Onboarding',
      lastMessageAt: '2026-11-16T01:00:00.000Z',
    },
    projectName: null,
  } as unknown as IndexedThread;

  function message(over: Partial<ThreadMessage>): ThreadMessage {
    return {
      id: 'msg-1',
      threadId: 'thread-1',
      role: 'user',
      agentId: null,
      content: 'hello',
      createdAt: '2026-11-16T01:00:00.000Z',
      ...over,
    };
  }

  beforeEach(() => {
    threadReads.listAgents.mockReset().mockResolvedValue([{ id: 'agent-a', name: 'Test Agent A' }]);
    threadReads.listParticipants.mockReset().mockResolvedValue([]);
    threadReads.getMessages.mockReset();
  });

  it('previews the last real message, not a failed run’s notice', async () => {
    threadReads.getMessages.mockResolvedValue({
      messages: [
        message({ id: 'msg-1', content: 'Can you show me around?' }),
        message({
          id: 'msg-2',
          role: 'assistant',
          agentId: 'agent-a',
          content: '⚠ No model configured: Pick a provider and model.',
          runError: { kind: 'no_model', summary: 'Pick a provider and model.' },
        } as Partial<ThreadMessage>),
      ],
    });

    const { result } = renderHook(() => useThreadDetails([thread]));

    await waitFor(() => expect(result.current.get('thread-1')?.status).toBe('ready'));
    expect(result.current.get('thread-1')?.snippet).toEqual({
      sender: 'You',
      text: 'Can you show me around?',
    });
  });

  it('shows no preview when a failed run’s notice is all the thread holds', async () => {
    threadReads.getMessages.mockResolvedValue({
      messages: [
        message({
          role: 'assistant',
          agentId: 'agent-a',
          content: '⚠ No model configured',
          runError: { kind: 'no_model', summary: 'Pick a provider and model.' },
        } as Partial<ThreadMessage>),
      ],
    });

    const { result } = renderHook(() => useThreadDetails([thread]));

    await waitFor(() => expect(result.current.get('thread-1')?.status).toBe('ready'));
    expect(result.current.get('thread-1')?.snippet).toBeNull();
  });
});
