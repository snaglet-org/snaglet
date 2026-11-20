/**
 * The Agents tab in a subagent helper's thread. `GET /api/agents` leaves
 * helpers out, so the helper is read by id and gets the card a regular
 * agent gets (Model with its start model as the default, Summary model,
 * Thread instructions, the Settings/Memories/Summaries switch), labeled as
 * its orchestrator's subagent. Its thread offers no "+ Agent", and the
 * helper has no "Remove from thread".
 */
import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { ThreadParticipant } from '@desktop/utils/api';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const editorErrors: unknown[] = [];

const api = vi.hoisted(() => ({
  threads: {
    listParticipants: vi.fn(),
    setParticipantModel: vi.fn(),
    removeParticipant: vi.fn(),
    updateParticipantOverrides: vi.fn(),
  },
  agents: { list: vi.fn(), get: vi.fn() },
  listProposed: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({
  threadsApi: api.threads,
  agentsApi: api.agents,
  memoriesApi: { listProposed: (threadId: string) => api.listProposed(threadId) },
}));
vi.mock('@desktop/hooks/useToolOptions.js', () => ({
  useToolOptions: () => [],
  toolAccessOf: () => ({ mode: 'all', allowList: [], denyList: [] }),
}));
vi.mock('@desktop/features/rich-markdown/workspace-editor/index.js', () => ({
  WorkspaceEditor: ({
    kind,
    savedValue,
    onSave,
  }: {
    kind: string;
    savedValue: string;
    onSave: (content: string) => Promise<unknown>;
  }) => (
    <div data-testid={`editor-${kind}`}>
      <span data-testid="editor-value">{savedValue}</span>
      <button
        type="button"
        onClick={() =>
          void onSave('Edited by a person.').catch((err: unknown) => {
            editorErrors.push(err);
          })
        }
      >
        Save instructions
      </button>
    </div>
  ),
  EditorSaveHint: () => null,
  useEditorSaveStatus: () => ({
    status: { state: 'idle', error: null },
    onSaveStateChange: vi.fn(),
  }),
}));
vi.mock('@desktop/components/BudgetControl/BudgetControl.js', () => ({
  BudgetControl: () => null,
}));
vi.mock('@desktop/components/ToolAccessEditor/index.js', () => ({
  ToolAccessEditor: () => <div data-testid="tool-access-editor">Tool access</div>,
}));
vi.mock('@desktop/components/AgentConfigCard/index.js', () => ({
  ContextWindowPanel: () => null,
}));

interface EditorValue {
  providerId: string | null;
  modelId: string | null;
  credentialId: string | null;
}

vi.mock('@desktop/components/AgentModelEditor/index.js', () => ({
  AgentModelEditor: ({
    value,
    fallback,
    onSave,
  }: {
    value: EditorValue;
    fallback: EditorValue;
    onSave: (next: EditorValue) => Promise<void>;
    headerSlot?: ReactNode;
  }) => (
    <div>
      <span data-testid="model-value">{`${value.providerId}/${value.modelId}`}</span>
      <span data-testid="model-default">{`${fallback.providerId}/${fallback.modelId}`}</span>
      <button
        type="button"
        onClick={() =>
          void onSave({ providerId: 'provider-a', modelId: 'model-b', credentialId: null })
        }
      >
        Save
      </button>
    </div>
  ),
}));

vi.mock('./ThreadUtilityModelOverride', () => ({
  ThreadUtilityModelOverride: ({
    agentId,
    agentModel,
  }: {
    agentId: string;
    agentModel: { providerId: string | null; modelId: string | null };
  }) => (
    <section>
      <h4>Summary model</h4>
      <span data-testid="summary-model">{`${agentId}: ${agentModel.providerId}/${agentModel.modelId}`}</span>
    </section>
  ),
}));

import { AgentsSection } from './AgentsSection';

const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
const ORCH_ID = 'test-agent-a';
const HELPER_ID = 'subagent-11111111-1111-4111-8111-111111111111';

function agent(over: Partial<SnagletAgent> & Pick<SnagletAgent, 'id' | 'name'>): SnagletAgent {
  return {
    provider: 'provider-a',
    modelId: 'model-a',
    credentialId: null,
    systemPrompt: '',
    rawSystemPrompt: null,
    toolAccessMode: null,
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    mcpServers: null,
    toolOverrides: null,
    maxToolCallsPerTurn: null,
    maxDurationSeconds: null,
    fallbacks: null,
    disableModelFallback: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archived: false,
    archivedAt: null,
    ...over,
  };
}

const ORCH = agent({ id: ORCH_ID, name: 'Test Agent A', role: 'Test role', modelId: 'model-c' });
const HELPER = agent({
  id: HELPER_ID,
  name: 'Test Helper',
  role: 'subagent',
  parentAgentId: ORCH_ID,
});

/** The Model section, whose tag says `default` or `overridden`. */
function modelSection(): HTMLElement {
  const section = screen.getByRole('heading', { name: 'Model' }).closest('section');
  if (!section) throw new Error('Model section not found');
  return section;
}

function participant(agentId: string): ThreadParticipant {
  return {
    id: `participant-${agentId}`,
    threadId: THREAD_ID,
    memberId: `member-${agentId}`,
    kind: 'agent',
    agentId,
    role: 'assistant',
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
  };
}

beforeEach(() => {
  editorErrors.length = 0;
  for (const fn of [...Object.values(api.threads), ...Object.values(api.agents)]) fn.mockReset();
  api.agents.list.mockResolvedValue([ORCH]);
  api.listProposed.mockReset().mockResolvedValue([]);
});

describe('the Memories tab', () => {
  it('counts the proposals waiting in this thread in its accessible name', async () => {
    api.threads.listParticipants.mockResolvedValue([participant(ORCH_ID)]);
    const proposal = (id: string) => ({
      id,
      agentId: null,
      memberId: 'member-human',
      key: `user.${id}`,
      content: 'Proposed fact.',
      sourceThreadId: THREAD_ID,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    api.listProposed.mockResolvedValue([proposal('p1'), proposal('p2')]);

    render(<AgentsSection threadId={THREAD_ID} />);

    const tab = await screen.findByRole('button', { name: 'Memories, 2 proposed' });
    expect(tab).toHaveTextContent('Memories2');
    expect(screen.queryByRole('button', { name: /^Proposed/ })).toBeNull();
  });

  it('is plain "Memories" when nothing is proposed', async () => {
    api.threads.listParticipants.mockResolvedValue([participant(ORCH_ID)]);
    render(<AgentsSection threadId={THREAD_ID} />);
    expect(await screen.findByRole('button', { name: 'Memories' })).toBeInTheDocument();
  });
});

describe("AgentsSection in a subagent's thread", () => {
  it('reads the helper by id and shows the card a regular agent gets', async () => {
    api.threads.listParticipants.mockResolvedValue([participant(HELPER_ID)]);
    api.agents.get.mockResolvedValue(HELPER);

    render(<AgentsSection threadId={THREAD_ID} helperThread />);

    expect(await screen.findByRole('heading', { name: 'Test Helper' })).toBeInTheDocument();
    expect(api.agents.get).toHaveBeenCalledWith(HELPER_ID);
    expect(screen.queryByText(/Agent record not found/)).toBeNull();
    // Labeled as its orchestrator's subagent, in the card and the selector.
    expect(screen.getAllByText("Test Agent A's subagent")).toHaveLength(2);
    // A subagent thread holds exactly one agent, so the card is static: no
    // combobox/button trigger and no "switch agent" tooltip.
    expect(screen.queryByRole('button', { name: 'Agent, selected Test Helper' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByTitle('Switch to another agent in this thread')).toBeNull();

    // Model: no override yet, and its default is the model it was started on.
    expect(within(modelSection()).getByText('default')).toBeInTheDocument();
    expect(screen.getByTestId('model-value')).toHaveTextContent('null/null');
    expect(screen.getByTestId('model-default')).toHaveTextContent('provider-a/model-a');
    // Summary model, for this helper on its effective model.
    expect(screen.getByRole('heading', { name: 'Summary model' })).toBeInTheDocument();
    expect(screen.getByTestId('summary-model')).toHaveTextContent(
      `${HELPER_ID}: provider-a/model-a`
    );
    // Its instructions: the helper's only thread, so not "Thread instructions".
    expect(screen.getByRole('button', { name: 'Instructions, None' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /thread instructions/i })).toBeNull();
    for (const tab of ['Settings', 'Memories', 'Summaries']) {
      expect(screen.getByRole('button', { name: tab })).toBeInTheDocument();
    }
    // Proposals live at the top of the Memories list: no tab of their own.
    expect(screen.queryByRole('button', { name: /^Proposed/ })).toBeNull();

    // Nothing that would orphan the helper or crowd its thread.
    expect(screen.queryByRole('button', { name: 'Remove from thread' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Agent' })).toBeNull();
  });

  it('saves a model override for the helper in its thread', async () => {
    const user = userEvent.setup();
    api.threads.listParticipants.mockResolvedValue([participant(HELPER_ID)]);
    api.agents.get.mockResolvedValue(HELPER);
    api.threads.setParticipantModel.mockImplementation(
      async (_threadId: string, agentId: string, next: EditorValue) => ({
        ...participant(agentId),
        ...next,
      })
    );

    render(<AgentsSection threadId={THREAD_ID} helperThread />);
    await screen.findByRole('heading', { name: 'Test Helper' });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(api.threads.setParticipantModel).toHaveBeenCalledWith(THREAD_ID, HELPER_ID, {
      providerId: 'provider-a',
      modelId: 'model-b',
      credentialId: null,
    });
    await waitFor(() => expect(within(modelSection()).getByText('overridden')).toBeInTheDocument());
    expect(screen.getByTestId('summary-model')).toHaveTextContent(
      `${HELPER_ID}: provider-a/model-b`
    );
  });
});

describe("a subagent's instructions in its thread's Settings", () => {
  it('refuses stale instructions and shows the orchestrator’s current version', async () => {
    const user = userEvent.setup();
    api.threads.listParticipants.mockResolvedValue([
      { ...participant(HELPER_ID), systemPromptAddendum: 'Original instructions.' },
    ]);
    api.agents.get.mockResolvedValue(HELPER);
    render(<AgentsSection threadId={THREAD_ID} helperThread />);
    expect(await screen.findByTestId('editor-value')).toHaveTextContent('Original instructions.');
    expect(screen.queryByTestId('tool-access-editor')).not.toBeInTheDocument();

    api.threads.listParticipants.mockResolvedValue([
      { ...participant(HELPER_ID), systemPromptAddendum: 'New orchestrator instructions.' },
    ]);
    await user.click(screen.getByRole('button', { name: 'Save instructions' }));
    await waitFor(() => expect(editorErrors).toHaveLength(1));
    expect(editorErrors[0]).toEqual(
      expect.objectContaining({ message: expect.stringContaining('Instructions changed') })
    );
    expect(api.threads.updateParticipantOverrides).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('New orchestrator instructions.');
    expect(screen.getByTestId('editor-value')).toHaveTextContent('New orchestrator instructions.');

    api.threads.updateParticipantOverrides.mockResolvedValue({
      ...participant(HELPER_ID),
      systemPromptAddendum: 'Edited by a person.',
    });
    await user.click(screen.getByRole('button', { name: 'Save instructions' }));
    await waitFor(() => expect(api.threads.updateParticipantOverrides).toHaveBeenCalledTimes(1));
  });

  it('guards an empty baseline with null and surfaces a server conflict without accepting the draft', async () => {
    const user = userEvent.setup();
    api.threads.listParticipants.mockResolvedValue([
      { ...participant(HELPER_ID), systemPromptAddendum: '' },
    ]);
    api.agents.get.mockResolvedValue(HELPER);
    api.threads.updateParticipantOverrides.mockRejectedValue(new Error('Instructions changed'));
    render(<AgentsSection threadId={THREAD_ID} helperThread />);
    await user.click(await screen.findByRole('button', { name: 'Instructions, None' }));
    await screen.findByTestId('editor-value');
    await user.click(screen.getByRole('button', { name: 'Save instructions' }));
    await waitFor(() => expect(editorErrors).toHaveLength(1));
    expect(api.threads.updateParticipantOverrides).toHaveBeenCalledWith(THREAD_ID, HELPER_ID, {
      systemPromptAddendum: 'Edited by a person.',
      expectedSystemPromptAddendum: null,
    });
    expect(screen.getByTestId('editor-value')).toBeEmptyDOMElement();
  });

  it('shows the instructions its orchestrator set, open, and saves a person’s edit', async () => {
    const user = userEvent.setup();
    api.threads.listParticipants.mockResolvedValue([
      { ...participant(HELPER_ID), systemPromptAddendum: 'Cite a source for every finding.' },
    ]);
    api.agents.get.mockResolvedValue(HELPER);
    api.threads.updateParticipantOverrides.mockImplementation(
      async (
        _threadId: string,
        agentId: string,
        patch: { systemPromptAddendum: string | null }
      ) => ({
        ...participant(agentId),
        ...patch,
      })
    );

    render(<AgentsSection threadId={THREAD_ID} helperThread />);
    await screen.findByRole('heading', { name: 'Test Helper' });

    const toggle = screen.getByRole('button', { name: 'Instructions, Custom instructions' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByTestId('editor-value')).toHaveTextContent(
      'Cite a source for every finding.'
    );
    expect(screen.getByText(/Test Agent A can set and change them too/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save instructions' }));
    expect(api.threads.updateParticipantOverrides).toHaveBeenCalledWith(THREAD_ID, HELPER_ID, {
      systemPromptAddendum: 'Edited by a person.',
      expectedSystemPromptAddendum: 'Cite a source for every finding.',
    });
    await waitFor(() =>
      expect(screen.getByTestId('editor-value')).toHaveTextContent('Edited by a person.')
    );
  });
});

describe('AgentsSection in a regular thread', () => {
  it('keeps "+ Agent" and "Remove from thread", and reads no agent by id', async () => {
    api.threads.listParticipants.mockResolvedValue([participant(ORCH_ID)]);

    render(<AgentsSection threadId={THREAD_ID} />);

    expect(await screen.findByRole('heading', { name: 'Test Agent A' })).toBeInTheDocument();
    expect(screen.getAllByText('Test role')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '+ Agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove from thread' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Thread instructions, Using defaults' })
    ).toBeInTheDocument();
    expect(api.agents.get).not.toHaveBeenCalled();
    expect(screen.getByTestId('tool-access-editor')).toBeInTheDocument();
  });

  it('still reports a participant whose agent is gone, and lets it be removed', async () => {
    api.threads.listParticipants.mockResolvedValue([participant('test-agent-b')]);
    api.agents.get.mockRejectedValue(new Error('Agent not found'));

    render(<AgentsSection threadId={THREAD_ID} />);

    expect(await screen.findByText(/Agent record not found/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove from thread' })).toBeInTheDocument();
  });
});
