/**
 * ThreadPane — a `thread` pane selection renders ChatView, except for a DM
 * thread (`kind = 'dm'`), which gets the DM reading pane wherever it was
 * opened from: the notification bell, a thread chip, an agent's
 * navigate_pane, a restored layout. The DM pane marks it read; the chat view
 * would not, and would offer a composer and participant controls on a DM pair.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { ThreadParticipant, ThreadSummary } from '@desktop/utils/api';
import type { UseChatStreamResult } from './ChatView/hooks/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  getThread: vi.fn(),
  listParticipants: vi.fn(),
  markDmRead: vi.fn(),
  listAgents: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    agentsApi: { ...actual.agentsApi, list: (...a: unknown[]) => api.listAgents(...a) },
    userProfileApi: { ...actual.userProfileApi, get: () => api.getUser() },
    threadsApi: {
      ...actual.threadsApi,
      get: (threadId: string) => api.getThread(threadId),
      listParticipants: (threadId: string) => api.listParticipants(threadId),
      markDmRead: (threadId: string) => api.markDmRead(threadId),
    },
  };
});

vi.mock('./ChatView', () => ({
  ChatView: ({ threadId }: { threadId: string }) => (
    <div data-testid="chat-view">{`chat ${threadId}`}</div>
  ),
}));

const stream = vi.hoisted(() => ({ current: null as UseChatStreamResult | null }));
vi.mock('./ChatView/hooks/useChatStream', () => ({ useChatStream: () => stream.current }));
vi.mock('./ChatView/Composer/Composer', () => ({
  Composer: () => <div data-testid="dm-composer" />,
}));

import { ThreadPane } from './ThreadPane';

const AGENT_A = 'test-agent-a';

function chatStream(): UseChatStreamResult {
  return {
    messages: [],
    activities: new Map(),
    agentStatuses: new Map(),
    memoryExtractions: [],
    ready: true,
    loading: false,
    historyError: null,
    retryHistory: vi.fn(),
    working: false,
    currentWave: null,
    participantCount: 1,
    participantAgentIds: [AGENT_A],
    refetchParticipants: vi.fn(async () => undefined),
    sendMessage: vi.fn(),
    stopGeneration: vi.fn(),
    stopAgentGeneration: vi.fn(),
    pendingClarification: null,
    respondToClarification: vi.fn(),
    pendingToolConfirmations: [],
    respondToToolConfirmation: vi.fn(),
    hasMoreOlder: false,
    hasMoreNewer: false,
    paginating: false,
    pageError: null,
    loadOlder: vi.fn(async () => undefined),
    loadNewer: vi.fn(async () => undefined),
    initialFocusMessageId: null,
    initialFocusRequestId: null,
    initialFocusIsNavigation: false,
    dispatchHint: null,
    clearDispatchHint: vi.fn(),
    lastSendError: null,
    clearSendError: vi.fn(),
  } as UseChatStreamResult;
}

function thread(id: string, kind?: 'chat' | 'dm'): ThreadSummary {
  return { id, title: 'Test thread', ...(kind ? { kind } : {}) } as ThreadSummary;
}

beforeEach(() => {
  vi.clearAllMocks();
  stream.current = chatStream();
  api.listParticipants.mockResolvedValue([
    { id: 'participant-agent', kind: 'agent', agentId: AGENT_A } as ThreadParticipant,
    { id: 'participant-user', kind: 'user', agentId: '' } as ThreadParticipant,
  ]);
  api.markDmRead.mockResolvedValue(null);
  api.listAgents.mockResolvedValue([{ id: AGENT_A, name: 'Test Agent A' } as SnagletAgent]);
  api.getUser.mockResolvedValue({ id: 'user-1', name: 'Test User' });
});

describe('ThreadPane', () => {
  it('opens a DM thread in the DM reading pane, which marks it read', async () => {
    const threadId = 'thread-dm-1111111111111-aaaaaaaaa';
    api.getThread.mockResolvedValue(thread(threadId, 'dm'));
    render(<ThreadPane selection={{ kind: 'thread', thread_id: threadId }} />);

    await waitFor(() => expect(api.markDmRead).toHaveBeenCalledWith(threadId));
    expect(screen.queryByTestId('chat-view')).toBeNull();
    expect(await screen.findByTestId('dm-composer')).toBeInTheDocument();
  });

  it('opens an ordinary thread in the chat view', async () => {
    const threadId = 'thread-1111111111111-bbbbbbbbb';
    api.getThread.mockResolvedValue(thread(threadId, 'chat'));
    render(<ThreadPane selection={{ kind: 'thread', thread_id: threadId }} />);

    expect(await screen.findByTestId('chat-view')).toHaveTextContent(`chat ${threadId}`);
    expect(api.markDmRead).not.toHaveBeenCalled();
  });

  it('shows a tree-hydrated thread in the chat view at once', () => {
    const threadId = 'thread-2222222222222-ccccccccc';
    api.getThread.mockReturnValue(new Promise(() => {}));
    render(
      <ThreadPane
        selection={{
          kind: 'thread',
          thread_id: threadId,
          node: {
            kind: 'thread',
            id: threadId,
            projectId: null,
            title: 'Test thread',
            sortOrder: 0,
            lastMessageAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: null,
          },
        }}
      />
    );
    expect(screen.getByTestId('chat-view')).toBeInTheDocument();
  });

  it('falls back to the chat view when the thread cannot be read', async () => {
    const threadId = 'thread-3333333333333-ddddddddd';
    api.getThread.mockRejectedValue(new Error('offline'));
    render(<ThreadPane selection={{ kind: 'thread', thread_id: threadId }} />);

    expect(await screen.findByTestId('chat-view')).toBeInTheDocument();
  });
});
