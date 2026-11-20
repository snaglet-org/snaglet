import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentStatusBubbles } from './AgentStatusBubbles';

describe('AgentStatusBubbles', () => {
  it('stops only the selected running agent and marks it pending', async () => {
    const user = userEvent.setup();
    const onStopAgent = vi.fn();
    render(
      <AgentStatusBubbles
        statuses={
          new Map([
            ['agent-a', 'tool_running'],
            ['agent-b', 'typing'],
          ])
        }
        agentNameById={
          new Map([
            ['agent-a', 'Venus'],
            ['agent-b', 'Mars'],
          ])
        }
        onStopAgent={onStopAgent}
      />
    );

    const stopVenus = screen.getByRole('button', { name: 'Stop Venus run' });
    await user.click(stopVenus);

    expect(onStopAgent).toHaveBeenCalledOnce();
    expect(onStopAgent).toHaveBeenCalledWith('agent-a');
    expect(stopVenus).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop Mars run' })).toBeEnabled();
  });

  it('does not offer Stop while an agent is compacting', () => {
    render(
      <AgentStatusBubbles
        statuses={new Map([['agent-a', 'compacting']])}
        agentNameById={new Map([['agent-a', 'Venus']])}
        onStopAgent={vi.fn()}
      />
    );

    expect(screen.getByText('compacting…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop Venus run' })).not.toBeInTheDocument();
  });

  it('labels a queued run and offers no Stop before it starts', () => {
    render(
      <AgentStatusBubbles
        statuses={new Map([['agent-a', 'queued']])}
        agentNameById={new Map([['agent-a', 'Venus']])}
        onStopAgent={vi.fn()}
      />
    );

    expect(screen.getByText('[Venus]')).toBeInTheDocument();
    expect(screen.getByText('queued…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop Venus run' })).not.toBeInTheDocument();
  });
});
