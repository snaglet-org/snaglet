import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ToolConfirmationRequestPayload } from '@snaglet/shared/types';
import { ToolConfirmationPrompt } from './ToolConfirmationPrompt';

const request: ToolConfirmationRequestPayload = {
  threadId: 'thread-1',
  sessionId: 'session-1',
  callId: 'call-1',
  agentId: 'agent-1',
  toolName: 'shell_exec',
  mode: 'approval',
  inputSummary: '{\n  "command": "git status"\n}',
};

describe('ToolConfirmationPrompt', () => {
  it('shows the proposed tool and approves the matching call', async () => {
    const onRespond = vi.fn();
    const user = userEvent.setup();
    render(<ToolConfirmationPrompt request={request} agentName="Venus" onRespond={onRespond} />);

    expect(screen.getByText('Venus wants to run:')).toBeInTheDocument();
    expect(screen.getByText('shell_exec')).toBeInTheDocument();
    expect(screen.getByText(/git status/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onRespond).toHaveBeenCalledWith('call-1', 'approve_once');
  });

  it('denies without executing the call', async () => {
    const onRespond = vi.fn();
    const user = userEvent.setup();
    render(<ToolConfirmationPrompt request={request} onRespond={onRespond} />);

    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onRespond).toHaveBeenCalledWith('call-1', 'deny');
  });

  it('offers persistent agent/thread choices for an allow-list miss', async () => {
    const onRespond = vi.fn();
    const user = userEvent.setup();
    render(
      <ToolConfirmationPrompt request={{ ...request, mode: 'allow_list' }} onRespond={onRespond} />
    );

    expect(screen.getByText(/not in the agent's allow-list/i)).toBeInTheDocument();
    const actions = screen.getByRole('group', { name: 'Tool confirmation actions' });
    expect(
      within(actions)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Deny', 'Allow for this thread', 'Always allow']);

    await user.click(within(actions).getByRole('button', { name: 'Allow for this thread' }));
    expect(onRespond).toHaveBeenCalledWith('call-1', 'allow_thread');
  });
});
