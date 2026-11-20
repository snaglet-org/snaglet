import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CursorApprovalPrompts } from './CursorApprovalPrompt';
import {
  publishCursorApprovals,
  resetCursorApprovalStore,
} from '@desktop/components/AgentCursorApproval/cursorApprovalStore';

const req = (over = {}) => ({
  requestId: 'r1',
  agentId: 'a1',
  name: 'Bob',
  flower: 'daisy' as const,
  color: '#fff',
  kind: 'browser' as const,
  profile: 'main',
  reason: 'Open the calendar',
  expiresAt: Date.now() + 60_000,
  ...over,
});

describe('CursorApprovalPrompts', () => {
  beforeEach(() => resetCursorApprovalStore());

  it('renders nothing with no pending request', () => {
    const { container } = render(<CursorApprovalPrompts />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the request as an InteractionPanel and answers it', async () => {
    const answer = vi.fn();
    const user = userEvent.setup();
    render(<CursorApprovalPrompts />);
    act(() => publishCursorApprovals([req()], answer));

    expect(screen.getByText(/wants to use your signed-in browser/)).toBeInTheDocument();
    expect(screen.getByText('Open the calendar')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allow for this session' }));
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'r1' }),
      'allow-session'
    );
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(answer).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'r1' }), 'deny');
  });
});
