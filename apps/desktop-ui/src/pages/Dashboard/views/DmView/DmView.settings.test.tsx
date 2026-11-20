/**
 * DmView — a home thread's Settings: ChatView's settings panel narrowed to
 * the Agents section only, opened beside the chat from the header. With one
 * section left it shows no tab strip; Maintenance is gone (clearing lives on
 * the header, history is preserved by "Fork thread to workspace"). An
 * agent-to-agent DM has no Settings.
 *
 * The settings panel, its Agents section, the agent detail form
 * and the Clear dialog are the real shared components; the agent form's
 * heavy editors and the realtime transcript are stubbed, as in the chat
 * settings suites.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { ThreadParticipant } from '@desktop/utils/api';
import type { UseChatStreamResult } from '../ChatView/hooks/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  listParticipants: vi.fn(),
  markDmRead: vi.fn(),
  deleteThread: vi.fn(),
  updateParticipantOverrides: vi.fn(),
  clear: vi.fn(),
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
      listParticipants: (threadId: string) => api.listParticipants(threadId),
      markDmRead: (threadId: string) => api.markDmRead(threadId),
      delete: (threadId: string) => api.deleteThread(threadId),
      updateParticipantOverrides: (...a: unknown[]) => api.updateParticipantOverrides(...a),
      clear: (...a: unknown[]) => api.clear(...a),
    },
  };
});

const stream = vi.hoisted(() => ({ current: null as UseChatStreamResult | null }));
vi.mock('../ChatView/hooks/useChatStream', () => ({
  useChatStream: () => stream.current,
}));
vi.mock('../ChatView/Composer/Composer', () => ({
  Composer: () => <div data-testid="dm-composer" />,
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

import { DmView } from './DmView';

const THREAD = 'thread-dm-1111111111111-aaaaaaaaa';
const AGENT_A = 'test-agent-a';
const AGENT_B = 'test-agent-b';

function agent(id: string, name: string): SnagletAgent {
  return {
    id,
    name,
    provider: 'provider-a',
    modelId: 'model-a',
    credentialId: null,
    archived: false,
    archivedAt: null,
  } as unknown as SnagletAgent;
}

function participant(kind: 'agent' | 'user', agentId = ''): ThreadParticipant {
  return {
    id: `participant-${kind}-${agentId}`,
    threadId: THREAD,
    memberId: `member-${kind}-${agentId}`,
    kind,
    agentId,
    role: 'participant',
    credentialId: null,
    providerId: null,
    modelId: null,
    addedAt: '2026-01-01T00:00:00.000Z',
    systemPromptAddendum: null,
    toolAccessMode: null,
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    toolOverrides: null,
    maxToolCallsPerTurn: null,
    maxDurationSeconds: null,
    autoRespond: true,
    disableFallback: false,
  } as ThreadParticipant;
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

const settingsPanel = (): HTMLElement => screen.getByTestId('dm-settings');

beforeEach(() => {
  vi.clearAllMocks();
  stream.current = chatStream();
  api.listParticipants.mockResolvedValue([participant('agent', AGENT_A), participant('user')]);
  api.markDmRead.mockResolvedValue(null);
  api.listAgents.mockResolvedValue([
    agent(AGENT_A, 'Test Agent A'),
    agent(AGENT_B, 'Test Agent B'),
  ]);
  api.getUser.mockResolvedValue({ id: 'user-1', name: 'Test User' });
  api.updateParticipantOverrides.mockImplementation(
    async (_threadId: string, agentId: string, patch: Partial<ThreadParticipant>) => ({
      ...participant('agent', agentId),
      ...patch,
    })
  );
  api.clear.mockResolvedValue({ deletedMessages: 4 });
});

describe('DmView — home thread settings', () => {
  it('the Settings toggle opens the sidebar with only Agents and no tab strip', async () => {
    render(<DmView threadId={THREAD} />);

    const toggle = await screen.findByRole('button', { name: 'Home thread settings' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('dm-settings')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const panel = settingsPanel();
    // A home thread narrows to Agents alone, so there is no chooser at all.
    expect(within(panel).queryByRole('tab')).toBeNull();
    expect(within(panel).queryByRole('tab', { name: 'Maintenance' })).toBeNull();
    // The one section still renders — the agent's detail heading is present.
    await within(panel).findByRole('heading', { name: 'Test Agent A' });
    // Resizable like the chat's settings panel.
    expect(
      within(panel).getByRole('separator', { name: 'Resize settings panel' })
    ).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByTestId('dm-settings')).toBeNull();
  });

  it('the agent card is static (no combobox/button) when the thread holds one agent', async () => {
    render(<DmView threadId={THREAD} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Home thread settings' }));
    const panel = settingsPanel();
    await within(panel).findByRole('heading', { name: 'Test Agent A' });
    // No switch affordance: not a combobox, and no "Agent, selected …" trigger.
    expect(within(panel).queryByRole('combobox')).toBeNull();
    expect(within(panel).queryByRole('button', { name: /Agent, selected/ })).toBeNull();
    expect(within(panel).queryByTitle('Switch to another agent in this thread')).toBeNull();
  });

  it('the Agents tab edits the agent through the chat settings API, with no add or remove', async () => {
    const user = userEvent.setup();
    render(<DmView threadId={THREAD} />);
    await user.click(await screen.findByRole('button', { name: 'Home thread settings' }));

    const panel = settingsPanel();
    await within(panel).findByRole('heading', { name: 'Test Agent A' });
    // A DM is between exactly its two parties.
    expect(within(panel).queryByRole('button', { name: /\+ agent/i })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Remove from thread' })).toBeNull();

    await user.click(within(panel).getByRole('radio', { name: 'Limited' }));
    await waitFor(() =>
      expect(api.updateParticipantOverrides).toHaveBeenCalledWith(THREAD, AGENT_A, {
        maxToolCallsPerTurn: null,
        maxDurationSeconds: 900,
      })
    );
  });

  it('an agent-to-agent thread has no Settings', async () => {
    api.listParticipants.mockResolvedValue([
      participant('agent', AGENT_A),
      participant('agent', AGENT_B),
    ]);
    stream.current = chatStream({ participantAgentIds: [AGENT_A, AGENT_B], participantCount: 2 });
    render(<DmView threadId={THREAD} />);

    await screen.findByText(/read only/i);
    expect(screen.queryByRole('button', { name: 'Home thread settings' })).toBeNull();
    expect(screen.queryByTestId('dm-settings')).toBeNull();
    // The header carries Clear; Trim older messages is gone.
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Trim older messages' })).toBeNull();
  });
});
