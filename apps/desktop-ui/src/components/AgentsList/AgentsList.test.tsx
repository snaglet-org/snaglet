import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { emitAgentEvent } from '@desktop/utils/agentEvents';
import { AgentsList } from './AgentsList';

const listAgents = vi.fn();

vi.mock('@desktop/utils/api', () => ({
  agentsApi: { list: (...args: unknown[]) => listAgents(...args) },
}));

const agent = (role: string): SnagletAgent =>
  ({
    id: 'agent-1',
    name: 'Ada',
    role,
    avatarUrl: null,
  }) as unknown as SnagletAgent;

describe('AgentsList refreshNonce', () => {
  beforeEach(() => {
    listAgents.mockReset();
  });

  it('refetches authoritative agents and visibly repaints a changed role', async () => {
    listAgents.mockResolvedValueOnce([agent('Engineer')]).mockResolvedValueOnce([agent('Lead')]);
    const { rerender } = render(<AgentsList refreshNonce={0} />);

    expect(await screen.findByText('Engineer')).toBeInTheDocument();
    rerender(<AgentsList refreshNonce={1} />);

    expect(await screen.findByText('Lead')).toBeInTheDocument();
    expect(screen.queryByText('Engineer')).toBeNull();
    expect(listAgents).toHaveBeenCalledTimes(2);
  });

  it('refetches after a reconnect: agent changes made while offline are not replayed', async () => {
    listAgents.mockResolvedValueOnce([agent('Engineer')]).mockResolvedValueOnce([agent('Lead')]);
    render(<AgentsList refreshNonce={0} />);
    await screen.findByText('Engineer');

    act(() => emitAgentEvent({ type: 'agents.invalidated' }));

    expect(await screen.findByText('Lead')).toBeInTheDocument();
    expect(listAgents).toHaveBeenCalledTimes(2);
  });

  it('does not refetch for unrelated library events', async () => {
    listAgents.mockResolvedValue([agent('Engineer')]);
    render(<AgentsList refreshNonce={0} />);
    await screen.findByText('Engineer');

    act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: ['doc-1'] }));

    expect(listAgents).toHaveBeenCalledTimes(1);
  });
});

describe('AgentsList avatar', () => {
  beforeEach(() => {
    listAgents.mockReset();
  });

  it("shows the agent's generated flower avatar instead of an initial box", async () => {
    listAgents.mockResolvedValue([agent('Engineer')]);
    render(<AgentsList />);
    await screen.findByText('Engineer');

    const avatar = screen.getByTestId('agent-row-avatar');
    expect(avatar.querySelector('svg')).not.toBeNull();
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
    // No letter avatar.
    expect(screen.queryByText('A')).toBeNull();
    expect(avatar.className).toContain('avatarFlower');
  });

  it('uses a saved avatar spec and gives each agent its own flower', async () => {
    const a = { ...agent('Engineer'), id: 'agent-1' } as SnagletAgent;
    const b = { ...agent('Lead'), id: 'agent-2', name: 'Bo' } as SnagletAgent;
    listAgents.mockResolvedValue([a, b]);
    render(<AgentsList />);
    await screen.findByText('Lead');

    const flowers = screen.getAllByTestId('agent-row-avatar').map((n) => n.innerHTML);
    expect(flowers).toHaveLength(2);
    expect(flowers[0]).not.toEqual(flowers[1]);
  });

  it('still shows an uploaded avatar image when the agent has one', async () => {
    const withImage = {
      ...agent('Engineer'),
      avatarUrl: 'https://example.com/a.png',
    } as SnagletAgent;
    listAgents.mockResolvedValue([withImage]);
    render(<AgentsList />);
    await screen.findByText('Engineer');

    const avatar = screen.getByTestId('agent-row-avatar');
    expect(avatar.querySelector('img')).not.toBeNull();
    expect(avatar.querySelector('svg')).toBeNull();
  });
});
