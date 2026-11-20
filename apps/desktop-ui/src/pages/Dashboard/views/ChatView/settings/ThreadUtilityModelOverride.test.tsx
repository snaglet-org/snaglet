/**
 * ThreadUtilityModelOverride: the per-thread-per-agent entry in the
 * agent.thread_summary_model_overrides setting. A save writes only this
 * thread+agent entry (PUT/DELETE of one map entry), never the whole map, so a
 * save from another window is not overwritten. The inherit state shows what
 * the chain below the thread override resolves to.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadUtilityModelOverride } from './ThreadUtilityModelOverride';
import { settingsApi, type SettingsRegistryRecord } from '@desktop/utils/api';

interface Ref {
  providerId: string;
  modelId: string;
  credentialId?: string | null;
}

// Mock the whole api barrel (module-load client config throws under vitest) —
// mirror AgentUtilityModelOverride.test.tsx. The as* narrowers are
// re-implemented minimally; the real ones live in utils/api/settings.ts.
vi.mock('@desktop/utils/api', () => ({
  settingsApi: { registry: vi.fn(), put: vi.fn(), putEntry: vi.fn(), deleteEntry: vi.fn() },
  asAgentUtilityModels: (value: unknown) =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {},
  asThreadAgentUtilityModels: (value: unknown) =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {},
  asUtilityModelRef: (value: unknown) => {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    return typeof v.providerId === 'string' && typeof v.modelId === 'string' ? v : null;
  },
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

function agentRecord(key: string, current: unknown): SettingsRegistryRecord {
  return {
    category: 'agent',
    key,
    description: '',
    valueType: 'object',
    default: {},
    current,
    isOverridden: false,
    updatedAt: null,
    updatedBy: null,
  };
}

const OTHER_THREAD_ENTRY = { 'agent-1': { providerId: 'anthropic', modelId: 'claude-haiku-4-5' } };
const OTHER_AGENT_ENTRY: Ref = { providerId: 'mistral', modelId: 'mistral-small-latest' };

function seedRegistry({
  threadMap = {
    'thread-other': OTHER_THREAD_ENTRY,
    'thread-1': {
      'agent-other': OTHER_AGENT_ENTRY,
      'agent-1': {
        providerId: 'ollama',
        modelId: 'llama3.2:1b',
        credentialId: 'cred-ollama',
      },
    },
  },
  agentMap = {},
}: {
  threadMap?: Record<string, Record<string, Ref>>;
  agentMap?: Record<string, Ref>;
} = {}) {
  registry.mockResolvedValue([
    agentRecord('thread_summary_model_overrides', threadMap),
    agentRecord('summary_model_overrides', agentMap),
  ]);
}

const baseProps = {
  threadId: 'thread-1',
  agentId: 'agent-1',
  agentName: 'Clio',
  agentModel: { providerId: 'anthropic', modelId: 'claude-opus-4-6' },
};

beforeEach(() => {
  registry.mockReset();
  put.mockReset();
  putEntry.mockReset();
  deleteEntry.mockReset();
  put.mockResolvedValue(undefined);
  putEntry.mockResolvedValue({});
  deleteEntry.mockResolvedValue({});
  seedRegistry();
});

describe('ThreadUtilityModelOverride', () => {
  it("seeds the editor from this thread+agent's entry in the nested map", async () => {
    render(<ThreadUtilityModelOverride {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByTestId('override-value')).toHaveTextContent(
        'ollama/llama3.2:1b/cred-ollama'
      )
    );
  });

  it('labels the unset option "Inherit agent setting" when nothing resolves', async () => {
    seedRegistry({
      threadMap: {},
      agentMap: {},
    });
    render(
      <ThreadUtilityModelOverride {...baseProps} agentModel={{ providerId: null, modelId: null }} />
    );
    await waitFor(() =>
      expect(screen.getByTestId('empty-option-label')).toHaveTextContent('Inherit agent setting')
    );
  });

  it('labels the unset option with the resolved default when it names the agent model', async () => {
    render(<ThreadUtilityModelOverride {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByTestId('empty-option-label')).toHaveTextContent(
        'Default: claude-opus-4-6 (the agent model)'
      )
    );
  });

  it("without an entry, shows that inherit resolves to the agent's own model", async () => {
    seedRegistry({ threadMap: {} });
    render(<ThreadUtilityModelOverride {...baseProps} />);
    await waitFor(() =>
      expect(
        screen.getByText(/Inheriting claude-opus-4-6 \(the agent model\)\./)
      ).toBeInTheDocument()
    );
  });

  it('an agent-level override wins the inherit display over the agent model', async () => {
    seedRegistry({
      threadMap: {},
      agentMap: { 'agent-1': { providerId: 'anthropic', modelId: 'claude-haiku-4-5' } },
    });
    render(<ThreadUtilityModelOverride {...baseProps} />);
    await waitFor(() =>
      expect(
        screen.getByText(/Inheriting claude-haiku-4-5 \(agent setting\)\./)
      ).toBeInTheDocument()
    );
  });

  it('hands the resolved inherit target to the editor as fallback (agent model tier)', async () => {
    seedRegistry({ threadMap: {} });
    render(<ThreadUtilityModelOverride {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByTestId('fallback-value')).toHaveTextContent(
        'anthropic/claude-opus-4-6/unset'
      )
    );
  });

  it('an agent-level override (with its credential) wins the fallback prefill', async () => {
    seedRegistry({
      threadMap: {},
      agentMap: {
        'agent-1': {
          providerId: 'anthropic',
          modelId: 'claude-haiku-4-5',
          credentialId: 'cred-agent',
        },
      },
    });
    render(<ThreadUtilityModelOverride {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByTestId('fallback-value')).toHaveTextContent(
        'anthropic/claude-haiku-4-5/cred-agent'
      )
    );
  });

  it('passes no fallback when nothing resolves', async () => {
    seedRegistry({ threadMap: {}, agentMap: {} });
    render(
      <ThreadUtilityModelOverride {...baseProps} agentModel={{ providerId: null, modelId: null }} />
    );
    await waitFor(() => expect(screen.getByTestId('fallback-value')).toHaveTextContent('none'));
  });

  it("writes only this thread+agent's entry on save — never the whole map", async () => {
    render(<ThreadUtilityModelOverride {...baseProps} />);
    await waitFor(() => expect(screen.getByTestId('override-value')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'pick-model' }));

    await waitFor(() =>
      expect(putEntry).toHaveBeenCalledWith(
        'agent',
        'thread_summary_model_overrides',
        ['thread-1', 'agent-1'],
        { providerId: 'anthropic', modelId: 'claude-haiku-4-5', credentialId: 'cred-anthropic' }
      )
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("removes only this thread+agent's entry on reset", async () => {
    render(<ThreadUtilityModelOverride {...baseProps} />);
    await waitFor(() => expect(screen.getByTestId('override-value')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'reset-override' }));

    await waitFor(() =>
      expect(deleteEntry).toHaveBeenCalledWith('agent', 'thread_summary_model_overrides', [
        'thread-1',
        'agent-1',
      ])
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('shows the map the server returns after a save', async () => {
    deleteEntry.mockResolvedValue({ 'thread-other': OTHER_THREAD_ENTRY });
    render(<ThreadUtilityModelOverride {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByTestId('override-value')).toHaveTextContent(
        'ollama/llama3.2:1b/cred-ollama'
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'reset-override' }));

    await waitFor(() =>
      expect(screen.getByTestId('override-value')).toHaveTextContent('unset/unset/unset')
    );
  });
});
