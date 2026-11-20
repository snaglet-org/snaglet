import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsView } from './AgentsView';

const agentsApi = { list: vi.fn(), create: vi.fn() };
const agentsListRender = vi.hoisted(() => vi.fn());

vi.mock('@desktop/utils/api', () => ({
  agentsApi: {
    list: (...a: unknown[]) => agentsApi.list(...a),
    create: (...a: unknown[]) => agentsApi.create(...a),
  },
}));

vi.mock('@desktop/components/AgentsList/index.js', () => ({
  AgentsList: (props: unknown) => {
    agentsListRender(props);
    return <div data-testid="agents-list" />;
  },
}));

describe('AgentsView', () => {
  beforeEach(() => {
    agentsApi.list.mockReset().mockResolvedValue([]);
    agentsApi.create.mockReset();
    agentsListRender.mockClear();
  });

  it('does not open the create modal on first render', async () => {
    render(<AgentsView onAgentClick={vi.fn()} selectedAgentId={null} />);

    await screen.findByTestId('agents-list');
    expect(screen.queryByText('New agent')).toBeNull();
  });

  it('forwards the workspace agent refresh revision to AgentsList', async () => {
    const { rerender } = render(
      <AgentsView onAgentClick={vi.fn()} selectedAgentId={null} refreshNonce={0} />
    );
    await screen.findByTestId('agents-list');

    rerender(<AgentsView onAgentClick={vi.fn()} selectedAgentId={null} refreshNonce={1} />);

    expect(agentsListRender).toHaveBeenLastCalledWith(expect.objectContaining({ refreshNonce: 1 }));
  });
});
