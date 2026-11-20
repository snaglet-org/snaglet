/**
 * DmView — one DM conversation in the detail pane: chat bubbles with each
 * author's avatar and name, a composer only when the user is a party (a user
 * to agent thread sends through the normal chat path), read marking on open
 * and on arrival, Clear (and Delete for an agent-to-agent DM only), and Fork
 * to the workspace.
 *
 * The realtime transcript (`useChatStream`) and the rich composer are stubbed;
 * the message list is the real shared component.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { ThreadMessage, ThreadParticipant } from '@desktop/utils/api';
import type { UseChatStreamResult } from '../ChatView/hooks/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  listParticipants: vi.fn(),
  markDmRead: vi.fn(),
  deleteThread: vi.fn(),
  listAgents: vi.fn(),
  getUser: vi.fn(),
  fork: vi.fn(),
}));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    agentsApi: { ...actual.agentsApi, list: (...a: unknown[]) => api.listAgents(...a) },
    userProfileApi: { ...actual.userProfileApi, get: () => api.getUser() },
    threadsApi: {
      ...actual.threadsApi,
      listParticipants: (threadId: string) => api.listParticipants(threadId),
      markDmRead: (threadId: string) => api.markDmRead(threadId),
      delete: (threadId: string) => api.deleteThread(threadId),
      fork: (threadId: string, body: unknown) => api.fork(threadId, body),
    },
  };
});

// Fork dialog's project picker and the success toast / open-thread wiring.
const projectList = vi.hoisted(() => ({ projects: [] as unknown[], error: null as string | null }));
vi.mock('@desktop/features/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@desktop/features/database')>()),
  useProjectList: () => ({ ...projectList, loading: false, reload: vi.fn() }),
}));
const toast = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@desktop/utils/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@desktop/utils/toast')>()),
  showToast: (...a: unknown[]) => toast.show(...a),
}));
const openThread = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@desktop/utils/openThread', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@desktop/utils/openThread')>()),
  requestOpenThread: (...a: unknown[]) => openThread.request(...a),
}));

const stream = vi.hoisted(() => ({ current: null as UseChatStreamResult | null }));
vi.mock('../ChatView/hooks/useChatStream', () => ({
  useChatStream: () => stream.current,
}));
vi.mock('../ChatView/Composer/Composer', () => ({
  Composer: ({ onSubmit }: { onSubmit?: (text: string) => void }) => (
    <button type="button" data-testid="dm-composer" onClick={() => onSubmit?.('hello')}>
      composer
    </button>
  ),
}));

// The agent detail form's heavy editors (see AgentDetail.budget.test.tsx).
vi.mock('@desktop/hooks/useToolOptions', () => ({
  useToolOptions: () => [],
  toolAccessOf: () => ({ mode: 'all', allowList: [], denyList: [] }),
}));
vi.mock('@desktop/features/rich-markdown/workspace-editor', () => ({
  WorkspaceEditor: () => null,
  EditorSaveHint: () => null,
  useEditorSaveStatus: () => ({
    status: { state: 'idle', error: null },
    onSaveStateChange: vi.fn(),
  }),
}));
vi.mock('@desktop/components/ToolAccessEditor', () => ({ ToolAccessEditor: () => null }));
vi.mock('@desktop/components/AgentModelEditor', () => ({ AgentModelEditor: () => null }));
vi.mock('@desktop/components/AgentConfigCard', () => ({ ContextWindowPanel: () => null }));
vi.mock('../ChatView/settings/ThreadUtilityModelOverride', () => ({
  ThreadUtilityModelOverride: () => null,
}));
vi.mock('@desktop/features/skills', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@desktop/features/skills')>()),
  ThreadSkillsSection: () => null,
}));

import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { onDmRead } from '@desktop/features/dms';
import { DmView } from './DmView';

const THREAD = 'thread-dm-1111111111111-aaaaaaaaa';
const AGENT_A = 'test-agent-a';
const AGENT_B = 'test-agent-b';

function agent(id: string, name: string): SnagletAgent {
  return { id, name, archived: false, archivedAt: null } as unknown as SnagletAgent;
}

function participant(kind: 'agent' | 'user', agentId = ''): ThreadParticipant {
  return {
    id: `participant-${kind}-${agentId}`,
    threadId: THREAD,
    memberId: `member-${kind}-${agentId}`,
    kind,
    agentId,
  } as ThreadParticipant;
}

function message(over: Partial<ThreadMessage> & { id: string }): ThreadMessage {
  return {
    threadId: THREAD,
    role: 'assistant',
    agentId: AGENT_A,
    content: `text of ${over.id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    messageType: 'message',
    ...over,
  };
}

function chatStream(over: Partial<UseChatStreamResult> = {}): UseChatStreamResult {
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
    ...over,
  } as UseChatStreamResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  stream.current = chatStream();
  api.listParticipants.mockResolvedValue([participant('agent', AGENT_A), participant('user')]);
  api.markDmRead.mockResolvedValue(null);
  api.deleteThread.mockResolvedValue(null);
  api.listAgents.mockResolvedValue([
    agent(AGENT_A, 'Test Agent A'),
    agent(AGENT_B, 'Test Agent B'),
  ]);
  api.getUser.mockResolvedValue({ id: 'user-1', name: 'Test User' });
  projectList.projects = [];
  projectList.error = null;
  api.fork.mockResolvedValue({ id: 'thread-forked-1', title: 'Forked', kind: 'chat' });
});

it('the header offers Clear (opens the clear dialog), not Trim older messages', async () => {
  render(<DmView threadId={THREAD} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
  expect(await screen.findByRole('button', { name: 'Clear thread' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Trim older messages' })).toBeNull();
});

describe('DmView', () => {
  it('user to agent thread has a composer', async () => {
    render(<DmView threadId={THREAD} />);

    const composer = await screen.findByTestId('dm-composer');
    // The normal chat send: the agent wakes in the pair thread.
    fireEvent.click(composer);
    expect(stream.current?.sendMessage).toHaveBeenCalledWith('hello');
    expect(screen.queryByText(/read only/i)).toBeNull();
  });

  it('heads the user’s DM as the agent’s home thread', async () => {
    render(<DmView threadId={THREAD} title="Test Agent A ↔ Test User" />);

    expect(
      await screen.findByRole('heading', { name: 'Test Agent A · Home thread' })
    ).toBeInTheDocument();
  });

  it('heads an agent-to-agent DM with both agents', async () => {
    api.listParticipants.mockResolvedValue([
      participant('agent', AGENT_A),
      participant('agent', AGENT_B),
    ]);
    stream.current = chatStream({ participantAgentIds: [AGENT_A, AGENT_B], participantCount: 2 });
    render(<DmView threadId={THREAD} />);

    const heading = await screen.findByRole('heading', { name: 'Test Agent A ↔ Test Agent B' });
    expect(heading).not.toHaveTextContent('Home thread');
  });

  it('agent to agent thread has no composer', async () => {
    api.listParticipants.mockResolvedValue([
      participant('agent', AGENT_A),
      participant('agent', AGENT_B),
    ]);
    stream.current = chatStream({ participantAgentIds: [AGENT_A, AGENT_B], participantCount: 2 });
    render(<DmView threadId={THREAD} />);

    await screen.findByText(/read only/i);
    expect(screen.queryByTestId('dm-composer')).toBeNull();
    // The user has no read cursor in a conversation between two agents.
    expect(api.markDmRead).not.toHaveBeenCalled();
  });

  it('DMs off for the agent: a note in place of the composer, history still readable', async () => {
    api.listAgents.mockResolvedValue([
      { ...agent(AGENT_A, 'Test Agent A'), dmEnabled: false },
      agent(AGENT_B, 'Test Agent B'),
    ]);
    stream.current = chatStream({
      messages: [message({ id: 'message-1', content: 'an earlier reply' })],
    });
    render(<DmView threadId={THREAD} />);

    await screen.findByText('DMs are off for Test Agent A.');
    expect(screen.queryByTestId('dm-composer')).toBeNull();
    expect(screen.getByText('an earlier reply')).toBeInTheDocument();
  });

  it('marks read only once the history has loaded, once per stored message', async () => {
    stream.current = chatStream({ loading: true });
    const view = render(<DmView threadId={THREAD} />);
    await waitFor(() => expect(api.listParticipants).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.markDmRead).not.toHaveBeenCalled();

    stream.current = chatStream({ messages: [message({ id: 'message-1' })] });
    view.rerender(<DmView threadId={THREAD} />);
    await waitFor(() => expect(api.markDmRead).toHaveBeenCalledTimes(1));

    // A re-render, or a history reload, with nothing new stored: no new call.
    stream.current = chatStream({ messages: [message({ id: 'message-1' })], loading: true });
    view.rerender(<DmView threadId={THREAD} />);
    stream.current = chatStream({ messages: [message({ id: 'message-1' })] });
    view.rerender(<DmView threadId={THREAD} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.markDmRead).toHaveBeenCalledTimes(1);

    stream.current = chatStream({
      messages: [message({ id: 'message-1' }), message({ id: 'message-2' })],
    });
    view.rerender(<DmView threadId={THREAD} />);
    await waitFor(() => expect(api.markDmRead).toHaveBeenCalledTimes(2));
  });

  it('shows each message as a bubble with its author’s avatar and name', async () => {
    stream.current = chatStream({
      messages: [
        message({ id: 'message-1', content: 'hello from the agent' }),
        message({ id: 'message-2', role: 'user', agentId: null, content: 'hello back' }),
      ],
    });
    render(<DmView threadId={THREAD} />);

    const agentRow = (await screen.findByText('hello from the agent')).closest<HTMLElement>(
      '[data-message-id]'
    );
    const userRow = screen.getByText('hello back').closest<HTMLElement>('[data-message-id]');
    await waitFor(() => expect(within(agentRow!).getByText(/test agent a/i)).toBeInTheDocument());
    expect(within(agentRow!).getByTestId('dm-avatar')).toHaveAttribute('data-kind', 'agent');
    await waitFor(() => expect(within(userRow!).getByText(/test user/i)).toBeInTheDocument());
    expect(userRow).toHaveTextContent('Test User (you)');
    expect(agentRow).not.toHaveTextContent('(you)');
    expect(within(userRow!).queryByTestId('dm-avatar')).toBeNull();
  });

  it('opening a thread marks it read', async () => {
    const read: string[] = [];
    const stop = onDmRead((threadId) => read.push(threadId));
    const view = render(<DmView threadId={THREAD} />);
    await waitFor(() => expect(api.markDmRead).toHaveBeenCalledWith(THREAD));
    // The DMs list hears about it, so its badges clear.
    await waitFor(() => expect(read).toContain(THREAD));
    stop();
    const calls = api.markDmRead.mock.calls.length;

    // A DM arriving while the pane is open keeps the thread read.
    stream.current = chatStream({ messages: [message({ id: 'message-9' })] });
    view.rerender(<DmView threadId={THREAD} />);
    await waitFor(() => expect(api.markDmRead.mock.calls.length).toBeGreaterThan(calls));
  });

  it('a home thread offers Clear but no Delete', async () => {
    render(<DmView threadId={THREAD} />);

    expect(await screen.findByRole('button', { name: 'Clear' })).toBeInTheDocument();
    await screen.findByRole('heading', { name: 'Test Agent A · Home thread' });
    expect(screen.queryByRole('button', { name: 'Delete conversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
  });

  it('shows no Delete until it knows whose conversation it is', async () => {
    api.listParticipants.mockReturnValue(new Promise(() => {}));
    render(<DmView threadId={THREAD} />);

    expect(await screen.findByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete conversation' })).toBeNull();
  });

  it('Delete removes a whole agent-to-agent DM and closes the pane', async () => {
    api.listParticipants.mockResolvedValue([
      participant('agent', AGENT_A),
      participant('agent', AGENT_B),
    ]);
    stream.current = chatStream({ participantAgentIds: [AGENT_A, AGENT_B], participantCount: 2 });
    const onClosePane = vi.fn();
    render(<DmView threadId={THREAD} onClosePane={onClosePane} />);

    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete conversation' }));

    await waitFor(() => expect(onClosePane).toHaveBeenCalledTimes(1));
    expect(api.deleteThread).toHaveBeenCalledWith(THREAD);
    // The server's thread-deleted echo does not close a second pane.
    act(() => emitLibraryEvent({ type: 'deleted', kind: 'thread', id: THREAD }));
    expect(onClosePane).toHaveBeenCalledTimes(1);
  });

  it('closes when the conversation is deleted elsewhere', async () => {
    const onClosePane = vi.fn();
    render(<DmView threadId={THREAD} onClosePane={onClosePane} />);
    await screen.findByTestId('dm-composer');

    act(() => emitLibraryEvent({ type: 'deleted', kind: 'thread', id: 'thread-other' }));
    expect(onClosePane).not.toHaveBeenCalled();
    act(() => emitLibraryEvent({ type: 'deleted', kind: 'thread', id: THREAD }));
    expect(onClosePane).toHaveBeenCalledTimes(1);
  });
});

describe('DmView — fork to workspace', () => {
  it('disables the Fork button when the thread has no messages', async () => {
    stream.current = chatStream({ messages: [] });
    render(<DmView threadId={THREAD} />);
    const forkBtn = await screen.findByRole('button', { name: 'Fork thread to workspace' });
    expect(forkBtn).toBeDisabled();
  });

  it('disables the Fork button while the agent is working, with a why tooltip', async () => {
    stream.current = chatStream({
      messages: [message({ id: 'message-1', content: 'a stored reply' })],
      working: true,
    });
    render(<DmView threadId={THREAD} />);
    const forkBtn = await screen.findByRole('button', { name: 'Fork thread to workspace' });
    expect(forkBtn).toBeDisabled();
    expect(forkBtn).toHaveAttribute('title', expect.stringMatching(/replying/i));
  });

  it('opens the dialog, forks with title + project, and shows a confirmation link', async () => {
    projectList.projects = [{ id: 'project-1', name: 'Demo', ancestors: [], archived: false }];
    stream.current = chatStream({
      messages: [message({ id: 'message-1', content: 'a stored reply' })],
    });
    render(<DmView threadId={THREAD} />);

    const forkBtn = await screen.findByRole('button', { name: 'Fork thread to workspace' });
    expect(forkBtn).toBeEnabled();
    fireEvent.click(forkBtn);

    // Dialog: a prefilled title and the optional project picker.
    const titleInput = await screen.findByDisplayValue(/Home thread/);
    expect((titleInput as HTMLInputElement).value).toMatch(
      /^Test Agent A \u00b7 Home thread \u00b7 /
    );
    fireEvent.change(titleInput, { target: { value: 'My fork' } });
    fireEvent.change(screen.getByLabelText('Project for the forked thread'), {
      target: { value: 'project-1' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));

    await waitFor(() =>
      expect(api.fork).toHaveBeenCalledWith(THREAD, { title: 'My fork', projectId: 'project-1' })
    );
    // The confirmation toast carries an "Open thread" action onto the new thread.
    await waitFor(() => expect(toast.show).toHaveBeenCalledTimes(1));
    const [, opts] = toast.show.mock.calls[0] as [string, { action: { run: () => void } }];
    opts.action.run();
    expect(openThread.request).toHaveBeenCalledWith('thread-forked-1', 'Forked');
  });
});
