import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveWorkItem } from '@snaglet/shared/types/workspace-events';
import {
  markAgentWorkFinished,
  markAgentWorkStarted,
  seedAgentWork,
} from '@desktop/utils/agentWorkState';
import {
  DashboardNavigationProvider,
  type DashboardNavigationValue,
} from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { StatusBar } from '../StatusBar';
import { StatusBarProvider } from '../StatusBarContext';
import { ActiveAgentsSlot } from './ActiveAgentsSlot';
import { formatElapsed } from './ActiveAgentsPopover';

const threadRun = (overrides: Partial<ActiveWorkItem> = {}): ActiveWorkItem => ({
  id: 'run-1',
  kind: 'thread-run',
  agentId: 'agent-1',
  agentName: 'Clio',
  threadId: 'thread-1',
  threadTitle: 'Release planning',
  startedAt: new Date(Date.now() - 5_000).toISOString(),
  ...overrides,
});

const hookRun = (overrides: Partial<ActiveWorkItem> = {}): ActiveWorkItem => ({
  id: 'hook-1',
  kind: 'hook-run',
  hookName: 'on-doc-saved',
  startedAt: new Date(Date.now() - 65_000).toISOString(),
  ...overrides,
});

const renderSlot = (nav?: DashboardNavigationValue) => {
  const tree = (
    <StatusBarProvider>
      <ActiveAgentsSlot />
      <StatusBar />
    </StatusBarProvider>
  );
  return render(
    nav ? <DashboardNavigationProvider value={nav}>{tree}</DashboardNavigationProvider> : tree
  );
};

describe('formatElapsed', () => {
  const now = Date.parse('2026-07-29T12:00:00.000Z');
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it('formats seconds, minutes, and hours', () => {
    expect(formatElapsed(at(0), now)).toBe('0s');
    expect(formatElapsed(at(42_000), now)).toBe('42s');
    expect(formatElapsed(at(3 * 60_000 + 7_000), now)).toBe('3m 07s');
    expect(formatElapsed(at(60 * 60_000 + 4 * 60_000), now)).toBe('1h 04m');
  });

  it('clamps clock skew (startedAt in the future) to zero', () => {
    expect(formatElapsed(at(-3_000), now)).toBe('0s');
  });

  it('degrades an unparseable timestamp to zero', () => {
    expect(formatElapsed('not-a-date', now)).toBe('0s');
  });
});

describe('ActiveAgentsSlot', () => {
  beforeEach(() => {
    seedAgentWork([]);
  });

  it('shows a dimmed zero label when nothing is running', () => {
    renderSlot();
    const chip = screen.getByRole('button', { name: /^0 active agent processes$/ });
    expect(chip).toBeInTheDocument();
    expect(chip.title).toBe('No agent processes running');
  });

  it('shows the process count when work is active', () => {
    seedAgentWork([
      threadRun(),
      // Same agent working a hook too — still one active agent.
      hookRun({ agentId: 'agent-1', agentName: 'Clio' }),
      threadRun({ id: 'run-2', agentId: 'agent-2', agentName: 'Venus', threadId: 'thread-2' }),
    ]);
    renderSlot();
    const chip = screen.getByRole('button', { name: /^2 active agent processes$/ });
    expect(chip.title).toBe('2 agent processes running — click for details');
  });

  it('counts the same agent in two threads and removes each completed process independently', () => {
    seedAgentWork([threadRun(), threadRun({ id: 'run-2', threadId: 'thread-2' })]);
    renderSlot();
    expect(screen.getByRole('button', { name: '2 active agent processes' })).toBeInTheDocument();
    act(() => markAgentWorkStarted(threadRun())); // duplicate delivery is idempotent
    expect(screen.getByRole('button', { name: '2 active agent processes' })).toBeInTheDocument();
    act(() => markAgentWorkFinished('run-1'));
    expect(screen.getByRole('button', { name: '1 active agent process' })).toBeInTheDocument();
    act(() => markAgentWorkFinished('run-2'));
    expect(screen.getByRole('button', { name: '0 active agent processes' })).toBeInTheDocument();
  });

  it('opens a popover with the empty state when idle', () => {
    renderSlot();
    fireEvent.click(screen.getByRole('button', { name: /^0 active agent processes$/ }));
    expect(screen.getByText('No agents working.')).toBeInTheDocument();
  });

  it('lists agent work only; hook runs have their own status-bar surface', () => {
    seedAgentWork([
      threadRun({ startedAt: new Date(Date.now() - 60_000).toISOString() }),
      hookRun({ id: 'hook-9', startedAt: new Date(Date.now() - 5_000).toISOString() }),
    ]);
    renderSlot();
    fireEvent.click(screen.getByRole('button', { name: /^1 active agent process$/ }));

    const list = screen.getByRole('list', { name: 'Agents currently working' });
    const rows = Array.from(list.querySelectorAll('li'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Clio');
    expect(rows[0]).toHaveTextContent('in Release planning');
    expect(rows[0]).not.toHaveTextContent('on-doc-saved');
    // Elapsed labels rendered from startedAt.
    expect(rows[0]).toHaveTextContent(/1m 0\ds/);
  });

  it('updates live while open when work events arrive', () => {
    seedAgentWork([threadRun()]);
    renderSlot();
    fireEvent.click(screen.getByRole('button', { name: /^1 active agent process$/ }));
    expect(screen.getByText('in Release planning')).toBeInTheDocument();

    act(() => {
      markAgentWorkStarted(
        threadRun({
          id: 'run-2',
          agentId: 'agent-2',
          agentName: 'Venus',
          threadId: 'thread-2',
          threadTitle: 'Bug triage',
        })
      );
    });
    expect(screen.getByText('Venus')).toBeInTheDocument();
    expect(screen.getByText('in Bug triage')).toBeInTheDocument();

    act(() => {
      markAgentWorkFinished('run-1');
      markAgentWorkFinished('run-2');
    });
    expect(screen.getByText('No agents working.')).toBeInTheDocument();
    // Chip is back to the dimmed idle state.
    expect(screen.getByRole('button', { name: /^0 active agent processes$/ })).toBeInTheDocument();
  });

  it('navigates the pane to the thread when a thread-run row is clicked', () => {
    const openInPane = vi.fn();
    const nav: DashboardNavigationValue = {
      openInPane,
      openThreadAgent: vi.fn(),
      requestReveal: vi.fn(),
    };
    seedAgentWork([threadRun(), hookRun()]);
    renderSlot(nav);
    fireEvent.click(screen.getByRole('button', { name: /^1 active agent process$/ }));

    fireEvent.click(screen.getByRole('button', { name: /Clio/ }));
    expect(openInPane).toHaveBeenCalledTimes(1);
    expect(openInPane).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'thread', id: 'thread-1', title: 'Release planning' })
    );
    // Popover closed after navigating.
    expect(screen.queryByRole('list', { name: 'Agents currently working' })).toBeNull();
  });

  it('does not count or list hook runs as agents', () => {
    seedAgentWork([hookRun()]);
    renderSlot();
    fireEvent.click(screen.getByRole('button', { name: /^0 active agent processes$/ }));
    expect(screen.getByText('No agents working.')).toBeInTheDocument();
  });
});
