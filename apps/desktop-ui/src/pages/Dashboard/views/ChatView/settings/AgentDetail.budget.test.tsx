import { useState } from 'react';
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
  WorkspaceEditor: () => null,
  EditorSaveHint: () => null,
  useEditorSaveStatus: () => ({
    status: { state: 'idle', error: null },
    onSaveStateChange: vi.fn(),
  }),
}));
vi.mock('@desktop/components/ToolAccessEditor/index.js', () => ({
  ToolAccessEditor: () => null,
}));
vi.mock('@desktop/components/AgentModelEditor/index.js', () => ({
  AgentModelEditor: () => null,
}));
vi.mock('@desktop/components/AgentConfigCard/index.js', () => ({
  ContextWindowPanel: () => null,
}));
vi.mock('./ThreadUtilityModelOverride', () => ({
  ThreadUtilityModelOverride: () => null,
}));

const AGENT: SnagletAgent = {
  id: 'test-agent-a',
  name: 'Test Agent',
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
  agentId: 'test-agent-a',
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

function Harness() {
  const [participant, setParticipant] = useState(PARTICIPANT);
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
  api.updateParticipantOverrides.mockReset();
  api.updateParticipantOverrides.mockImplementation(
    async (_threadId: string, _agentId: string, patch: Partial<ThreadParticipant>) => ({
      ...PARTICIPANT,
      ...patch,
    })
  );
});

describe('AgentDetail — run time limit', () => {
  it('saves the 15-minute limit the moment Limited is picked', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('radio', { name: 'Limited' }));

    await waitFor(() => expect(api.updateParticipantOverrides).toHaveBeenCalledTimes(1));
    expect(api.updateParticipantOverrides).toHaveBeenCalledWith('thread-1', 'test-agent-a', {
      maxToolCallsPerTurn: null,
      maxDurationSeconds: 900,
    });
  });

  it('saves null the moment Unlimited is picked after a limit', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('radio', { name: 'Limited' }));
    await user.click(screen.getByRole('radio', { name: 'Unlimited' }));

    await waitFor(() => expect(api.updateParticipantOverrides).toHaveBeenCalledTimes(2));
    expect(api.updateParticipantOverrides).toHaveBeenLastCalledWith('thread-1', 'test-agent-a', {
      maxToolCallsPerTurn: null,
      maxDurationSeconds: null,
    });
  });

  it('shows a failed save and puts the saved limit back', async () => {
    api.updateParticipantOverrides.mockRejectedValue(new Error('participant is locked'));
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('radio', { name: 'Limited' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('participant is locked');
    expect(screen.getByRole('radio', { name: 'Unlimited' })).toBeChecked();
  });
});

describe('AgentDetail — budget field names', () => {
  it('names every budget control for assistive tech', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.getByRole('spinbutton', { name: 'Tool calls per turn' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Limited' }));
    expect(screen.getByRole('spinbutton', { name: 'Run time limit amount' })).toHaveValue(15);
    expect(screen.getByRole('combobox', { name: 'Run time limit unit' })).toBeInTheDocument();
  });
});
