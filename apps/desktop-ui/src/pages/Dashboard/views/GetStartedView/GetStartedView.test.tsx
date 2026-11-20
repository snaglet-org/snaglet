/**
 * The Get started pane: step 1 sets the person's name (shared with Home's
 * greeting), provider cards open the provider's own connect panel, a key saved
 * there is tested at once, step 3 gives Patty and Clio a model once a provider
 * is connected, step 4 waits for a passing test, Skip records
 * the choice and opens Patty's thread, and Say hello opens her thread with the
 * Welcome doc beside it. A removed starter agent is never named or opened:
 * with Patty gone the pane greets Clio, and with both gone it creates an agent
 * or starts a thread through the Dashboard's own flows.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { ModelRow, Provider, ProviderCredential } from '@desktop/utils/api';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const server = vi.hoisted(() => ({
  providers: [] as Provider[],
  credentials: [] as ProviderCredential[],
  progress: {} as Record<string, unknown>,
  seed: null as unknown,
  agents: {} as Record<string, Partial<SnagletAgent>>,
  models: [] as Partial<ModelRow>[],
  defaultModel: null as unknown,
  retest: vi.fn(),
  putEntry: vi.fn(),
  updateAgent: vi.fn(),
  userName: 'Test User',
  updateProfile: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({
  userProfileApi: {
    get: async () => ({ id: 'user-1', name: server.userName }),
    update: server.updateProfile,
  },
  settingsApi: {
    get: async (_category: string, key: string) => ({
      value: key === 'seed' ? server.seed : server.progress,
    }),
    putEntry: server.putEntry,
  },
  providersApi: {
    list: async () => server.providers,
    listCredentials: async () => server.credentials,
    retestCredential: server.retest,
    defaultModel: async () => server.defaultModel,
  },
  agentsApi: {
    get: async (id: string) => {
      const agent = server.agents[id];
      if (!agent) throw Object.assign(new Error('Agent not found'), { status: 404 });
      return agent;
    },
    list: async () => Object.values(server.agents).filter((agent) => !agent.archived),
    update: server.updateAgent,
  },
}));

vi.mock('@desktop/components/ModelSelector/ModelSelector', () => ({
  useModelData: () => ({ providers: [], models: server.models, credentials: [], loading: false }),
}));

vi.mock('../ProvidersView/ProviderCatalogContext', () => ({
  useProviderCatalog: () => ({ models: server.models }),
}));

// The real editor is covered by its own tests; this stub shows the value it
// was given and stands in for "a model was picked".
vi.mock('@desktop/components/AgentModelEditor', () => ({
  AgentModelEditor: (props: {
    value: { providerId: string | null; modelId: string | null };
    onSave: (next: {
      providerId: string | null;
      modelId: string | null;
      credentialId: string | null;
    }) => Promise<void>;
  }) => (
    <div data-testid="model-editor">
      {props.value.providerId ?? 'no provider'}/{props.value.modelId ?? 'no model'}
      <button
        type="button"
        onClick={() =>
          void props.onSave({
            providerId: 'openai',
            modelId: 'gpt-mid',
            credentialId: 'cred-openai',
          })
        }
      >
        stub pick model
      </button>
    </div>
  ),
}));

const nav = vi.hoisted(() => ({
  openBeside: vi.fn(),
  openAgentById: vi.fn(),
  openNewAgent: vi.fn(),
  openNewThread: vi.fn(),
}));
vi.mock('../../selection/DashboardNavigationContext', () => ({
  useDashboardNavigation: () => nav,
}));

// The real panel is covered by the Providers view's own tests; this stub
// stands in for "a test passed" and "a key was saved".
vi.mock('../ProvidersView', () => ({
  ProvidersView: (props: {
    providerId: string;
    hideModels?: boolean;
    connectVia?: string;
    onVerified?: (id: string) => void;
    onCredentialsChanged?: (credentials: ProviderCredential[]) => void;
  }) => (
    <div
      data-testid="provider-panel"
      data-provider={props.providerId}
      data-connect-via={props.connectVia ?? 'all'}
    >
      {props.hideModels ? 'keys only' : 'with models'}
      <button type="button" onClick={() => props.onVerified?.(props.providerId)}>
        stub test passes
      </button>
      <button
        type="button"
        onClick={() => {
          server.credentials = [credential('cred-new', props.providerId, 'untested')];
          props.onCredentialsChanged?.(server.credentials);
        }}
      >
        stub save key
      </button>
    </div>
  ),
}));

import { refreshOnboarding } from '@desktop/features/onboarding';
import { emitAgentEvent } from '@desktop/utils/agentEvents';
import { HubHeader } from '../HubView/HubHeader';
import { useHubProfile } from '../HubView/useHubData';
import { GetStartedView } from './GetStartedView';

function provider(id: string, name: string, authType = 'api_key'): Provider {
  return {
    id,
    name,
    description: '',
    website: null,
    apiDocs: null,
    baseUrl: null,
    type: 'llm',
    enabled: true,
    sortOrder: 0,
    primaryCredentialId: null,
    authTypes: [
      {
        id: `${id}:${authType}`,
        name: authType,
        type: authType,
        description: '',
        tokenHelp: 'Get your key at the provider console.',
        sortOrder: 0,
      },
    ],
    defaultMetadata: {},
  };
}

function credential(
  id: string,
  providerId: string,
  verificationStatus: ProviderCredential['verificationStatus']
): ProviderCredential {
  return {
    id,
    providerId,
    authTypeId: `${providerId}:api_key`,
    authType: 'api_key',
    label: 'Test key',
    hasSecret: true,
    updatedAt: '2026-01-01T00:00:00Z',
    verificationStatus,
  };
}

const SEED = {
  status: 'done',
  threads: { patty: 'thread-1111111111111-aaaaaaaaa', clio: 'thread-2222222222222-bbbbbbbbb' },
  docs: { 'welcome-to-snaglet': 'doc-1111111111111-aaaaaaaaa' },
};

function starter(id: string, name: string, model?: [string, string]): Partial<SnagletAgent> {
  return {
    id,
    name,
    provider: model?.[0] ?? '',
    modelId: model?.[1] ?? null,
    credentialId: null,
    archived: false,
  };
}

const SUGGESTION = {
  providerId: 'anthropic',
  modelId: 'claude-mid',
  displayName: 'Claude Mid',
};

async function renderPane() {
  await act(async () => {
    await refreshOnboarding();
  });
  const onReplaceSelection = vi.fn();
  render(<GetStartedView onReplaceSelection={onReplaceSelection} />);
  // The starter agents load on their own; wait for their lines.
  await screen.findByRole('list', { name: 'Starter agent models' });
  return onReplaceSelection;
}

/** The "Choose a model" step. */
function modelStep(): HTMLElement {
  return screen.getByRole('region', { name: /^Choose a model/ });
}

beforeEach(() => {
  server.providers = [
    provider('anthropic', 'Anthropic'),
    provider('openai', 'OpenAI'),
    provider('ollama', 'Ollama', 'none'),
  ];
  server.credentials = [];
  server.progress = {};
  server.seed = SEED;
  server.agents = { patty: starter('patty', 'Patty'), clio: starter('clio', 'Clio') };
  server.models = [
    { providerId: 'anthropic', modelId: 'claude-mid', displayName: 'Claude Mid' },
    { providerId: 'openai', modelId: 'gpt-mid', displayName: 'GPT Mid' },
  ];
  server.defaultModel = null;
  server.retest.mockReset();
  server.putEntry.mockReset();
  server.putEntry.mockImplementation(
    async (_c: string, _k: string, path: string[], value: unknown) => {
      server.progress = { ...server.progress, [path[0]!]: value };
      return server.progress;
    }
  );
  server.updateAgent.mockReset();
  server.updateAgent.mockImplementation(async (id: string, patch: Partial<SnagletAgent>) => {
    server.agents[id] = { ...server.agents[id], ...patch };
    return server.agents[id];
  });
  nav.openBeside.mockReset();
  nav.openAgentById.mockReset();
  nav.openNewAgent.mockReset();
  nav.openNewThread.mockReset();
  server.userName = 'Test User';
  server.updateProfile.mockReset();
  server.updateProfile.mockImplementation(async ({ name }: { name: string }) => {
    server.userName = name;
    return { id: 'user-1', name };
  });
});

describe('GetStartedView', () => {
  it('groups the ways to connect and keeps Say hello waiting until a provider works', async () => {
    await renderPane();
    expect(screen.getByText('Use a subscription you already have')).toBeTruthy();
    expect(screen.getByText('Paste an API key')).toBeTruthy();
    expect(screen.getByText('Run models on this Mac')).toBeTruthy();
    // Cards whose provider is not in the catalog are left out.
    expect(screen.queryByRole('button', { name: /GitHub Copilot/ })).toBeNull();
    const hello = screen.getByRole('button', { name: 'Say hello to Patty' });
    expect((hello as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Connect a provider first.')).toBeTruthy();
  });

  it("opens a card's own connect panel with plain help, keys only for hosted providers", async () => {
    await renderPane();
    fireEvent.click(screen.getByRole('button', { name: /^OpenAI/ }));
    expect(screen.getByText(/Get your key at the provider console\./)).toBeTruthy();
    const panel = screen.getByTestId('provider-panel');
    expect(panel.getAttribute('data-provider')).toBe('openai');
    expect(panel.textContent).toContain('keys only');

    fireEvent.click(screen.getByRole('button', { name: /^Ollama/ }));
    expect(screen.getByTestId('provider-panel').textContent).toContain('with models');
  });

  it('opens the Claude Code card on sign-in only and the Anthropic key card on keys only', async () => {
    await renderPane();
    fireEvent.click(screen.getByRole('button', { name: /^Claude Code/ }));
    let panel = screen.getByTestId('provider-panel');
    expect(panel.getAttribute('data-provider')).toBe('anthropic');
    expect(panel.getAttribute('data-connect-via')).toBe('sign-in');

    fireEvent.click(screen.getByRole('button', { name: /^Anthropic/ }));
    panel = screen.getByTestId('provider-panel');
    expect(panel.getAttribute('data-provider')).toBe('anthropic');
    expect(panel.getAttribute('data-connect-via')).toBe('key');
  });

  it('shows the command to run as code in the Codex help', async () => {
    server.providers = [...server.providers, provider('codex', 'OpenAI Codex')];
    await renderPane();
    fireEvent.click(screen.getByRole('button', { name: /^Codex/ }));
    const command = screen.getByText('codex login');
    expect(command.tagName).toBe('CODE');
    expect(command.parentElement).toHaveTextContent(
      'Run codex login in Terminal first. Then press Use local CLI login'
    );
    expect(screen.getByTestId('provider-panel').getAttribute('data-connect-via')).toBe('all');
  });

  it('tests a key as soon as it is saved and shows why it failed', async () => {
    server.retest.mockResolvedValue({ valid: false, message: 'Invalid API key (401)' });
    await renderPane();
    fireEvent.click(screen.getByRole('button', { name: /^Anthropic/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'stub save key' }));
    });
    await waitFor(() => expect(server.retest).toHaveBeenCalledWith('cred-new'));
    expect(await screen.findByText('Invalid API key (401)')).toBeTruthy();
    expect(screen.getByText('Test failed')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Say hello to Patty' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('enables Say hello once a test passes and opens Patty with the Welcome doc beside', async () => {
    server.credentials = [credential('cred-ok', 'anthropic', 'ok')];
    const onReplaceSelection = await renderPane();
    expect(screen.getByText('Done · Anthropic')).toBeTruthy();
    const hello = screen.getByRole('button', { name: 'Say hello to Patty' });
    expect((hello as HTMLButtonElement).disabled).toBe(false);
    // Patty has no model yet: the step says where to choose one.
    expect(screen.getByText("Choose Patty's model in step 3 first.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(hello);
    });
    expect(onReplaceSelection).toHaveBeenCalledWith({
      kind: 'thread',
      thread_id: SEED.threads.patty,
    });
    expect(nav.openBeside).toHaveBeenCalledWith({
      kind: 'doc',
      doc_id: SEED.docs['welcome-to-snaglet'],
    });
    expect(server.putEntry).toHaveBeenCalledWith(
      'onboarding',
      'progress',
      ['user-1'],
      expect.objectContaining({ pattyOpenedAt: expect.any(String) })
    );
    // Clio is offered once Patty's thread was opened.
    expect(await screen.findByRole('button', { name: 'Open Plan my week' })).toBeTruthy();
  });

  it('offers Clio on the first render, before the starter agents are read', async () => {
    server.credentials = [credential('cred-ok', 'anthropic', 'ok')];
    server.progress = { 'user-1': { pattyOpenedAt: '2026-11-16T10:00:00.000Z' } };
    await act(async () => {
      await refreshOnboarding();
    });
    render(<GetStartedView onReplaceSelection={vi.fn()} />);
    // Nothing awaited yet: the starter agents' read is still in flight.
    expect(screen.getByRole('button', { name: 'Open Plan my week' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Choose a model for Patty and Clio' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Say hello to Patty' })).toBeTruthy();
    await screen.findByRole('list', { name: 'Starter agent models' });
    expect(screen.getByRole('button', { name: 'Open Plan my week' })).toBeTruthy();
  });

  it('records a passed keyless test as ready', async () => {
    await renderPane();
    fireEvent.click(screen.getByRole('button', { name: /^Ollama/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'stub test passes' }));
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Say hello to Patty' }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
    expect(server.putEntry).toHaveBeenCalledWith(
      'onboarding',
      'progress',
      ['user-1'],
      expect.objectContaining({ providerId: 'ollama', providerReadyAt: expect.any(String) })
    );
  });

  it('Skip for now records the choice and opens Patty’s thread', async () => {
    const onReplaceSelection = await renderPane();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    });
    expect(server.putEntry).toHaveBeenCalledWith(
      'onboarding',
      'progress',
      ['user-1'],
      expect.objectContaining({ providerSkippedAt: expect.any(String) })
    );
    expect(onReplaceSelection).toHaveBeenCalledWith({
      kind: 'thread',
      thread_id: SEED.threads.patty,
    });
    expect(await screen.findByText('Skipped')).toBeTruthy();
  });
});

describe('GetStartedView: choose a model', () => {
  it('puts the model step between connecting a provider and saying hello', async () => {
    await renderPane();
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual([
      'Set your name',
      'Connect a provider',
      'Choose a model for Patty and Clio',
      'Say hello to Patty',
    ]);
  });

  it('waits for a provider with a hint and no picker, and still lets the person skip', async () => {
    const onReplaceSelection = await renderPane();
    const step = modelStep();
    expect(within(step).getByText('Connect a provider in step 2 first.')).toBeTruthy();
    expect(within(step).queryByTestId('model-editor')).toBeNull();
    // Each starter agent shows where it stands.
    const lines = within(step).getAllByRole('listitem');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.textContent).toContain('Patty');
    expect(lines[1]?.textContent).toContain('Clio');
    expect(within(step).getAllByText('No model yet')).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    });
    expect(onReplaceSelection).toHaveBeenCalledWith({
      kind: 'thread',
      thread_id: SEED.threads.patty,
    });
  });

  it('offers the suggested model once a provider works and saves it on both only when taken', async () => {
    server.credentials = [credential('cred-ok', 'anthropic', 'ok')];
    server.defaultModel = SUGGESTION;
    await renderPane();
    const step = modelStep();
    expect(await within(step).findByText('Claude Mid · Anthropic')).toBeTruthy();
    // Offered, never saved by itself.
    expect(server.updateAgent).not.toHaveBeenCalled();
    expect(within(step).getByText(/^Suggested/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(step).getByRole('button', { name: 'Use for Patty and Clio' }));
    });
    for (const id of ['patty', 'clio']) {
      expect(server.updateAgent).toHaveBeenCalledWith(id, {
        provider: 'anthropic',
        modelId: 'claude-mid',
        credentialId: null,
      });
    }
    await waitFor(() =>
      expect(within(modelStep()).getAllByText('Claude Mid · Anthropic')).toHaveLength(2)
    );
    expect(within(modelStep()).getByText('Done')).toBeTruthy();
    expect(within(modelStep()).queryByRole('button', { name: /^Use for/ })).toBeNull();
    expect(screen.queryByText("Choose Patty's model in step 3 first.")).toBeNull();
  });

  it('applies a model picked in the shared picker to both agents', async () => {
    server.credentials = [credential('cred-openai', 'openai', 'ok')];
    await renderPane();
    const step = modelStep();
    await act(async () => {
      fireEvent.click(within(step).getByRole('button', { name: 'stub pick model' }));
    });
    expect(server.updateAgent).toHaveBeenCalledTimes(2);
    expect(server.updateAgent).toHaveBeenCalledWith('clio', {
      provider: 'openai',
      modelId: 'gpt-mid',
      credentialId: 'cred-openai',
    });
    await waitFor(() => expect(within(modelStep()).getByText('Done')).toBeTruthy());
  });

  it("keeps an agent's own model and links each agent to its Overview tab", async () => {
    server.credentials = [
      credential('cred-ok', 'anthropic', 'ok'),
      credential('cred-openai', 'openai', 'ok'),
    ];
    server.agents.clio = starter('clio', 'Clio', ['openai', 'gpt-mid']);
    server.defaultModel = SUGGESTION;
    await renderPane();
    const step = modelStep();
    expect(within(step).getByText('GPT Mid · OpenAI')).toBeTruthy();
    // The one-click choice and the picker are Patty's alone now.
    expect(within(step).getByRole('button', { name: 'Use for Patty' })).toBeTruthy();
    expect(within(step).getByText('Model for Patty')).toBeTruthy();

    fireEvent.click(within(step).getByRole('button', { name: "Open Clio's page" }));
    expect(nav.openAgentById).toHaveBeenCalledWith('clio', { tab: 'overview' });
  });

  it("offers Patty's model to Clio, and shows a model adopted elsewhere at once", async () => {
    server.credentials = [credential('cred-ok', 'anthropic', 'ok')];
    server.agents.patty = starter('patty', 'Patty', ['anthropic', 'claude-mid']);
    await renderPane();
    expect(within(modelStep()).getByRole('button', { name: 'Use for Clio' })).toBeTruthy();

    // Clio's first run adopts a model: the step hears about it.
    server.agents.clio = starter('clio', 'Clio', ['anthropic', 'claude-mid']);
    act(() =>
      emitAgentEvent({
        type: 'agent.updated',
        agentId: 'clio',
        changed: ['modelId'],
        ts: '2026-11-16T10:00:00.000Z',
        actor: { actorId: 'agent-clio', actorKind: 'agent', actorName: 'Clio' },
      })
    );
    await waitFor(() => expect(within(modelStep()).getByText('Done')).toBeTruthy());
  });

  it('marks a model whose provider is not connected', async () => {
    server.credentials = [credential('cred-openai', 'openai', 'fail')];
    server.agents.patty = starter('patty', 'Patty', ['openai', 'gpt-mid']);
    await renderPane();
    expect(within(modelStep()).getByText('GPT Mid · OpenAI, not connected')).toBeTruthy();
  });
});

describe('GetStartedView: removed starter agents', () => {
  function archived(id: string, name: string): Partial<SnagletAgent> {
    return { ...starter(id, name), archived: true };
  }

  /** Render with neither starter agent left; waits for the step that replaces the model step. */
  async function renderWithoutStarters() {
    await act(async () => {
      await refreshOnboarding();
    });
    const onReplaceSelection = vi.fn();
    render(<GetStartedView onReplaceSelection={onReplaceSelection} />);
    await screen.findByRole('heading', { level: 2, name: 'Create an agent' });
    return onReplaceSelection;
  }

  function titles(): (string | null)[] {
    return screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  }

  /** Step 3, whatever it is called. */
  function lastStep(): HTMLElement {
    const steps = screen.getAllByRole('region');
    return steps[steps.length - 1]!;
  }

  it('with Patty removed, names only Clio and greets her in Plan my week', async () => {
    server.credentials = [credential('cred-ok', 'anthropic', 'ok')];
    server.agents.patty = archived('patty', 'Patty');
    const onReplaceSelection = await renderPane();
    expect(titles()).toEqual([
      'Set your name',
      'Connect a provider',
      'Choose a model for Clio',
      'Say hello to Clio',
    ]);
    expect(within(modelStep()).getAllByRole('listitem')).toHaveLength(1);
    expect(
      within(modelStep()).getByText(/The choice here sets Clio's model; you can change it later/)
    ).toBeTruthy();
    expect(screen.getByText("Choose Clio's model in step 3 first.")).toBeTruthy();
    expect(document.body.textContent).not.toContain('Patty');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Say hello to Clio' }));
    });
    expect(onReplaceSelection).toHaveBeenCalledWith({
      kind: 'thread',
      thread_id: SEED.threads.clio,
    });
    expect(nav.openBeside).not.toHaveBeenCalled();
    expect(server.putEntry).toHaveBeenCalledWith(
      'onboarding',
      'progress',
      ['user-1'],
      expect.objectContaining({ pattyOpenedAt: expect.any(String) })
    );
    expect(await within(lastStep()).findByText('Done')).toBeTruthy();
    // Clio is the one greeted, so she is not offered again.
    expect(screen.queryByRole('button', { name: 'Open Plan my week' })).toBeNull();
  });

  it("opens Clio's page when the seed made no thread for her", async () => {
    server.credentials = [credential('cred-ok', 'anthropic', 'ok')];
    server.seed = { status: 'done', threads: {} };
    delete server.agents.patty;
    const onReplaceSelection = await renderPane();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Say hello to Clio' }));
    });
    expect(onReplaceSelection).not.toHaveBeenCalled();
    expect(nav.openAgentById).toHaveBeenCalledWith('clio');
  });

  it('with Clio removed, names only Patty and does not offer Clio afterward', async () => {
    server.credentials = [credential('cred-ok', 'anthropic', 'ok')];
    server.agents.clio = archived('clio', 'Clio');
    await renderPane();
    expect(titles()).toEqual([
      'Set your name',
      'Connect a provider',
      'Choose a model for Patty',
      'Say hello to Patty',
    ]);
    expect(document.body.textContent).not.toContain('Clio');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Say hello to Patty' }));
    });
    expect(await within(lastStep()).findByText('Done')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open Plan my week' })).toBeNull();
  });

  it('with both removed and no other agent, offers one Create an agent button, in step 3', async () => {
    server.agents = { patty: archived('patty', 'Patty') };
    const onReplaceSelection = await renderWithoutStarters();
    expect(titles()).toEqual([
      'Set your name',
      'Connect a provider',
      'Create an agent',
      'Start a thread',
    ]);
    const step = screen.getByRole('region', { name: 'Create an agent' });
    expect(within(step).getByText(/^The starter agents were removed\./)).toBeTruthy();
    expect(within(step).queryByText('Done')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Patty|Clio/);
    expect(screen.getAllByRole('button', { name: 'Create an agent' })).toHaveLength(1);

    // Creating an agent needs no provider, and is not the last step's progress.
    fireEvent.click(within(step).getByRole('button', { name: 'Create an agent' }));
    expect(nav.openNewAgent).toHaveBeenCalledTimes(1);
    expect(server.putEntry).not.toHaveBeenCalled();

    // The last step waits for step 3; Skip opens nothing.
    const last = within(lastStep()).getByRole('button', { name: 'Start a thread' });
    expect((last as HTMLButtonElement).disabled).toBe(true);
    expect(within(lastStep()).getByText('Create an agent in step 3 first.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    });
    expect(server.putEntry).toHaveBeenCalledWith(
      'onboarding',
      'progress',
      ['user-1'],
      expect.objectContaining({ providerSkippedAt: expect.any(String) })
    );
    expect(onReplaceSelection).not.toHaveBeenCalled();
    expect(nav.openAgentById).not.toHaveBeenCalled();
  });

  it('with both removed and no other agent, the last step waits for step 3 with a provider too', async () => {
    server.credentials = [credential('cred-ok', 'anthropic', 'ok')];
    server.agents = {};
    await renderWithoutStarters();
    const last = within(lastStep()).getByRole('button', { name: 'Start a thread' });
    expect((last as HTMLButtonElement).disabled).toBe(true);
    expect(within(lastStep()).getByText('Create an agent in step 3 first.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Create an agent' })).toHaveLength(1);
  });

  it('with both removed and an agent with a working model, is done and starts a thread', async () => {
    server.credentials = [credential('cred-ok', 'anthropic', 'ok')];
    server.agents = {
      patty: archived('patty', 'Patty'),
      clio: archived('clio', 'Clio'),
      scout: starter('scout', 'Scout', ['anthropic', 'claude-mid']),
    };
    const onReplaceSelection = await renderWithoutStarters();
    const step = screen.getByRole('region', { name: 'Create an agent' });
    expect(within(step).getByText('Done')).toBeTruthy();
    const line = within(step).getByRole('listitem');
    expect(line.textContent).toContain('Scout');
    expect(within(line).getByText('Claude Mid · Anthropic')).toBeTruthy();
    expect(within(step).queryByRole('button', { name: 'Create an agent' })).toBeNull();
    fireEvent.click(within(step).getByRole('button', { name: "Open Scout's page" }));
    expect(nav.openAgentById).toHaveBeenCalledWith('scout', { tab: 'overview' });
    expect(document.body.textContent).not.toMatch(/Patty|Clio/);

    fireEvent.click(within(lastStep()).getByRole('button', { name: 'Start a thread' }));
    expect(nav.openNewThread).toHaveBeenCalledWith(expect.any(Function));
    expect(nav.openNewAgent).not.toHaveBeenCalled();
    expect(onReplaceSelection).not.toHaveBeenCalled();
    // Nothing counts until the thread is created.
    expect(server.putEntry).not.toHaveBeenCalled();

    const [onCreated] = nav.openNewThread.mock.calls[0] as [() => void];
    await act(async () => {
      onCreated();
    });
    expect(server.putEntry).toHaveBeenCalledWith(
      'onboarding',
      'progress',
      ['user-1'],
      expect.objectContaining({ pattyOpenedAt: expect.any(String) })
    );
    expect(await within(lastStep()).findByText('Done')).toBeTruthy();
  });

  it('with both removed, a canceled new thread records nothing and leaves the step open', async () => {
    server.credentials = [credential('cred-ok', 'anthropic', 'ok')];
    server.agents = { scout: starter('scout', 'Scout', ['anthropic', 'claude-mid']) };
    await renderWithoutStarters();
    // The Dashboard never runs the callback when the picker is canceled.
    fireEvent.click(within(lastStep()).getByRole('button', { name: 'Start a thread' }));
    expect(nav.openNewThread).toHaveBeenCalledTimes(1);
    await act(async () => {
      await refreshOnboarding();
    });
    expect(server.putEntry).not.toHaveBeenCalled();
    expect(within(lastStep()).queryByText('Done')).toBeNull();
    expect(
      (within(lastStep()).getByRole('button', { name: 'Start a thread' }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  it('with both removed, lists a new agent with no model yet, then is done once it has one', async () => {
    server.credentials = [credential('cred-ok', 'anthropic', 'ok')];
    server.agents = { scout: starter('scout', 'Scout') };
    await renderWithoutStarters();
    const step = () => screen.getByRole('region', { name: 'Create an agent' });
    expect(within(step()).queryByText('Done')).toBeNull();
    const line = within(step()).getByRole('listitem');
    expect(line.textContent).toContain('Scout');
    expect(within(line).getByText('No model yet')).toBeTruthy();
    expect(within(line).getByRole('button', { name: "Open Scout's page" })).toBeTruthy();
    expect(within(step()).queryByText(/^The starter agents were removed/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create an agent' })).toBeNull();
    // Another agent with no model yet: the last step starts a thread with it.
    expect(within(lastStep()).getByRole('button', { name: 'Start a thread' })).toBeTruthy();

    server.agents.scout = starter('scout', 'Scout', ['anthropic', 'claude-mid']);
    act(() =>
      emitAgentEvent({
        type: 'agent.updated',
        agentId: 'scout',
        changed: ['modelId'],
        ts: '2026-11-16T10:00:00.000Z',
        actor: { actorId: 'user-1', actorKind: 'user', actorName: 'Test User' },
      })
    );
    await waitFor(() => expect(within(step()).getByText('Done')).toBeTruthy());
    expect(within(step()).getByText('Claude Mid · Anthropic')).toBeTruthy();
  });
});

describe('GetStartedView: your name', () => {
  /** Home's greeting, reading the same profile the pane saves. */
  const Greeting = () => {
    const profile = useHubProfile();
    return (
      <HubHeader
        now={new Date('2026-11-16T15:00:00')}
        status={profile.status}
        name={profile.profile?.name ?? null}
        error={profile.error}
        onSaveName={profile.saveName}
      />
    );
  };

  function nameStep(): HTMLElement {
    return screen.getByRole('region', { name: 'Set your name' });
  }

  async function renderWithGreeting() {
    await act(async () => {
      await refreshOnboarding();
    });
    render(
      <>
        <Greeting />
        <GetStartedView onReplaceSelection={vi.fn()} />
      </>
    );
    await screen.findByRole('list', { name: 'Starter agent models' });
  }

  it('is the open first step with an empty field while the name is the default', async () => {
    server.userName = 'Local User';
    await renderPane();
    await waitFor(() =>
      expect(within(nameStep()).getByRole('textbox', { name: 'Your name' })).toHaveValue('')
    );
    const input = within(nameStep()).getByRole('textbox', { name: 'Your name' });
    expect(input.getAttribute('placeholder')).toBe('Your name');
    expect(within(nameStep()).queryByText(/^Done/)).toBeNull();
    expect(
      within(nameStep()).getByText('Your agents and the workspace call you by this name.')
    ).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 2 })[0]?.textContent).toBe('Set your name');
    // The other steps work as before.
    expect(screen.getByRole('button', { name: 'Say hello to Patty' })).toBeTruthy();
    expect(screen.getByText('Connect a provider in step 2 first.')).toBeTruthy();
  });

  it('saves a name on Enter once, marks the step done, and Home greets the new name', async () => {
    server.userName = 'Local User';
    await renderWithGreeting();
    await screen.findByRole('button', { name: 'Local User, change your name' });
    const input = within(nameStep()).getByRole('textbox', { name: 'Your name' });
    await userEvent.type(input, 'Robin{Enter}');

    await waitFor(() => expect(within(nameStep()).getByText('Done · Robin')).toBeTruthy());
    expect(server.updateProfile).toHaveBeenCalledTimes(1);
    expect(server.updateProfile).toHaveBeenCalledWith({ name: 'Robin' });
    expect(screen.getByRole('button', { name: 'Robin, change your name' })).toBeTruthy();
    expect(within(nameStep()).queryByRole('textbox')).toBeNull();
    // Setting the name is not the end of the first run.
    expect(server.putEntry).not.toHaveBeenCalled();
  });

  it('keeps the step open and says why when the name is refused', async () => {
    server.userName = 'Local User';
    server.updateProfile.mockRejectedValueOnce(
      new Error('That name is reserved and cannot be used')
    );
    await renderPane();
    const input = await within(nameStep()).findByRole('textbox', { name: 'Your name' });
    await userEvent.type(input, 'ghost');
    fireEvent.click(within(nameStep()).getByRole('button', { name: 'Save' }));

    expect(
      await within(nameStep()).findByText('That name is reserved and cannot be used')
    ).toBeTruthy();
    expect(within(nameStep()).getByRole('alert')).toBeTruthy();
    expect(within(nameStep()).queryByText(/^Done/)).toBeNull();
    expect(within(nameStep()).getByRole('textbox', { name: 'Your name' })).toHaveValue('ghost');
  });

  it('does not save an empty name', async () => {
    server.userName = 'Local User';
    await renderPane();
    await waitFor(() =>
      expect(within(nameStep()).getByRole('textbox', { name: 'Your name' })).toHaveValue('')
    );
    fireEvent.click(within(nameStep()).getByRole('button', { name: 'Save' }));
    expect(within(nameStep()).getByText('Your name can’t be empty.')).toBeTruthy();
    expect(server.updateProfile).not.toHaveBeenCalled();
  });

  it('is already done with a name of their own, and changes it inline', async () => {
    server.userName = 'Robin';
    await renderWithGreeting();
    expect(await within(nameStep()).findByText('Done · Robin')).toBeTruthy();
    fireEvent.click(within(nameStep()).getByRole('button', { name: 'Change your name' }));
    const input = within(nameStep()).getByRole('textbox', { name: 'Your name' });
    expect(input).toHaveValue('Robin');

    // Cancel leaves the name as it was.
    fireEvent.click(within(nameStep()).getByRole('button', { name: 'Cancel' }));
    expect(within(nameStep()).queryByRole('textbox')).toBeNull();

    fireEvent.click(within(nameStep()).getByRole('button', { name: 'Change your name' }));
    const again = within(nameStep()).getByRole('textbox', { name: 'Your name' });
    await userEvent.clear(again);
    await userEvent.type(again, 'Robin Gray{Enter}');
    await waitFor(() => expect(within(nameStep()).getByText('Done · Robin Gray')).toBeTruthy());
    expect(server.updateProfile).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Robin Gray, change your name' })).toBeTruthy();
  });
});
