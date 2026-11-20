import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubagentSummary } from '@snaglet/shared/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ resume: vi.fn(), remove: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    threadsApi: { ...actual.threadsApi, resumeSubagent: api.resume, removeSubagent: api.remove },
  };
});

import { markThreadRunStarted, seedRunningThreads } from '@desktop/utils/threadRunState';
import { SubagentRemovedState, SubagentThreadHeader } from './SubagentThreadHeader';
import { pausedUntilTime } from './subagentText';
import type { HelperThreadInfo } from './useHelperThread';

const HELPER_THREAD = 'thread-helper-1';

function subagent(over: Partial<SubagentSummary> = {}): SubagentSummary {
  return {
    id: 'subagent-1',
    name: 'Scout',
    parentThreadId: 'thread-parent-1',
    threadId: HELPER_THREAD,
    orchestratorAgentId: 'test-agent-a',
    orchestratorName: 'Agent A',
    agentId: 'test-agent-helper-1',
    providerId: 'provider-1',
    modelId: 'model-small',
    status: 'finished',
    error: null,
    resumeAt: null,
    taskCount: 1,
    createdAt: '2026-10-12T11:58:00.000Z',
    lastTaskAt: '2026-10-12T11:58:00.000Z',
    finishedAt: '2026-10-12T11:59:00.000Z',
    ...over,
  };
}

function info(over: Partial<HelperThreadInfo> = {}): HelperThreadInfo {
  return {
    parentThreadId: 'thread-parent-1',
    title: 'Agent A › Scout',
    subagent: subagent(),
    removed: false,
    ...over,
  };
}

afterEach(() => {
  act(() => seedRunningThreads([]));
  vi.clearAllMocks();
});

describe('SubagentThreadHeader', () => {
  it("names the orchestrator's subagent and its model, with a link back to the parent", async () => {
    const user = userEvent.setup();
    const onOpenParent = vi.fn();
    render(
      <SubagentThreadHeader threadId={HELPER_THREAD} helper={info()} onOpenParent={onOpenParent} />
    );

    const header = screen.getByText("Agent A's subagent Scout").closest('[data-tid]');
    expect(header).toHaveTextContent("Agent A's subagent Scout·model-small·finished");

    await user.click(screen.getByRole('button', { name: 'Open parent thread' }));
    expect(onOpenParent).toHaveBeenCalledOnce();
  });

  it('shows running while the helper thread has a live run', () => {
    render(<SubagentThreadHeader threadId={HELPER_THREAD} helper={info()} />);
    act(() => markThreadRunStarted(HELPER_THREAD));
    expect(screen.getByText('running')).toBeInTheDocument();
    // No navigation in previews: no link.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says paused, and until when for a timed pause; Resume resumes it', async () => {
    const user = userEvent.setup();
    api.resume.mockResolvedValue({ subagent: null });
    const resumeAt = '2026-10-12T15:00:00.000Z';
    const { rerender } = render(
      <SubagentThreadHeader
        threadId={HELPER_THREAD}
        helper={info({ subagent: subagent({ status: 'stopped' }) })}
        onOpenParent={vi.fn()}
      />
    );
    expect(screen.getByText('paused')).toBeInTheDocument();

    rerender(
      <SubagentThreadHeader
        threadId={HELPER_THREAD}
        helper={info({ subagent: subagent({ status: 'stopped', resumeAt }) })}
        onOpenParent={vi.fn()}
      />
    );
    expect(screen.getByText(`paused until ${pausedUntilTime(resumeAt)}`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(api.resume).toHaveBeenCalledWith('thread-parent-1', 'subagent-1');
  });

  it('offers Resume only while paused', () => {
    render(
      <SubagentThreadHeader threadId={HELPER_THREAD} helper={info()} onOpenParent={vi.fn()} />
    );
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('Remove removes the helper at once and says so', async () => {
    const user = userEvent.setup();
    api.remove.mockResolvedValue({ removed: true });
    const toasts: string[] = [];
    const onToast = (event: Event) =>
      toasts.push((event as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener('snaglet:toast', onToast);
    try {
      render(
        <SubagentThreadHeader threadId={HELPER_THREAD} helper={info()} onOpenParent={vi.fn()} />
      );
      await user.click(screen.getByRole('button', { name: 'Remove' }));
      expect(api.remove).toHaveBeenCalledWith('thread-parent-1', 'subagent-1');
      await vi.waitFor(() => expect(toasts).toEqual(['Removed Scout']));
    } finally {
      window.removeEventListener('snaglet:toast', onToast);
    }
  });

  it.each(['failed', 'stopped'] as const)(
    'removes a %s helper too, once however often Remove is clicked',
    async (status) => {
      const user = userEvent.setup();
      let answer: (value: { removed: boolean }) => void = () => {};
      api.remove.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      const toasts: string[] = [];
      const onToast = (event: Event) =>
        toasts.push((event as CustomEvent<{ message: string }>).detail.message);
      window.addEventListener('snaglet:toast', onToast);
      try {
        render(
          <SubagentThreadHeader
            threadId={HELPER_THREAD}
            helper={info({ subagent: subagent({ status, error: 'rate limited' }) })}
            onOpenParent={vi.fn()}
          />
        );
        const remove = screen.getByRole('button', { name: 'Remove' });
        await user.click(remove);
        await user.click(remove);
        expect(api.remove).toHaveBeenCalledOnce();
        await act(async () => answer({ removed: true }));
        await vi.waitFor(() => expect(toasts).toEqual(['Removed Scout']));
      } finally {
        window.removeEventListener('snaglet:toast', onToast);
      }
    }
  );

  it('a removal that fails says so and never "Removed"', async () => {
    const user = userEvent.setup();
    api.remove.mockRejectedValue(new Error("Scout's thread could not be deleted; try again."));
    const toasts: string[] = [];
    const onToast = (event: Event) =>
      toasts.push((event as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener('snaglet:toast', onToast);
    try {
      render(
        <SubagentThreadHeader threadId={HELPER_THREAD} helper={info()} onOpenParent={vi.fn()} />
      );
      await user.click(screen.getByRole('button', { name: 'Remove' }));
      await vi.waitFor(() =>
        expect(toasts).toEqual([
          "Couldn't remove Scout: Scout's thread could not be deleted; try again.",
        ])
      );
    } finally {
      window.removeEventListener('snaglet:toast', onToast);
    }
  });

  it('renders nothing until the helper row is known', () => {
    const { container } = render(
      <SubagentThreadHeader threadId={HELPER_THREAD} helper={info({ subagent: null })} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SubagentRemovedState', () => {
  it('says the subagent was removed and offers the parent thread', async () => {
    const user = userEvent.setup();
    const onOpenParent = vi.fn();
    render(<SubagentRemovedState onOpenParent={onOpenParent} />);

    expect(screen.getByText('This subagent was removed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open parent thread' }));
    expect(onOpenParent).toHaveBeenCalledOnce();
  });
});
