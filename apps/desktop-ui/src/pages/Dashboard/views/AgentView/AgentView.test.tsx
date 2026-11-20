/**
 * The agent detail pane autosaves with no Save button: the Role field
 * debounces (~800ms) into one PATCH, flushes on blur, and on failure keeps
 * the typed value with a retry; the Model and Tool access editors render in
 * auto-save mode. Children with their own autosave (Identity, System prompt)
 * or heavy imports (VoicePicker, the MCP list) are stubbed; AgentModelEditor
 * and ToolAccessEditor stay real so the "no Save button" check means something.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import { AgentView } from './AgentView';
import { agentsApi } from '@desktop/utils/api';

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

// Stub the WorkspaceEditor-backed and heavy children. The stubs surface
// the `value` prop so tests can pin which channel (raw vs expanded) each
// editor is fed; the Identity tests below depend on it.
vi.mock('./SystemPromptEditor.js', () => ({
  SystemPromptEditor: ({ value }: { value: string }) => (
    <div data-testid="system-prompt-editor" data-value={value} />
  ),
}));
vi.mock('./IdentityEditor.js', () => ({
  IdentityEditor: ({ value }: { value: string }) => (
    <div data-testid="identity-editor" data-value={value} />
  ),
}));
vi.mock('./AgentMcpServers.js', () => ({ AgentMcpServers: () => null }));
// Settings-backed utility-model override — fetches the settings registry on
// mount (not part of the api mock above) and has its own focused suite.
vi.mock('./AgentUtilityModelOverride.js', () => ({ AgentUtilityModelOverride: () => null }));
vi.mock('@desktop/features/voice/index.js', () => ({ VoicePicker: () => null }));

vi.mock('./AgentMemoriesTab', () => ({
  AgentMemoriesTab: ({ agentId }: { agentId: string }) => (
    <div data-testid="agent-memories" data-agent={agentId} />
  ),
}));
vi.mock('./AgentDmsTab', () => ({
  AgentDmsTab: ({ agent }: { agent: { id: string } }) => (
    <div data-testid="agent-dms" data-agent={agent.id} />
  ),
}));
const update = vi.mocked(agentsApi.update);
const get = vi.mocked(agentsApi.get);

function makeAgent(overrides: Partial<SnagletAgent> = {}): SnagletAgent {
  return {
    id: 'agent-1',
    name: 'Ada',
    role: '',
    provider: 'p1',
    modelId: 'm1',
    credentialId: null,
    systemPrompt: '',
    rawSystemPrompt: '',
    identity: '',
    toolAccessMode: null,
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    mcpServers: [],
    disableModelFallback: false,
    ...overrides,
  } as unknown as SnagletAgent;
}

const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  get.mockReset();
  get.mockImplementation(async () => new Promise<SnagletAgent>(() => {}));
  update.mockReset();
  update.mockImplementation(async (_id, patch) => makeAgent(patch as Partial<SnagletAgent>));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function getRoleInput(): HTMLInputElement {
  return screen.getByPlaceholderText('Add a role...') as HTMLInputElement;
}

const openTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

describe('AgentView — Role auto-save', () => {
  it('coalesces a burst of keystrokes into a single debounced PATCH', async () => {
    render(<AgentView agent={makeAgent()} />);
    const input = getRoleInput();

    // A burst of edits, each < 800ms apart, must reset the debounce and NOT
    // fire mid-burst.
    fireEvent.change(input, { target: { value: 'E' } });
    await advance(300);
    fireEvent.change(input, { target: { value: 'Eng' } });
    await advance(300);
    fireEvent.change(input, { target: { value: 'Engineer' } });
    expect(update).not.toHaveBeenCalled();

    await advance(800);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('agent-1', { role: 'Engineer' });
  });

  it('flushes immediately on blur without waiting for the debounce', async () => {
    render(<AgentView agent={makeAgent()} />);
    const input = getRoleInput();

    fireEvent.change(input, { target: { value: 'Lead' } });
    await act(async () => {
      fireEvent.blur(input);
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('agent-1', { role: 'Lead' });
  });

  it('keeps the typed value and surfaces an error (with retry) when the save fails', async () => {
    update.mockRejectedValueOnce(new Error('network down'));
    render(<AgentView agent={makeAgent()} />);
    const input = getRoleInput();

    fireEvent.change(input, { target: { value: 'Boss' } });
    await advance(800);

    // Error surfaced, and the typed value is retained (never reverted).
    expect(screen.getByRole('alert')).toHaveTextContent('network down');
    expect(getRoleInput().value).toBe('Boss');
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();

    // Retry re-arms the same save; this time it succeeds.
    update.mockImplementationOnce(async (_id, patch) => makeAgent(patch as Partial<SnagletAgent>));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    });
    await advance(0);

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith('agent-1', { role: 'Boss' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends null to clear the role when the field is emptied', async () => {
    render(<AgentView agent={makeAgent({ role: 'Dev' })} />);
    const input = getRoleInput();

    fireEvent.change(input, { target: { value: '  ' } });
    await act(async () => {
      fireEvent.blur(input);
    });

    // `undefined` would be dropped from the JSON body and keep the stored role.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('agent-1', { role: null });
    expect(getRoleInput().value).toBe('');
  });

  it('does not write when the field is edited back to its persisted value', async () => {
    render(<AgentView agent={makeAgent({ role: 'Dev' })} />);
    const input = getRoleInput();

    fireEvent.change(input, { target: { value: 'Devs' } });
    fireEvent.change(input, { target: { value: 'Dev' } });
    await advance(800);

    // Guard: 'Dev' trimmed === persisted 'Dev' → no-op, no PATCH.
    expect(update).not.toHaveBeenCalled();
  });
});

describe('AgentView — mount refresh vs. an early save', () => {
  it('keeps a role saved before the slower mount refresh answers', async () => {
    let answerRefresh: (agent: SnagletAgent) => void = () => undefined;
    get.mockImplementation(() => new Promise<SnagletAgent>((resolve) => (answerRefresh = resolve)));
    render(<AgentView agent={makeAgent({ role: 'Dev' })} />);

    fireEvent.change(getRoleInput(), { target: { value: 'Lead' } });
    await act(async () => {
      fireEvent.blur(getRoleInput());
    });
    expect(update).toHaveBeenCalledWith('agent-1', { role: 'Lead' });

    // The refresh was requested before the save, so it carries the previous role.
    await act(async () => {
      answerRefresh(makeAgent({ role: 'Dev' }));
    });

    expect(getRoleInput().value).toBe('Lead');
  });
});

describe('AgentView — no manual Save affordance', () => {
  it('renders no "Save" button anywhere in the pane', async () => {
    render(<AgentView agent={makeAgent()} />);
    // Let the tools fetch settle so ToolAccessEditor is fully rendered.
    await advance(0);
    for (const tab of ['Overview', 'Behavior', 'Capabilities', 'Memories']) {
      openTab(tab);
      expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /saving/i })).toBeNull();
    }
  });
});

describe('AgentView — Memories tab', () => {
  it('is a tab after Capabilities that shows this agent’s memories, and only when opened', async () => {
    const agent = makeAgent();
    render(<AgentView agent={agent} />);
    await advance(0);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Overview',
      'Behavior',
      'Capabilities',
      'Memories',
      'Direct messages',
    ]);
    expect(screen.queryByTestId('agent-memories')).toBeNull();
    const shell = screen.getByRole('tabpanel').parentElement!;
    expect(shell.className).not.toMatch(/shellFixed/);
    openTab('Memories');
    expect(screen.getByTestId('agent-memories')).toHaveAttribute('data-agent', agent.id);
    // The pane stops scrolling on this tab: the memories scroll in their own box.
    expect(shell.className).toMatch(/shellFixed/);
    expect(screen.getByRole('tabpanel').className).toMatch(/panelFill/);
    openTab('Overview');
    expect(shell.className).not.toMatch(/shellFixed/);
  });
});

describe('AgentView — Direct messages tab', () => {
  it('is the last tab, mounts this agent’s DMs only when opened, and fills the pane', async () => {
    const agent = makeAgent();
    render(<AgentView agent={agent} />);
    await advance(0);
    expect(screen.queryByTestId('agent-dms')).toBeNull();
    const shell = screen.getByRole('tabpanel').parentElement!;
    openTab('Direct messages');
    expect(screen.getByTestId('agent-dms')).toHaveAttribute('data-agent', agent.id);
    expect(shell.className).toMatch(/shellFixed/);
    expect(shell).toHaveAttribute('data-fills-host');
    expect(screen.getByRole('tabpanel').className).toMatch(/panelFill/);
    // A list beside a reading pane gets more than the 760px column in a pane.
    expect(screen.getByRole('tabpanel').className).toMatch(/panelWide/);
    openTab('Overview');
    expect(screen.queryByTestId('agent-dms')).toBeNull();
    expect(shell).not.toHaveAttribute('data-fills-host');
  });

  // The preview modal (an agent chip's card) flows to its content, which left
  // the chat with no height: a strip with only its header. On this tab the
  // card fills the modal instead (the modal sizes its frame from
  // `data-fills-host`) and the chat keeps the tabs' column.
  it('in the preview modal, fills the card on this tab only, in the tabs’ column', async () => {
    render(<AgentView agent={makeAgent()} variant="preview" />);
    await advance(0);
    const shell = screen.getByRole('tabpanel').parentElement!;
    expect(shell.className).toMatch(/shellPreview/);
    expect(shell).not.toHaveAttribute('data-fills-host');

    openTab('Direct messages');
    expect(screen.getByTestId('agent-dms')).toBeInTheDocument();
    expect(shell).toHaveAttribute('data-fills-host');
    expect(shell.className).toMatch(/shellPreviewFill/);
    expect(shell.className).not.toMatch(/shellPreview(?!Fill)/);
    expect(shell.className).not.toMatch(/shellFixed/);
    const panel = screen.getByRole('tabpanel');
    expect(panel.className).toMatch(/panelFill/);
    expect(panel.className).not.toMatch(/panelWide/);

    // Memories still flows with the card in the modal.
    openTab('Memories');
    expect(shell).not.toHaveAttribute('data-fills-host');
    expect(shell.className).toMatch(/shellPreview(?!Fill)/);
    expect(screen.getByRole('tabpanel').className).not.toMatch(/panelFill/);
  });
});

describe('AgentView — a navigation that names a tab', () => {
  const selectedTab = () =>
    screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')
      ?.textContent;

  it('opens on the named tab', async () => {
    render(<AgentView agent={makeAgent()} focusTab="memories" focusRequestId={1} />);
    await advance(0);
    expect(selectedTab()).toBe('Memories');
  });

  it('brings Overview up on a page already open on another tab, on every request', async () => {
    const agent = makeAgent();
    const { rerender } = render(<AgentView agent={agent} />);
    await advance(0);
    openTab('Direct messages');
    expect(screen.getByTestId('agent-dms')).toBeTruthy();

    rerender(<AgentView agent={agent} focusTab="overview" focusRequestId={1} />);
    expect(selectedTab()).toBe('Overview');
    expect(screen.queryByTestId('agent-dms')).toBeNull();

    // The same request again (a re-render) leaves the user's tab alone…
    openTab('Direct messages');
    rerender(<AgentView agent={agent} focusTab="overview" focusRequestId={1} />);
    expect(selectedTab()).toBe('Direct messages');

    // …and a new request brings Overview back.
    rerender(<AgentView agent={agent} focusTab="overview" focusRequestId={2} />);
    expect(selectedTab()).toBe('Overview');
  });
});

describe('AgentView — Identity editor raw-value channel', () => {
  // Both the Identity and System prompt editors get the raw stored value. The
  // server-expanded identity (with `![](doc-id)` embeds as `<doc id=…>`
  // markup) is for the model, not the editor.
  it('feeds IdentityEditor rawIdentity (not the expanded identity), mirroring the system prompt', async () => {
    const raw = 'Persona: ![](doc-abc)';
    const expanded = 'Persona: <doc id="doc-abc" path="/Snaglet/sources/persona">…</doc>';
    render(
      <AgentView
        agent={makeAgent({
          identity: expanded,
          rawIdentity: raw,
          systemPrompt: expanded,
          rawSystemPrompt: raw,
        })}
      />
    );
    await advance(0);
    openTab('Behavior');

    expect(screen.getByTestId('identity-editor')).toHaveAttribute('data-value', raw);
    expect(screen.getByTestId('system-prompt-editor')).toHaveAttribute('data-value', raw);
  });

  it('falls back to the expanded identity for legacy payloads without rawIdentity', async () => {
    render(<AgentView agent={makeAgent({ identity: 'plain text persona' })} />);
    await advance(0);
    openTab('Behavior');

    expect(screen.getByTestId('identity-editor')).toHaveAttribute(
      'data-value',
      'plain text persona'
    );
  });
});

describe('AgentView — persisted pane hydration', () => {
  it('replaces a stale persisted snapshot with current server prompt values', async () => {
    get.mockResolvedValue(
      makeAgent({
        identity: 'expanded current identity',
        rawIdentity: 'Current identity ![](doc-identity)',
        systemPrompt: 'expanded current prompt',
        rawSystemPrompt: 'Current prompt ![](doc-system)',
      })
    );

    render(
      <AgentView
        agent={makeAgent({
          identity: 'stale identity',
          rawIdentity: 'stale identity',
          systemPrompt: 'stale prompt',
          rawSystemPrompt: 'stale prompt',
        })}
      />
    );
    await advance(0);

    expect(get).toHaveBeenCalledWith('agent-1');
    openTab('Behavior');
    expect(screen.getByTestId('identity-editor')).toHaveAttribute(
      'data-value',
      'Current identity ![](doc-identity)'
    );
    expect(screen.getByTestId('system-prompt-editor')).toHaveAttribute(
      'data-value',
      'Current prompt ![](doc-system)'
    );
  });
});

describe('AgentView — avatar next to the name', () => {
  it('shows the avatar and one Shuffle avatar button in the header, and no Cursor tab', async () => {
    render(<AgentView agent={makeAgent()} />);
    await advance(0);
    expect(screen.queryByRole('tab', { name: 'Cursor' })).toBeNull();
    expect(screen.getByTestId('agent-avatar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /shuffle avatar/i })).toBeInTheDocument();
    // No emotion or status controls: the avatar is always neutral.
    expect(screen.queryByRole('button', { name: /^happy$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /shuffle (shape|colors)/i })).toBeNull();
  });

  it('saves a new shape and colors together when shuffled', async () => {
    const agent = makeAgent();
    vi.mocked(agentsApi.update).mockResolvedValue(agent);
    render(<AgentView agent={agent} />);
    await advance(0);
    fireEvent.click(screen.getByRole('button', { name: /shuffle avatar/i }));
    await advance(0);
    const call = vi
      .mocked(agentsApi.update)
      .mock.calls.find((c) => (c[1] as { cursorSpec?: unknown }).cursorSpec !== undefined);
    expect(call).toBeDefined();
    const spec = (call![1] as { cursorSpec: { v: number; shape: unknown; colors: unknown } })
      .cursorSpec;
    expect(spec.v).toBe(1);
    expect(spec.shape).toBeTruthy();
    expect(spec.colors).toBeTruthy();
  });
});

describe('AgentView — summary model hint', () => {
  it('shows the optional-model description as a tooltip, not as always-visible text', async () => {
    render(<AgentView agent={makeAgent()} />);
    await advance(0);
    expect(screen.queryByText(/cheaper model to write this agent/i)).toBeNull();
    const trigger = screen.getByRole('button', { name: /about the summary model/i });
    fireEvent.focus(trigger);
    await advance(400);
    expect(screen.getByText(/cheaper model to write this agent/i)).toBeInTheDocument();
  });
});

describe('AgentView — direct messages switch', () => {
  it('AgentView dm_enabled switch calls the update API', async () => {
    render(<AgentView agent={makeAgent()} />);
    await advance(0);
    openTab('Behavior');

    // Absent means on: older payloads carry no dmEnabled.
    const toggle = screen.getByRole('switch', { name: 'Direct messages' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);
    await advance(0);
    expect(update).toHaveBeenCalledWith('agent-1', { dmEnabled: false });
    expect(screen.getByRole('switch', { name: 'Direct messages' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });
});
