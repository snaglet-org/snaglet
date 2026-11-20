/**
 * ChatSettings / AgentsSection: removing a participant calls `onAgentRemoved`
 * up through ChatSettings, so the chat view's participant count and composer
 * stay in sync (the counterpart of `onAgentAdded`).
 *
 * AgentDetail is stubbed to one button that calls its `onParticipantRemoved`;
 * only the upward callback threading is under test.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { ChatSettings } from './ChatSettings';
import { OpenInSidebarContext } from '../../../chrome/PaneChrome/openInSidebar';
import { threadsApi, agentsApi } from '@desktop/utils/api';
import type { ThreadParticipant } from '@desktop/utils/api';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { AgentEntry } from './settings-types';

vi.mock('@desktop/utils/api', () => ({
  memoriesApi: { listProposed: async () => [] },
  threadsApi: {
    listParticipants: vi.fn(),
  },
  agentsApi: {
    list: vi.fn(),
  },
}));

// Stub out AgentDetail's heavy internals — only its `onParticipantRemoved`
// callback wiring matters for this test.
vi.mock('./AgentDetail.js', () => ({
  AgentDetail: ({
    entry,
    onParticipantRemoved,
  }: {
    entry: AgentEntry;
    onParticipantRemoved: (agentId: string) => void;
  }) => (
    <button onClick={() => onParticipantRemoved(entry.participant.agentId)}>
      {`stub-remove-${entry.participant.agentId}`}
    </button>
  ),
}));

const listParticipants = vi.mocked(threadsApi.listParticipants);
const listAgents = vi.mocked(agentsApi.list);

function participant(agentId: string): ThreadParticipant {
  return {
    id: `p-${agentId}`,
    threadId: 't1',
    memberId: `m-${agentId}`,
    kind: 'agent',
    agentId,
    role: 'participant',
    credentialId: null,
    providerId: null,
    modelId: null,
    addedAt: '',
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

function agent(id: string, name: string): SnagletAgent {
  return { id, name } as unknown as SnagletAgent;
}

beforeEach(() => {
  listParticipants.mockReset();
  listAgents.mockReset();
});

describe('ChatSettings -> AgentsSection remove-participant threading', () => {
  it('calls onAgentRemoved after a participant is removed, so the chat surface can resync without a remount', async () => {
    listParticipants.mockResolvedValue([participant('a1'), participant('a2')]);
    listAgents.mockResolvedValue([agent('a1', 'Alpha'), agent('a2', 'Beta')]);

    const onAgentRemoved = vi.fn();
    const onAgentAdded = vi.fn();
    render(
      <ChatSettings
        threadId="t1"
        focusAgentId="a1"
        onAgentAdded={onAgentAdded}
        onAgentRemoved={onAgentRemoved}
      />
    );

    const removeBtn = await screen.findByRole('button', { name: 'stub-remove-a1' });
    await userEvent.setup().click(removeBtn);

    await waitFor(() => expect(onAgentRemoved).toHaveBeenCalledTimes(1));
    // The add-path callback is untouched by a removal.
    expect(onAgentAdded).not.toHaveBeenCalled();

    // The local list updates too: the removed agent drops
    // out of the sub-sidebar and the remaining one takes over selection.
    expect(screen.queryByRole('button', { name: 'stub-remove-a1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'stub-remove-a2' })).toBeTruthy();
  });

  it('refetches on roster changes, preserves selection, and falls back when it disappears', async () => {
    listParticipants
      .mockResolvedValueOnce([participant('a1'), participant('a2')])
      .mockResolvedValueOnce([participant('a1'), participant('a2'), participant('a3')])
      .mockResolvedValueOnce([participant('a1'), participant('a3')]);
    listAgents.mockResolvedValue([agent('a1', 'Alpha'), agent('a2', 'Beta'), agent('a3', 'Gamma')]);

    const { rerender } = render(
      <ChatSettings threadId="t1" focusAgentId="a2" participantAgentIds={['a1', 'a2']} />
    );
    await screen.findByRole('button', { name: 'stub-remove-a2' });

    rerender(
      <ChatSettings threadId="t1" focusAgentId="a2" participantAgentIds={['a1', 'a2', 'a3']} />
    );
    await waitFor(() => expect(listParticipants).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'stub-remove-a2' })).toBeTruthy();

    rerender(<ChatSettings threadId="t1" focusAgentId="a2" participantAgentIds={['a1', 'a3']} />);
    await waitFor(() => expect(listParticipants).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('button', { name: 'stub-remove-a1' })).toBeTruthy();
  });

  it('labels the participant selector and supports keyboard selection', async () => {
    const user = userEvent.setup();
    listParticipants.mockResolvedValue([participant('a1'), participant('a2')]);
    listAgents.mockResolvedValue([
      { ...agent('a1', 'Alpha'), role: 'Researcher' },
      { ...agent('a2', 'Beta'), role: 'Builder' },
    ]);

    render(<ChatSettings threadId="t1" focusAgentId="a1" />);
    const trigger = await screen.findByRole('button', { name: 'Agent, selected Alpha' });
    expect(screen.getByText('Agent')).toBeInTheDocument();
    // Name primary, role secondary, and the shared leaf caret inside the one
    // clickable control.
    expect(trigger).toHaveTextContent('Alpha');
    expect(trigger).toHaveTextContent('Researcher');
    expect(trigger.querySelector('svg[data-open="false"]')).not.toBeNull();

    trigger.focus();
    await user.keyboard('{ArrowDown}');
    const search = screen.getByRole('searchbox', { name: 'Search thread agents' });
    expect(search).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger.querySelector('svg[data-open="true"]')).not.toBeNull();
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'AAlphaResearcher',
      'BBetaBuilder',
    ]);

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(screen.getByRole('button', { name: 'stub-remove-a2' })).toBeInTheDocument();
  });
});

describe('ChatSettings -> Open in sidebar', () => {
  const pane = { available: true, open: vi.fn(), claim: () => () => undefined };

  it("shows the pane's Open in sidebar above the sections when asked (ChatView)", async () => {
    render(
      <OpenInSidebarContext.Provider value={pane}>
        <ChatSettings
          threadId="t1"
          focusAgentId="a1"
          participantAgentIds={['a1']}
          showOpenInSidebar
        />
      </OpenInSidebarContext.Provider>
    );
    const button = await screen.findByRole('button', { name: 'Open in sidebar' });
    await userEvent.click(button);
    expect(pane.open).toHaveBeenCalledTimes(1);
  });

  it("shows none unless asked, so DmView's home-thread settings never offer the agent pane's item", () => {
    render(
      <OpenInSidebarContext.Provider value={pane}>
        <ChatSettings threadId="t1" focusAgentId="a1" participantAgentIds={['a1']} />
      </OpenInSidebarContext.Provider>
    );
    expect(screen.queryByRole('button', { name: 'Open in sidebar' })).not.toBeInTheDocument();
  });
});
