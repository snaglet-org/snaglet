import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentSummary } from '@snaglet/shared/types';
import { userTimeZone } from '@snaglet/shared/utils';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ pause: vi.fn(), resume: vi.fn(), remove: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    threadsApi: {
      ...actual.threadsApi,
      pauseSubagent: api.pause,
      resumeSubagent: api.resume,
      removeSubagent: api.remove,
    },
  };
});

import {
  addNotification,
  removeNotification,
  seedNotifications,
} from '@desktop/utils/notificationState';
import { markThreadRunStarted, seedRunningThreads } from '@desktop/utils/threadRunState';
import { FetchError } from '@desktop/utils/api';
import { toDateTimeLocal } from './PauseUntilPopover';
import { SubagentStrip } from './SubagentStrip';
import { pausedUntilTime } from './subagentText';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');

function helper(over: Partial<SubagentSummary> = {}): SubagentSummary {
  return {
    id: 'subagent-1',
    name: 'Scout',
    parentThreadId: 'thread-parent-1',
    threadId: 'thread-helper-1',
    orchestratorAgentId: 'test-agent-a',
    orchestratorName: 'Agent A',
    agentId: 'test-agent-helper-1',
    providerId: 'provider-1',
    modelId: 'model-small',
    status: 'running',
    error: null,
    resumeAt: null,
    taskCount: 1,
    createdAt: '2026-10-12T11:58:00.000Z',
    lastTaskAt: '2026-10-12T11:58:55.000Z',
    finishedAt: null,
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
  act(() => seedRunningThreads([]));
  act(() => seedNotifications([]));
});

describe('SubagentStrip', () => {
  it('renders nothing while the thread has no helpers', () => {
    const { container } = render(<SubagentStrip subagents={[]} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows one chip per helper: name, model and live state with elapsed time', () => {
    vi.useFakeTimers({ now: NOW });
    render(
      <SubagentStrip
        subagents={[
          helper(),
          helper({
            id: 'subagent-2',
            name: 'Critic',
            threadId: 'thread-helper-2',
            modelId: 'model-large',
            status: 'failed',
            error: 'model timed out',
          }),
        ]}
        onOpen={vi.fn()}
      />
    );

    const strip = screen.getByRole('group', { name: 'Subagents' });
    const scout = screen.getByRole('button', { name: /^Scout/ });
    expect(strip).toContainElement(scout);
    expect(scout).toHaveTextContent('Scout·model-small·running 1m 05s');
    expect(screen.getByRole('button', { name: /^Critic/ })).toHaveTextContent(
      'Critic·model-large·failed'
    );

    // The running chip's clock ticks locally.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(scout).toHaveTextContent('running 1m 07s');
  });

  it("says why a failed helper failed in its chip's tooltip", () => {
    render(
      <SubagentStrip
        subagents={[helper({ status: 'failed', error: 'model not supported' })]}
        onOpen={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /^Scout/ })).toHaveAttribute(
      'title',
      "Failed: model not supported\nOpen Scout's thread — you can write to it like any thread"
    );
  });

  it('counts a live run in a finished helper thread as running', () => {
    render(<SubagentStrip subagents={[helper({ status: 'finished' })]} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^Scout/ })).toHaveTextContent('finished');

    act(() => markThreadRunStarted('thread-helper-1'));
    expect(screen.getByRole('button', { name: /^Scout/ })).toHaveTextContent(/running \d+s/);
  });

  it("says waiting for you while a tool approval is pending in the helper's thread", () => {
    render(<SubagentStrip subagents={[helper()]} onOpen={vi.fn()} />);
    const chip = screen.getByRole('button', { name: /^Scout/ });
    expect(chip).toHaveTextContent(/running \d+/);

    act(() =>
      addNotification({
        id: 'notif-ask-1',
        type: 'tool_approval',
        title: "Agent A's subagent Scout needs your approval",
        body: null,
        threadId: 'thread-helper-1',
        agentId: 'test-agent-helper-1',
        runId: 'run-1',
        read: false,
        dismissed: false,
        createdAt: '2026-10-12T11:59:00.000Z',
      })
    );
    expect(chip).toHaveTextContent('Scout·model-small·waiting for you');

    // The server dismisses the ask's notification once it is answered.
    act(() => removeNotification('notif-ask-1'));
    expect(chip).toHaveTextContent(/running \d+/);
  });

  it("ignores another thread's approval", () => {
    render(<SubagentStrip subagents={[helper()]} onOpen={vi.fn()} />);
    act(() =>
      addNotification({
        id: 'notif-ask-2',
        type: 'tool_approval',
        title: 'Agent A needs your approval',
        body: null,
        threadId: 'thread-parent-1',
        agentId: 'test-agent-a',
        runId: 'run-2',
        read: false,
        dismissed: false,
        createdAt: '2026-10-12T11:59:00.000Z',
      })
    );
    expect(screen.getByRole('button', { name: /^Scout/ })).toHaveTextContent(/running \d+/);
  });

  it('opens the helper thread with its server-side title', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<SubagentStrip subagents={[helper()]} onOpen={onOpen} />);

    await user.click(screen.getByRole('button', { name: /^Scout/ }));

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith('thread-helper-1', 'Agent A › Scout');
  });

  it('renders static chips where the view cannot navigate: no link, no actions', () => {
    render(<SubagentStrip subagents={[helper({ status: 'stopped' })]} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();
  });

  it('reads a stopped helper as paused, with the time a timed pause ends', () => {
    const resumeAt = '2026-10-12T15:00:00.000Z';
    render(
      <SubagentStrip
        subagents={[
          helper({ status: 'stopped' }),
          helper({
            id: 'subagent-2',
            name: 'Timer',
            threadId: 'thread-helper-2',
            status: 'stopped',
            resumeAt,
          }),
        ]}
        onOpen={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /^Scout/ })).toHaveTextContent(
      'Scout·model-small·paused'
    );
    expect(screen.getByRole('button', { name: /^Timer/ })).toHaveTextContent(
      `paused until ${pausedUntilTime(resumeAt)}`
    );
  });
});

describe('SubagentStrip actions menu', () => {
  beforeEach(() => {
    api.pause.mockResolvedValue({ subagent: null, done: true });
    api.resume.mockResolvedValue({ subagent: null });
    api.remove.mockResolvedValue({ removed: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function menuLabels(): string[] {
    return within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((item) => item.textContent ?? '');
  }

  it('opens from the ⋯ button with Pause, Pause for…, Remove; Pause pauses the helper', async () => {
    const user = userEvent.setup();
    render(<SubagentStrip subagents={[helper()]} onOpen={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Actions for Scout' }));
    expect(screen.getByRole('menu', { name: 'Scout actions' })).toBeInTheDocument();
    expect(menuLabels()).toEqual([
      'Pause',
      'Pause for 15 min',
      'Pause for 1 hour',
      'Pause until…',
      'Remove',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Pause' }));
    expect(api.pause).toHaveBeenCalledWith('thread-parent-1', 'subagent-1', {});
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('pauses for 15 minutes or an hour', async () => {
    const user = userEvent.setup();
    render(<SubagentStrip subagents={[helper()]} onOpen={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Actions for Scout' }));
    await user.click(screen.getByRole('menuitem', { name: 'Pause for 15 min' }));
    await user.click(screen.getByRole('button', { name: 'Actions for Scout' }));
    await user.click(screen.getByRole('menuitem', { name: 'Pause for 1 hour' }));
    expect(api.pause.mock.calls).toEqual([
      ['thread-parent-1', 'subagent-1', { for: '15m' }],
      ['thread-parent-1', 'subagent-1', { for: '1h' }],
    ]);
  });

  it('offers Resume instead of Pause while paused', async () => {
    const user = userEvent.setup();
    render(<SubagentStrip subagents={[helper({ status: 'stopped' })]} onOpen={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Actions for Scout' }));
    expect(menuLabels()[0]).toBe('Resume');
    expect(menuLabels()).not.toContain('Pause');
    await user.click(screen.getByRole('menuitem', { name: 'Resume' }));
    expect(api.resume).toHaveBeenCalledWith('thread-parent-1', 'subagent-1');
  });

  it.each(['finished', 'failed'] as const)(
    'offers only Remove for a %s helper; Remove removes it',
    async (status) => {
      const user = userEvent.setup();
      render(<SubagentStrip subagents={[helper({ status })]} onOpen={vi.fn()} />);
      const button = screen.getByRole('button', { name: 'Actions for Scout' });
      expect(button).toHaveAttribute('title', 'Remove Scout');
      await user.click(button);
      expect(menuLabels()).toEqual(['Remove']);
      await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
      expect(api.remove).toHaveBeenCalledWith('thread-parent-1', 'subagent-1');
    }
  );

  it('offers Pause again while a finished helper works on something new', async () => {
    const user = userEvent.setup();
    render(<SubagentStrip subagents={[helper({ status: 'finished' })]} onOpen={vi.fn()} />);
    act(() => markThreadRunStarted('thread-helper-1'));
    await user.click(screen.getByRole('button', { name: 'Actions for Scout' }));
    expect(menuLabels()).toEqual([
      'Pause',
      'Pause for 15 min',
      'Pause for 1 hour',
      'Pause until…',
      'Remove',
    ]);
  });

  it('says a helper still stopping is removed when its run ends, and nothing for one already gone', async () => {
    const user = userEvent.setup();
    const toasts: string[] = [];
    const onToast = (event: Event) =>
      toasts.push((event as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener('snaglet:toast', onToast);
    try {
      api.remove.mockResolvedValueOnce({ removed: false });
      render(<SubagentStrip subagents={[helper()]} onOpen={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: 'Actions for Scout' }));
      await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
      await vi.waitFor(() =>
        expect(toasts).toEqual(['Scout is still stopping; it is removed as soon as its run ends'])
      );

      // Removed meanwhile from its thread's header: the server doesn't know it.
      api.remove.mockRejectedValueOnce(new FetchError('Subagent not found', 404));
      await user.click(screen.getByRole('button', { name: 'Actions for Scout' }));
      await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(api.remove).toHaveBeenCalledTimes(2);
      expect(toasts).toHaveLength(1);
    } finally {
      window.removeEventListener('snaglet:toast', onToast);
    }
  });

  it('removes at once, with a toast and no undo', async () => {
    const user = userEvent.setup();
    const toasts: Array<{ message: string; action?: unknown }> = [];
    const onToast = (event: Event) => toasts.push((event as CustomEvent).detail);
    window.addEventListener('snaglet:toast', onToast);
    try {
      render(<SubagentStrip subagents={[helper()]} onOpen={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: 'Actions for Scout' }));
      await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
      expect(api.remove).toHaveBeenCalledWith('thread-parent-1', 'subagent-1');
      await vi.waitFor(() => expect(toasts).toHaveLength(1));
      expect(toasts[0]).toEqual(expect.objectContaining({ message: 'Removed Scout' }));
      expect(toasts[0]!.action).toBeUndefined();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      window.removeEventListener('snaglet:toast', onToast);
    }
  });

  it('opens from the keyboard: Shift+F10 on the chip, Enter on the ⋯ button', async () => {
    const user = userEvent.setup();
    render(<SubagentStrip subagents={[helper()]} onOpen={vi.fn()} />);
    const chip = screen.getByRole('button', { name: /^Scout/ });
    chip.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    expect(screen.getByRole('menu', { name: 'Scout actions' })).toBeInTheDocument();
    // The menu takes focus; Escape closes it and focus returns.
    expect(screen.getByRole('menuitem', { name: 'Pause' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Actions for Scout' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu', { name: 'Scout actions' })).toBeInTheDocument();
  });

  it('opens on right-click', async () => {
    const user = userEvent.setup();
    render(<SubagentStrip subagents={[helper()]} onOpen={vi.fn()} />);
    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('button', { name: /^Scout/ }),
    });
    expect(screen.getByRole('menu', { name: 'Scout actions' })).toBeInTheDocument();
  });

  it('pauses until a picked time', async () => {
    const user = userEvent.setup();
    render(<SubagentStrip subagents={[helper()]} onOpen={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Actions for Scout' }));
    await user.click(screen.getByRole('menuitem', { name: 'Pause until…' }));

    const dialog = screen.getByRole('dialog', { name: 'Pause Scout until' });
    const input = within(dialog).getByLabelText('Resume at');
    const later = new Date(Date.now() + 3 * 60 * 60_000);
    later.setSeconds(0, 0);
    const value = toDateTimeLocal(later, userTimeZone());
    fireEvent.change(input, { target: { value } });
    await user.click(within(dialog).getByRole('button', { name: 'Pause' }));

    expect(api.pause).toHaveBeenCalledWith('thread-parent-1', 'subagent-1', {
      until: later.toISOString(),
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('will not pause until a time already past', async () => {
    const user = userEvent.setup();
    render(<SubagentStrip subagents={[helper()]} onOpen={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Actions for Scout' }));
    await user.click(screen.getByRole('menuitem', { name: 'Pause until…' }));
    const dialog = screen.getByRole('dialog', { name: 'Pause Scout until' });
    fireEvent.change(within(dialog).getByLabelText('Resume at'), {
      target: { value: toDateTimeLocal(new Date(Date.now() - 60 * 60_000), userTimeZone()) },
    });
    expect(within(dialog).getByRole('button', { name: 'Pause' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.pause).not.toHaveBeenCalled();
  });
});
