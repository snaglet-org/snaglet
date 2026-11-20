import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DmAvatar } from './DmAvatar';

describe('DmAvatar', () => {
  it('renders nothing visual for the user', () => {
    const { container } = render(<DmAvatar party={{ kind: 'user', name: 'Test User' }} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('dm-avatar')).toBeNull();
  });

  it('keeps agent rendering unchanged: flower without a ring', () => {
    render(<DmAvatar party={{ kind: 'agent', agentId: 'test-agent-a' }} />);
    const avatar = screen.getByTestId('dm-avatar');
    expect(avatar.getAttribute('data-kind')).toBe('agent');
    expect(avatar.querySelector('svg')).not.toBeNull();
  });

  it('shows an agent picture over its flower', () => {
    render(<DmAvatar party={{ kind: 'agent', agentId: 'a', avatarUrl: 'x.png' }} />);
    const avatar = screen.getByTestId('dm-avatar');
    expect(avatar.querySelector('img')).not.toBeNull();
    expect(avatar.querySelector('svg')).toBeNull();
  });
});
