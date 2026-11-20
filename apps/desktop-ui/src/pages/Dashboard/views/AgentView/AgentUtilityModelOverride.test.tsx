/**
 * AgentUtilityModelOverride — the per-agent entry in the map-valued
 * agent.summary_model_overrides setting. Pins that a save writes only this
 * agent's entry (PUT/DELETE of one map entry), never the whole map loaded at
 * mount — so a save from another window is not overwritten — and that the
 * displayed state follows the map the server returns.
 *
 * Also pins the inherited-default display: the component fetches the agent's
 * own main model and hands it to AgentModelEditor as `fallback`, so the
 * no-override state (including right after a reset) shows the inherited
 * provider/model instead of blank fields, and a workspace `agent.updated`
 * event refetches so a main-model edit updates the display live.
 */
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentUtilityModelOverride } from './AgentUtilityModelOverride';
import { settingsApi, agentsApi, type SettingsRegistryRecord } from '@desktop/utils/api';
import type { SnagletAgent } from '@snaglet/shared/types';

// Mock the whole api barrel (module-load client config throws under vitest) —
// mirror ContextSection.test.tsx. asAgentUtilityModels is re-implemented
// minimally; the real one lives in utils/api/settings.ts.
vi.mock('@desktop/utils/api', () => ({
  settingsApi: { registry: vi.fn(), put: vi.fn(), putEntry: vi.fn(), deleteEntry: vi.fn() },
  agentsApi: { get: vi.fn() },
  asAgentUtilityModels: (value: unknown) =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {},
  asUtilityModelRef: (value: unknown) => {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    return typeof v.providerId === 'string' && typeof v.modelId === 'string' ? v : null;
  },
}));

// Stable WS context: identity-stable functions so the component's effects run
// once, plus a captured-listener list the tests can push frames through.
const ws = vi.hoisted(() => {
  const listeners: Array<(message: unknown) => void> = [];
  return {
    listeners,
    ctx: {
      subscribe: () => {},
      unsubscribe: () => {},
      connectionState: 'open',
      addMessageListener: (fn: (message: unknown) => void) => {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
  };
});

vi.mock('@desktop/ws/useWs', () => ({ useWs: () => ws.ctx }));

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
    emptyOptionLabel,
  }: {
    value: EditorValue;
    fallback?: EditorValue;
    onSave: (next: EditorValue) => Promise<void>;
    emptyOptionLabel?: string;
  }) => (
    <div>
      <div data-testid="override-value">
        {value.providerId ?? 'unset'}/{value.modelId ?? 'unset'}/{value.credentialId ?? 'unset'}
      </div>
      <div data-testid="fallback-value">
        {fallback
          ? `${fallback.providerId ?? 'unset'}/${fallback.modelId ?? 'unset'}/${
              fallback.credentialId ?? 'unset'
            }`
          : 'none'}
      </div>
      <div data-testid="empty-option-label">{emptyOptionLabel ?? ''}</div>
      <button
        type="button"
        onClick={() =>
          void onSave({
            providerId: 'anthropic',
            modelId: 'claude-haiku-4-5',
            credentialId: 'cred-anthropic',
          })
        }
      >
        pick-model
      </button>
      <button
        type="button"
        onClick={() => void onSave({ providerId: null, modelId: null, credentialId: null })}
      >
        reset-override
      </button>
    </div>
  ),
}));

const registry = vi.mocked(settingsApi.registry);
const put = vi.mocked(settingsApi.put);
const putEntry = vi.mocked(settingsApi.putEntry);
const deleteEntry = vi.mocked(settingsApi.deleteEntry);
const getAgent = vi.mocked(agentsApi.get);

function overridesRecord(current: unknown): SettingsRegistryRecord {
  return {
    category: 'agent',
    key: 'summary_model_overrides',
    description: '',
    valueType: 'object',
    default: {},
    current,
    isOverridden: false,
    updatedAt: null,
    updatedBy: null,
  };
}

function makeAgent(overrides: Partial<SnagletAgent> = {}): SnagletAgent {
  return {
    id: 'agent-1',
    name: 'Clio',
    provider: 'anthropic',
    modelId: 'claude-opus-4-6',
    credentialId: 'cred-main',
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
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archived: false,
    archivedAt: null,
    ...overrides,
  };
}

const OTHER_ENTRY = { providerId: 'anthropic', modelId: 'claude-haiku-4-5' };

/** A valid workspace-channel agent.updated frame for the captured listeners. */
function agentUpdatedFrame(agentId: string) {
  return {
    channel: 'workspace',
    type: 'workspace_event',
    payload: {
      type: 'agent.updated',
      agentId,
      changed: [],
      ts: '2026-08-19T00:00:00.000Z',
      actor: { actorId: 'user-1', actorKind: 'user' },
    },
  };
}

beforeEach(() => {
  registry.mockReset();
  put.mockReset();
  putEntry.mockReset();
  deleteEntry.mockReset();
  getAgent.mockReset();
  ws.listeners.length = 0;
  put.mockResolvedValue(undefined);
  putEntry.mockResolvedValue({});
  deleteEntry.mockResolvedValue({});
  getAgent.mockResolvedValue(makeAgent());
  registry.mockResolvedValue([
    overridesRecord({
      'agent-other': OTHER_ENTRY,
      'agent-1': {
        providerId: 'ollama',
        modelId: 'llama3.2:1b',
        credentialId: 'cred-ollama',
      },
    }),
  ]);
});

describe('AgentUtilityModelOverride', () => {
  it("seeds the editor from this agent's entry in the map", async () => {
    render(<AgentUtilityModelOverride agentId="agent-1" />);
    await waitFor(() =>
      expect(screen.getByTestId('override-value')).toHaveTextContent(
        'ollama/llama3.2:1b/cred-ollama'
      )
    );
  });

  it('shows no override for an agent without an entry', async () => {
    render(<AgentUtilityModelOverride agentId="agent-2" />);
    await waitFor(() =>
      expect(screen.getByTestId('override-value')).toHaveTextContent('unset/unset')
    );
  });

  it('labels the unset option "Same as agent model" — the agent\'s own model is the default', async () => {
    render(<AgentUtilityModelOverride agentId="agent-2" />);
    await waitFor(() =>
      expect(screen.getByTestId('empty-option-label')).toHaveTextContent('Same as agent model')
    );
  });

  it("hands the agent's main model to the editor as the inherited fallback", async () => {
    render(<AgentUtilityModelOverride agentId="agent-1" />);
    await waitFor(() =>
      expect(screen.getByTestId('fallback-value')).toHaveTextContent(
        'anthropic/claude-opus-4-6/cred-main'
      )
    );
  });

  it('without an override, says it is inheriting the agent model by name', async () => {
    registry.mockResolvedValue([overridesRecord({})]);
    render(<AgentUtilityModelOverride agentId="agent-1" />);
    await waitFor(() =>
      expect(
        screen.getByText(/Inheriting claude-opus-4-6 from the agent model\./)
      ).toBeInTheDocument()
    );
  });

  it('refetches the inherited model when a workspace agent.updated event names this agent', async () => {
    render(<AgentUtilityModelOverride agentId="agent-1" />);
    await waitFor(() => expect(getAgent).toHaveBeenCalledTimes(1));

    getAgent.mockResolvedValue(
      makeAgent({ provider: 'openai', modelId: 'gpt-5', credentialId: null })
    );
    act(() => {
      for (const listener of [...ws.listeners]) listener(agentUpdatedFrame('agent-1'));
    });

    await waitFor(() =>
      expect(screen.getByTestId('fallback-value')).toHaveTextContent('openai/gpt-5/unset')
    );
  });

  it('rereads the override when the setting changes elsewhere (an agent tool, another window)', async () => {
    render(<AgentUtilityModelOverride agentId="agent-1" />);
    await waitFor(() =>
      expect(screen.getByTestId('override-value')).toHaveTextContent(
        'ollama/llama3.2:1b/cred-ollama'
      )
    );

    registry.mockResolvedValue([
      overridesRecord({
        'agent-1': { providerId: 'openai', modelId: 'gpt-5-mini', credentialId: 'cred-o' },
      }),
    ]);
    act(() => {
      for (const listener of [...ws.listeners]) {
        listener({
          channel: 'settings',
          type: 'settings:changed',
          payload: { category: 'agent', key: 'summary_model_overrides' },
        });
      }
    });

    await waitFor(() =>
      expect(screen.getByTestId('override-value')).toHaveTextContent('openai/gpt-5-mini/cred-o')
    );
  });

  it('ignores other settings changing', async () => {
    render(<AgentUtilityModelOverride agentId="agent-1" />);
    await waitFor(() => expect(registry).toHaveBeenCalledTimes(1));

    act(() => {
      for (const listener of [...ws.listeners]) {
        listener({
          channel: 'settings',
          type: 'settings:changed',
          payload: { category: 'appearance', key: 'colors' },
        });
      }
    });

    expect(registry).toHaveBeenCalledTimes(1);
  });

  it('ignores agent.updated events for OTHER agents — no refetch, display unchanged', async () => {
    render(<AgentUtilityModelOverride agentId="agent-1" />);
    await waitFor(() => expect(getAgent).toHaveBeenCalledTimes(1));

    act(() => {
      for (const listener of [...ws.listeners]) listener(agentUpdatedFrame('agent-other'));
    });

    expect(getAgent).toHaveBeenCalledTimes(1);
  });

  it("writes only this agent's entry on save — never the whole map", async () => {
    render(<AgentUtilityModelOverride agentId="agent-1" />);
    await waitFor(() => expect(screen.getByTestId('override-value')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'pick-model' }));

    await waitFor(() =>
      expect(putEntry).toHaveBeenCalledWith('agent', 'summary_model_overrides', ['agent-1'], {
        providerId: 'anthropic',
        modelId: 'claude-haiku-4-5',
        credentialId: 'cred-anthropic',
      })
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("removes only this agent's entry on reset", async () => {
    render(<AgentUtilityModelOverride agentId="agent-1" />);
    await waitFor(() => expect(screen.getByTestId('override-value')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'reset-override' }));

    await waitFor(() =>
      expect(deleteEntry).toHaveBeenCalledWith('agent', 'summary_model_overrides', ['agent-1'])
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('shows the map the server returns, including entries saved from another window', async () => {
    putEntry.mockResolvedValue({
      'agent-other': { providerId: 'mistral', modelId: 'mistral-small-latest' },
      'agent-1': { providerId: 'anthropic', modelId: 'claude-haiku-4-5', credentialId: 'cred-a' },
    });
    render(<AgentUtilityModelOverride agentId="agent-1" />);
    await waitFor(() => expect(screen.getByTestId('override-value')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'pick-model' }));

    await waitFor(() =>
      expect(screen.getByTestId('override-value')).toHaveTextContent(
        'anthropic/claude-haiku-4-5/cred-a'
      )
    );
  });
});
