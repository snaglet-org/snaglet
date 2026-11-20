/**
 * An empty thread's starter: who to greet and suggestions that only fill the
 * composer, plus the notice that says to connect a provider.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  status: 'ready' as 'ready' | 'loading',
  provider: { kind: 'none' } as
    | { kind: 'none' }
    | { kind: 'connected'; failed: boolean }
    | { kind: 'ready'; providerId: string },
}));
vi.mock('./useOnboarding', () => ({ useOnboarding: () => state }));

import { ProviderNotice, ThreadStarter } from './ThreadStarter';

beforeEach(() => {
  state.status = 'ready';
  state.provider = { kind: 'none' };
});

describe('ThreadStarter', () => {
  it("offers Patty's suggestions and hands a pick to the composer without sending", () => {
    const onPick = vi.fn();
    render(<ThreadStarter agentIds={['patty']} agentNames={['Patty']} onPick={onPick} />);
    expect(screen.getByText('Say hello to Patty')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'What can you help me set up?' }));
    expect(onPick).toHaveBeenCalledWith('What can you help me set up?');
    expect(screen.getByRole('button', { name: 'Show me around' })).toBeTruthy();
  });

  it('puts "Help me get started" first, and a pick only fills the composer', () => {
    const cases: Array<[string[], string[]]> = [
      [['patty'], ['Patty']],
      [
        ['patty', 'clio'],
        ['Patty', 'Clio'],
      ],
      [['nova'], ['Nova']],
    ];
    for (const [agentIds, agentNames] of cases) {
      const onPick = vi.fn();
      const { container, unmount } = render(
        <ThreadStarter agentIds={agentIds} agentNames={agentNames} onPick={onPick} />
      );
      const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
      expect(buttons[0]).toBe('Help me get started');
      expect(buttons.filter((label) => label === 'Help me get started')).toHaveLength(1);
      expect(buttons.length).toBeLessThanOrEqual(4);
      fireEvent.click(screen.getByRole('button', { name: 'Help me get started' }));
      expect(onPick).toHaveBeenCalledWith('Help me get started');
      unmount();
    }
  });

  it('does not offer it in a thread with only Clio, which keeps her planning suggestions', () => {
    render(<ThreadStarter agentIds={['clio']} agentNames={['Clio']} onPick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Help me get started' })).toBeNull();
    expect(screen.getByRole('button', { name: 'What is on my calendar this week?' })).toBeTruthy();
  });

  it("offers Clio's planning suggestions", () => {
    render(<ThreadStarter agentIds={['clio']} agentNames={['Clio']} onPick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Add a reminder for tomorrow at 9' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make a weekly plan' })).toBeTruthy();
  });

  it('falls back to general suggestions for any other agent', () => {
    render(
      <ThreadStarter agentIds={['nova', 'rex']} agentNames={['Nova', 'Rex']} onPick={vi.fn()} />
    );
    expect(screen.getByText('Say hello to Nova and Rex')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'What can you help me with?' })).toBeTruthy();
  });
});

describe('ProviderNotice', () => {
  it('asks for a provider while none is connected', () => {
    const onConnect = vi.fn();
    render(<ProviderNotice agentNames={['Patty']} onConnect={onConnect} />);
    expect(screen.getByText('Connect a provider so Patty can reply.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect a provider' }));
    expect(onConnect).toHaveBeenCalled();
  });

  it('says so when every saved key failed its test', () => {
    state.provider = { kind: 'connected', failed: true };
    render(<ProviderNotice agentNames={['Patty']} onConnect={vi.fn()} />);
    expect(screen.getByText(/last test failed, so Patty can't reply yet/)).toBeTruthy();
  });

  it('stays out of the way once a provider works or a key is untested', () => {
    state.provider = { kind: 'ready', providerId: 'anthropic' };
    const { container, rerender } = render(
      <ProviderNotice agentNames={['Patty']} onConnect={vi.fn()} />
    );
    expect(container.textContent).toBe('');
    state.provider = { kind: 'connected', failed: false };
    rerender(<ProviderNotice agentNames={['Patty']} onConnect={vi.fn()} />);
    expect(container.textContent).toBe('');
  });
});
