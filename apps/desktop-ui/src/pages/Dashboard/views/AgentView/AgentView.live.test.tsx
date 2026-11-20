/**
 * The agent pane follows changes made while it is open: another agent's tool
 * call, an automation, a script, another window. A field the user is not
 * editing takes the new value with a brief highlight; a text field the user
 * is editing keeps their text and says who changed it, with Reload and Keep
 * mine. The pane's own saves never read as someone else's change, events for
 * other agents change nothing, bursts make one refetch, a reconnect resyncs,
 * and a deleted or archived agent shows as such.
 *
 * Events go through the real agent bus (what the workspace bridge feeds); the
 * prompt editors are stubbed to show the value they get and any conflict.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { Actor } from '@snaglet/shared/types/workspace-events';
import { agentsApi } from '@desktop/utils/api';
import { emitAgentEvent } from '@desktop/utils/agentEvents';
import { AgentView } from './AgentView';
import type { ConflictChoice, EditingProbe, LiveConflict } from './agentLiveFields';

vi.mock('autofit-text', () => ({ useAutofitText: () => {} }));

vi.mock('@desktop/utils/api', () => ({
  agentsApi: { get: vi.fn(), update: vi.fn() },
  toolsApi: { list: vi.fn(async () => []) },
  mcpServersApi: { list: vi.fn(async () => []) },
}));

vi.mock('@desktop/components/ModelSelector/ModelSelector.js', () => ({
  useModelData: () => ({
    providers: [{ id: 'p1', name: 'Prov One', type: 'llm' }],
    models: [{ id: 'row-m1', modelId: 'm1', providerId: 'p1', displayName: 'Model 1' }],
    credentials: [],
    loading: false,
  }),
}));

interface StubEditorProps {
  value: string;
  conflict?: LiveConflict | null;
  onResolveConflict?: (choice?: ConflictChoice) => void;
  editingProbe?: EditingProbe;
  onKeepDraft?: (text: string) => void;
}

// Whether the user is "editing" each stubbed prompt editor; the stub answers
// the pane's probe with it.
const stub = vi.hoisted(() => ({
  editing: { identity: false, systemPrompt: false },
  resolve: { identity: null as null | ((choice?: ConflictChoice) => void) },
  keepDraft: { identity: null as null | ((text: string) => void) },
}));

function stubEditor(name: 'identity' | 'systemPrompt', testId: string) {
  return function StubEditor({
    value,
    conflict,
    onResolveConflict,
    editingProbe,
    onKeepDraft,
  }: StubEditorProps) {
    if (editingProbe) editingProbe.current = () => stub.editing[name];
    if (name === 'identity') {
      stub.resolve.identity = onResolveConflict ?? null;
      stub.keepDraft.identity = onKeepDraft ?? null;
    }
    return (
      <div data-testid={testId} data-value={value}>
        {conflict && (
          <span data-testid={`${testId}-conflict`}>
            {conflict.by}: {conflict.remote}
          </span>
        )}
      </div>
    );
  };
}

vi.mock('./IdentityEditor.js', () => ({
  IdentityEditor: stubEditor('identity', 'identity-editor'),
}));
vi.mock('./SystemPromptEditor.js', () => ({
  SystemPromptEditor: stubEditor('systemPrompt', 'system-prompt-editor'),
}));
vi.mock('./AgentMcpServers.js', () => ({ AgentMcpServers: () => null }));
vi.mock('./AgentUtilityModelOverride.js', () => ({ AgentUtilityModelOverride: () => null }));
vi.mock('@desktop/features/voice/index.js', () => ({ VoicePicker: () => null }));
vi.mock('./AgentMemoriesTab', () => ({ AgentMemoriesTab: () => null }));
vi.mock('./AgentDmsTab', () => ({ AgentDmsTab: () => null }));

const get = vi.mocked(agentsApi.get);
const update = vi.mocked(agentsApi.update);

function makeAgent(overrides: Partial<SnagletAgent> = {}): SnagletAgent {
  return {
    id: 'agent-1',
    name: 'Ada',
    role: 'Dev',
    provider: 'p1',
    modelId: 'm1',
    credentialId: null,
    systemPrompt: 'Old prompt',
    rawSystemPrompt: 'Old prompt',
    identity: 'Old persona',
    rawIdentity: 'Old persona',
    toolAccessMode: null,
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    mcpServers: [],
    disableModelFallback: false,
    archived: false,
    updatedAt: 'rev-1',
    ...overrides,
  } as unknown as SnagletAgent;
}

const VENUS: Actor = { actorId: 'agent-venus', actorKind: 'agent', actorName: 'Venus' };
const ME: Actor = { actorId: 'user-1', actorKind: 'user', actorName: 'Robin' };

function agentUpdated(
  changed: string[],
  options: { agentId?: string; updatedAt?: string; actor?: Actor } = {}
): void {
  act(() => {
    emitAgentEvent({
      type: 'agent.updated',
      agentId: options.agentId ?? 'agent-1',
      changed,
      ts: '2026-11-16T10:00:00.000Z',
      actor: options.actor ?? VENUS,
      ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}),
    });
  });
}

const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const roleInput = () => screen.getByPlaceholderText('Add a role...') as HTMLInputElement;
const openTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
const groupOf = (testId: string) => screen.getByTestId(testId).closest('section')!;

/** Mount the pane and let its hydration (a GET) answer with `agent`. */
async function openPane(agent = makeAgent()) {
  get.mockResolvedValueOnce(agent);
  const view = render(<AgentView agent={agent} />);
  await advance(0);
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  get.mockReset();
  update.mockReset();
  stub.editing.identity = false;
  stub.editing.systemPrompt = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentView live updates: fields the user is not editing', () => {
  it('shows an agent’s change to the role, identity and system prompt at once, highlighted', async () => {
    await openPane();
    get.mockResolvedValueOnce(
      makeAgent({
        role: 'Reviewer',
        identity: 'New persona',
        rawIdentity: 'New persona',
        systemPrompt: 'Be brief',
        rawSystemPrompt: 'Be brief',
        updatedAt: 'rev-2',
      })
    );

    agentUpdated(['role', 'identity', 'systemPrompt'], { updatedAt: 'rev-2' });
    await advance(200);

    expect(roleInput().value).toBe('Reviewer');
    expect(roleInput().closest('[data-live-updated]')).not.toBeNull();
    openTab('Behavior');
    expect(screen.getByTestId('identity-editor')).toHaveAttribute('data-value', 'New persona');
    expect(screen.getByTestId('system-prompt-editor')).toHaveAttribute('data-value', 'Be brief');
    expect(groupOf('identity-editor')).toHaveAttribute('data-live-updated', 'true');
    expect(groupOf('system-prompt-editor')).toHaveAttribute('data-live-updated', 'true');
    expect(screen.queryByText(/just now/)).toBeNull();

    // The highlight is brief.
    await advance(2000);
    expect(groupOf('identity-editor')).not.toHaveAttribute('data-live-updated');
  });

  it('renames the header and follows the model', async () => {
    await openPane();
    get.mockResolvedValueOnce(makeAgent({ name: 'Ada Prime', updatedAt: 'rev-2' }));

    agentUpdated(['name'], { updatedAt: 'rev-2' });
    await advance(200);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Ada Prime');
  });
});

describe('AgentView live updates: the pane’s own saves', () => {
  it('skips its own save’s echo: same revision, no refetch, no highlight', async () => {
    await openPane();
    update.mockResolvedValue(makeAgent({ role: 'Lead', updatedAt: 'rev-2' }));
    fireEvent.change(roleInput(), { target: { value: 'Lead' } });
    await act(async () => {
      fireEvent.blur(roleInput());
    });
    get.mockClear();

    agentUpdated(['role'], { updatedAt: 'rev-2', actor: ME });
    await advance(500);

    expect(get).not.toHaveBeenCalled();
    expect(roleInput().value).toBe('Lead');
    expect(roleInput().closest('[data-live-updated]')).toBeNull();
    expect(screen.queryByText(/just now/)).toBeNull();
  });

  it('an echo that lands before its save answers does not read as someone else’s change', async () => {
    await openPane();
    let answer: (agent: SnagletAgent) => void = () => undefined;
    update.mockImplementation(() => new Promise<SnagletAgent>((resolve) => (answer = resolve)));
    fireEvent.change(roleInput(), { target: { value: 'Lead' } });
    await act(async () => {
      fireEvent.blur(roleInput());
    });
    get.mockClear();

    agentUpdated(['role'], { updatedAt: 'rev-2', actor: ME });
    await advance(500);
    // The refetch waits for the save.
    expect(get).not.toHaveBeenCalled();

    await act(async () => answer(makeAgent({ role: 'Lead', updatedAt: 'rev-2' })));
    await advance(500);

    expect(get).not.toHaveBeenCalled();
    expect(roleInput().value).toBe('Lead');
    expect(roleInput().closest('[data-live-updated]')).toBeNull();
    expect(screen.queryByText(/just now/)).toBeNull();
  });

  it('a save’s answer brings only the fields it wrote; another writer’s change still arrives as one', async () => {
    await openPane();
    // The server already has Venus's new system prompt when the role save answers.
    update.mockResolvedValue(
      makeAgent({
        role: 'Lead',
        systemPrompt: 'Venus prompt',
        rawSystemPrompt: 'Venus prompt',
        updatedAt: 'rev-3',
      })
    );
    fireEvent.change(roleInput(), { target: { value: 'Lead' } });
    await act(async () => {
      fireEvent.blur(roleInput());
    });
    openTab('Behavior');
    expect(screen.getByTestId('system-prompt-editor')).toHaveAttribute('data-value', 'Old prompt');

    get.mockResolvedValueOnce(
      makeAgent({
        role: 'Lead',
        systemPrompt: 'Venus prompt',
        rawSystemPrompt: 'Venus prompt',
        updatedAt: 'rev-3',
      })
    );
    agentUpdated(['systemPrompt'], { updatedAt: 'rev-2' });
    await advance(200);

    expect(screen.getByTestId('system-prompt-editor')).toHaveAttribute(
      'data-value',
      'Venus prompt'
    );
    expect(groupOf('system-prompt-editor')).toHaveAttribute('data-live-updated', 'true');
  });
});

describe('AgentView live updates: a field the user is editing', () => {
  it('keeps a role draft, says who changed it, and saves nothing until the user picks', async () => {
    await openPane();
    fireEvent.change(roleInput(), { target: { value: 'Lead' } });
    get.mockResolvedValueOnce(makeAgent({ role: 'CTO', updatedAt: 'rev-2' }));

    agentUpdated(['role'], { updatedAt: 'rev-2' });
    await advance(200);

    expect(roleInput().value).toBe('Lead');
    expect(screen.getByText('Updated by Venus just now.')).toBeInTheDocument();
    // The draft's debounce passes: nothing is written over Venus's change.
    await advance(1500);
    expect(update).not.toHaveBeenCalled();
  });

  it('Keep mine saves the role draft', async () => {
    await openPane();
    fireEvent.change(roleInput(), { target: { value: 'Lead' } });
    get.mockResolvedValueOnce(makeAgent({ role: 'CTO', updatedAt: 'rev-2' }));
    agentUpdated(['role'], { updatedAt: 'rev-2' });
    await advance(200);
    update.mockResolvedValue(makeAgent({ role: 'Lead', updatedAt: 'rev-3' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    });
    await advance(0);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('agent-1', { role: 'Lead' });
    expect(screen.queryByText(/just now/)).toBeNull();
    expect(roleInput().value).toBe('Lead');
  });

  it('Reload shows the saved role and drops the draft', async () => {
    await openPane();
    fireEvent.change(roleInput(), { target: { value: 'Lead' } });
    get.mockResolvedValueOnce(makeAgent({ role: 'CTO', updatedAt: 'rev-2' }));
    agentUpdated(['role'], { updatedAt: 'rev-2' });
    await advance(200);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload to see it' }));
    });
    await advance(1500);

    expect(roleInput().value).toBe('CTO');
    expect(update).not.toHaveBeenCalled();
    expect(screen.queryByText(/just now/)).toBeNull();
  });

  it('a focused role with no draft also keeps its text behind the notice', async () => {
    await openPane();
    act(() => roleInput().focus());
    get.mockResolvedValueOnce(makeAgent({ role: 'CTO', updatedAt: 'rev-2' }));

    agentUpdated(['role'], { updatedAt: 'rev-2' });
    await advance(200);

    expect(roleInput().value).toBe('Dev');
    expect(screen.getByText('Updated by Venus just now.')).toBeInTheDocument();
  });

  it('keeps the identity the user is editing and offers the choice; other fields update', async () => {
    await openPane();
    openTab('Behavior');
    stub.editing.identity = true;
    get.mockResolvedValueOnce(
      makeAgent({
        identity: 'Venus persona',
        rawIdentity: 'Venus persona',
        systemPrompt: 'Be brief',
        rawSystemPrompt: 'Be brief',
        updatedAt: 'rev-2',
      })
    );

    agentUpdated(['identity', 'systemPrompt'], { updatedAt: 'rev-2' });
    await advance(200);

    expect(screen.getByTestId('identity-editor')).toHaveAttribute('data-value', 'Old persona');
    expect(screen.getByTestId('identity-editor-conflict')).toHaveTextContent(
      'Venus: Venus persona'
    );
    expect(screen.getByTestId('system-prompt-editor')).toHaveAttribute('data-value', 'Be brief');
    expect(screen.queryByTestId('system-prompt-editor-conflict')).toBeNull();

    // The editor closes with the choice open (a tab switch): its draft is kept.
    act(() => stub.keepDraft.identity?.('My draft'));
    expect(screen.getByTestId('identity-editor')).toHaveAttribute('data-value', 'My draft');
    expect(screen.getByTestId('identity-editor-conflict')).toBeInTheDocument();

    // The user picks (the editor resolves it): the field follows the server again.
    stub.editing.identity = false;
    act(() => stub.resolve.identity?.());
    expect(screen.getByTestId('identity-editor')).toHaveAttribute('data-value', 'Venus persona');
    expect(screen.queryByTestId('identity-editor-conflict')).toBeNull();
  });
});

describe('AgentView live updates: a save made before the change lands', () => {
  it('waits, and is not written over a change it had not seen', async () => {
    await openPane();
    let answer: (agent: SnagletAgent) => void = () => undefined;
    get.mockImplementationOnce(() => new Promise<SnagletAgent>((resolve) => (answer = resolve)));
    // Venus changes the role; the pane's refetch is still on its way...
    agentUpdated(['role'], { updatedAt: 'rev-2' });
    // ...when the user's draft is saved.
    fireEvent.change(roleInput(), { target: { value: 'Lead' } });
    await act(async () => {
      fireEvent.blur(roleInput());
    });
    await advance(200);
    expect(update).not.toHaveBeenCalled();

    await act(async () => answer(makeAgent({ role: 'CTO', updatedAt: 'rev-2' })));
    await advance(1000);

    expect(update).not.toHaveBeenCalled();
    expect(roleInput().value).toBe('Lead');
    expect(screen.getByText('Updated by Venus just now.')).toBeInTheDocument();
  });

  it('goes through once the change lands with nothing to choose', async () => {
    await openPane();
    get.mockResolvedValueOnce(makeAgent({ name: 'Ada Prime', updatedAt: 'rev-2' }));
    update.mockResolvedValue(makeAgent({ name: 'Ada Prime', role: 'Lead', updatedAt: 'rev-3' }));
    // A reconnect holds every text field's saves until the resync lands.
    act(() => emitAgentEvent({ type: 'agents.invalidated' }));
    fireEvent.change(roleInput(), { target: { value: 'Lead' } });
    await act(async () => {
      fireEvent.blur(roleInput());
    });
    expect(update).not.toHaveBeenCalled();

    await advance(200);
    await advance(0);

    expect(update).toHaveBeenCalledWith('agent-1', { role: 'Lead' });
    expect(screen.queryByText(/just now/)).toBeNull();
  });
});

describe('AgentView live updates: Keep mine against a newer change', () => {
  it('keeps a change that arrived while the user was keeping theirs open', async () => {
    await openPane();
    openTab('Behavior');
    stub.editing.identity = true;
    get.mockResolvedValueOnce(
      makeAgent({ identity: 'First', rawIdentity: 'First', updatedAt: 'rev-2' })
    );
    agentUpdated(['identity'], { updatedAt: 'rev-2' });
    await advance(200);
    expect(screen.getByTestId('identity-editor-conflict')).toHaveTextContent('Venus: First');
    const answered: LiveConflict = { remote: 'First', by: 'Venus' };

    get.mockResolvedValueOnce(
      makeAgent({ identity: 'Second', rawIdentity: 'Second', updatedAt: 'rev-3' })
    );
    agentUpdated(['identity'], { updatedAt: 'rev-3' });
    await advance(200);
    expect(screen.getByTestId('identity-editor-conflict')).toHaveTextContent('Venus: Second');

    // The user's Keep mine answered the first change, a different object.
    act(() => stub.resolve.identity?.({ keptOver: answered, kept: 'Mine' }));

    // The newer change is still open, now over the text the user kept.
    expect(screen.getByTestId('identity-editor-conflict')).toHaveTextContent('Venus: Second');
    expect(screen.getByTestId('identity-editor')).toHaveAttribute('data-value', 'Mine');
  });
});

describe('AgentView live updates: which events count', () => {
  it('ignores events for other agents', async () => {
    await openPane();
    get.mockClear();

    agentUpdated(['role', 'systemPrompt'], { agentId: 'agent-2', updatedAt: 'rev-9' });
    await advance(500);

    expect(get).not.toHaveBeenCalled();
  });

  it('makes one refetch for a burst of changes', async () => {
    await openPane();
    get.mockClear();
    get.mockResolvedValue(makeAgent({ role: 'R5', updatedAt: 'rev-6' }));

    for (let i = 2; i <= 6; i += 1) {
      agentUpdated(['role'], { updatedAt: `rev-${i}` });
      await advance(20);
    }
    await advance(300);

    expect(get).toHaveBeenCalledTimes(1);
    expect(roleInput().value).toBe('R5');
  });

  it('a slow first load does not undo a newer change that arrived meanwhile', async () => {
    let answerFirstLoad: (agent: SnagletAgent) => void = () => undefined;
    get.mockImplementationOnce(
      () => new Promise<SnagletAgent>((resolve) => (answerFirstLoad = resolve))
    );
    render(<AgentView agent={makeAgent()} />);
    get.mockResolvedValueOnce(makeAgent({ role: 'Newer', updatedAt: 'rev-3' }));

    agentUpdated(['role'], { updatedAt: 'rev-3' });
    await advance(200);
    expect(roleInput().value).toBe('Newer');

    await act(async () => answerFirstLoad(makeAgent({ role: 'Older', updatedAt: 'rev-2' })));
    expect(roleInput().value).toBe('Newer');
  });

  it('refetches after a reconnect, since missed events are not replayed', async () => {
    await openPane();
    get.mockClear();
    get.mockResolvedValueOnce(makeAgent({ role: 'Changed offline', updatedAt: 'rev-2' }));

    act(() => emitAgentEvent({ type: 'agents.invalidated' }));
    await advance(200);

    expect(get).toHaveBeenCalledTimes(1);
    expect(roleInput().value).toBe('Changed offline');
  });

  it('stops listening once closed', async () => {
    const view = await openPane();
    view.unmount();
    get.mockClear();

    agentUpdated(['role'], { updatedAt: 'rev-2' });
    act(() => emitAgentEvent({ type: 'agents.invalidated' }));
    await advance(500);

    expect(get).not.toHaveBeenCalled();
  });
});

describe('AgentView live updates: deleted and archived', () => {
  it('shows that the agent was deleted, with Close pane', async () => {
    const onClosePane = vi.fn();
    get.mockResolvedValueOnce(makeAgent());
    render(<AgentView agent={makeAgent()} onClosePane={onClosePane} />);
    await advance(0);

    agentUpdated(['deleted']);
    await advance(0);

    expect(screen.getByText('This agent was deleted')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close pane' }));
    expect(onClosePane).toHaveBeenCalledTimes(1);
  });

  it('treats a 404 on refetch as deleted', async () => {
    await openPane();
    get.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));

    agentUpdated(['role'], { updatedAt: 'rev-2' });
    await advance(200);

    expect(screen.getByText('This agent was deleted')).toBeInTheDocument();
  });

  it('says the agent is archived, and drops the note when it is restored', async () => {
    await openPane();
    get.mockResolvedValueOnce(makeAgent({ archived: true }));

    agentUpdated(['archived']);
    await advance(200);
    expect(screen.getByText(/This agent is archived/)).toBeInTheDocument();
    // Its settings stay readable.
    expect(roleInput().value).toBe('Dev');

    get.mockResolvedValueOnce(makeAgent({ archived: false }));
    agentUpdated(['archived']);
    await advance(200);
    expect(screen.queryByText(/This agent is archived/)).toBeNull();
  });
});
