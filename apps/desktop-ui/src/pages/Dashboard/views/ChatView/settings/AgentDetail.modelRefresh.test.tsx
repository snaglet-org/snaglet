import { useState, type ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { ThreadParticipant } from '@desktop/utils/api';
import { AgentDetail } from './AgentDetail';

const api = vi.hoisted(() => ({
  setParticipantModel: vi.fn(),
  removeParticipant: vi.fn(),
  updateParticipantOverrides: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({ threadsApi: api }));
vi.mock('@desktop/hooks/useToolOptions.js', () => ({
  useToolOptions: () => [],
  toolAccessOf: () => ({ mode: 'all', allowList: [], denyList: [] }),
}));
vi.mock('@desktop/features/rich-markdown/workspace-editor/index.js', () => ({
  WorkspaceEditor: ({ kind }: { kind: string }) => <div data-testid={`editor-${kind}`} />,
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
  ToolAccessEditor: () => null,
}));

vi.mock('@desktop/components/AgentModelEditor/index.js', () => ({
  AgentModelEditor: ({
    onSave,
    headerSlot,
  }: {
    onSave: (next: {
      providerId: string | null;
      modelId: string | null;
      credentialId: string | null;
      disableFallback: boolean;
    }) => Promise<void>;
    headerSlot?: ReactNode;
  }) => {
    const [error, setError] = useState<string | null>(null);
    const save = (providerId: string | null, modelId: string | null) => {
      setError(null);
      void onSave({ providerId, modelId, credentialId: null, disableFallback: false }).catch(
        (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))
      );
    };
    return (
      <div>
        {headerSlot}
        <button type="button" onClick={() => save('provider-a', 'model-b')}>
          Save model B
        </button>
        <button type="button" onClick={() => save('provider-b', 'model-b')}>
          Save provider B
        </button>
        <button type="button" onClick={() => save(null, null)}>
          Reset model
        </button>
        {error && <span>{error}</span>}
      </div>
    );
  },
}));

vi.mock('@desktop/components/AgentConfigCard/index.js', () => ({
  ContextWindowPanel: ({
    effectiveModel,
  }: {
    effectiveModel: { providerId: string; modelId: string } | null;
  }) => (
    <div data-testid="context-model">
      {effectiveModel ? `${effectiveModel.providerId}/${effectiveModel.modelId}` : 'unavailable'}
    </div>
  ),
}));

vi.mock('./ThreadUtilityModelOverride', () => ({
  ThreadUtilityModelOverride: ({
    agentModel,
  }: {
    agentModel: { providerId: string | null; modelId: string | null };
  }) => <div data-testid="summary-model">{`${agentModel.providerId}/${agentModel.modelId}`}</div>,
}));

const AGENT: SnagletAgent = {
  id: 'agent-1',
  name: 'Ada',
  role: 'Engineer',
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
};

const PARTICIPANT: ThreadParticipant = {
  id: 'participant-1',
  threadId: 'thread-1',
  memberId: 'member-1',
  kind: 'agent',
  agentId: 'agent-1',
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

function Harness({ initialParticipant = PARTICIPANT }: { initialParticipant?: ThreadParticipant }) {
  const [participant, setParticipant] = useState(initialParticipant);
  return (
    <AgentDetail
      entry={{ participant, agent: AGENT }}
      threadId="thread-1"
      onParticipantUpdated={setParticipant}
      onParticipantRemoved={vi.fn()}
    />
  );
}

beforeEach(() => {
  api.setParticipantModel.mockReset();
  api.removeParticipant.mockReset();
  api.updateParticipantOverrides.mockReset();
});

describe('AgentDetail context-window model identity', () => {
  it('updates after model and provider saves, then returns to the agent default on reset', async () => {
    const user = userEvent.setup();
    api.setParticipantModel.mockImplementation(
      async (_threadId: string, _agentId: string, next: Partial<ThreadParticipant>) => ({
        ...PARTICIPANT,
        ...next,
      })
    );
    render(<Harness />);

    expect(screen.getByTestId('context-model')).toHaveTextContent('provider-a/model-a');
    await user.click(screen.getByRole('button', { name: 'Save model B' }));
    await waitFor(() =>
      expect(screen.getByTestId('context-model')).toHaveTextContent('provider-a/model-b')
    );

    await user.click(screen.getByRole('button', { name: 'Save provider B' }));
    await waitFor(() =>
      expect(screen.getByTestId('context-model')).toHaveTextContent('provider-b/model-b')
    );

    await user.click(screen.getByRole('button', { name: 'Reset model' }));
    await waitFor(() =>
      expect(screen.getByTestId('context-model')).toHaveTextContent('provider-a/model-a')
    );
    expect(api.setParticipantModel).toHaveBeenCalledTimes(3);
  });

  it('keeps the persisted effective budget key when saving the pending model fails', async () => {
    const user = userEvent.setup();
    api.setParticipantModel.mockRejectedValue(new Error('save rejected'));
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Save model B' }));

    expect(await screen.findByText('save rejected')).toBeInTheDocument();
    expect(screen.getByTestId('context-model')).toHaveTextContent('provider-a/model-a');
    expect(screen.getByTestId('summary-model')).toHaveTextContent('provider-a/model-a');
  });

  it('hydrates the persisted thread override on reload without changing summary override wiring', () => {
    render(
      <Harness
        initialParticipant={{
          ...PARTICIPANT,
          providerId: 'provider-b',
          modelId: 'model-b',
        }}
      />
    );

    expect(screen.getByTestId('context-model')).toHaveTextContent('provider-b/model-b');
    expect(screen.getByTestId('summary-model')).toHaveTextContent('provider-b/model-b');
    expect(api.setParticipantModel).not.toHaveBeenCalled();
  });
});

describe('AgentDetail thread instructions disclosure', () => {
  it('appears first, defaults closed, and reveals the editor from the leaf-toggle row', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const toggle = screen.getByRole('button', { name: /thread instructions.*using defaults/i });
    const modelHeading = screen.getByRole('heading', { name: 'Model' });
    expect(toggle.compareDocumentPosition(modelHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('editor-agent-thread-prompt')).toBeNull();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('editor-agent-thread-prompt')).toBeInTheDocument();
  });

  it('reports custom instructions in the collapsed row', () => {
    render(
      <Harness initialParticipant={{ ...PARTICIPANT, systemPromptAddendum: 'Be concise.' }} />
    );

    expect(
      screen.getByRole('button', { name: /thread instructions.*custom instructions/i })
    ).toHaveAttribute('aria-expanded', 'false');
  });
});
