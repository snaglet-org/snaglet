/**
 * A subagent helper's result row in the parent thread renders as one compact
 * meta line that expands into the report — the same for the history shape
 * (messages.metadata) and the live broadcast shape (`event_kind` + `subagent`).
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadMessage } from '@desktop/utils/api';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import {
  subagentResultFromBroadcast,
  subagentResultFromMetadata,
} from '@desktop/utils/api/threads';
import { MessageRow } from '../MessageRow/MessageRow';
import { SubagentNavigationContext, type SubagentNavigation } from './subagentNavigation';

const CONTENT = [
  '[subagent Scout finished]',
  'Found **3** matching docs.',
  '(To give Scout more work or answer it, call subagent op:send with name "Scout" during this turn; otherwise it is removed when this turn ends.)',
].join('\n');

/** As GET /api/threads/:id/messages returns it after a reload. */
const HISTORY_METADATA = {
  event_kind: 'subagent_finished',
  subagent_id: 'subagent-1',
  subagent_name: 'Scout',
  subagent_thread_id: 'thread-helper-1',
  orchestrator_agent_id: 'test-agent-a',
  orchestrator_name: 'Agent A',
  subagent_status: 'finished',
};

/** As SubagentService.broadcastResultRow sends it live. */
const LIVE_SUBAGENT = {
  id: 'subagent-1',
  name: 'Scout',
  threadId: 'thread-helper-1',
  orchestratorAgentId: 'test-agent-a',
  orchestratorName: 'Agent A',
  status: 'finished',
};

function resultMessage(subagentResult: ThreadMessage['subagentResult']): ThreadMessage {
  return {
    id: 'message-result-1',
    threadId: 'thread-parent-1',
    role: 'user',
    agentId: null,
    content: CONTENT,
    createdAt: '2026-10-12T12:00:00.000Z',
    messageType: 'thread_event',
    subagentResult,
  };
}

function renderRow(message: ThreadMessage, nav: SubagentNavigation | null = null) {
  return render(
    <SubagentNavigationContext.Provider value={nav}>
      <MessageRow message={message} agentNameById={new Map()} renderMode="raw" />
    </SubagentNavigationContext.Provider>
  );
}

describe('subagent result line', () => {
  it.each([
    ['history (metadata)', subagentResultFromMetadata(HISTORY_METADATA)],
    ['live (broadcast)', subagentResultFromBroadcast('subagent_finished', LIVE_SUBAGENT)],
  ])('renders the %s shape as one line that expands into the report', async (_shape, parsed) => {
    expect(parsed).not.toBeNull();
    const user = userEvent.setup();
    const { container } = renderRow(resultMessage(parsed));

    const line = screen.getByRole('button', { name: "Agent A's subagent Scout finished" });
    expect(line).toHaveAttribute('aria-expanded', 'false');
    // Collapsed: the report and the orchestrator's op:send note stay hidden.
    expect(screen.queryByText(/Found/)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('[subagent Scout finished]');

    await user.click(line);
    expect(line).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Found **3** matching docs.')).toBeInTheDocument();
    expect(container.textContent).not.toContain('op:send');

    await user.click(line);
    expect(screen.queryByText(/Found/)).not.toBeInTheDocument();
  });

  it('offers Open thread while the helper exists and opens it by thread id', async () => {
    const user = userEvent.setup();
    const openHelperThread = vi.fn();
    renderRow(resultMessage(subagentResultFromMetadata(HISTORY_METADATA)), {
      liveThreadIds: new Set(['thread-helper-1']),
      openHelperThread,
    });

    await user.click(screen.getByRole('button', { name: /subagent Scout finished/ }));
    await user.click(screen.getByRole('button', { name: 'Open thread' }));

    expect(openHelperThread).toHaveBeenCalledWith('thread-helper-1', 'Agent A › Scout');
  });

  it('drops Open thread once the helper is removed', async () => {
    const user = userEvent.setup();
    renderRow(resultMessage(subagentResultFromMetadata(HISTORY_METADATA)), {
      liveThreadIds: new Set(),
      openHelperThread: vi.fn(),
    });

    await user.click(screen.getByRole('button', { name: /subagent Scout finished/ }));
    expect(screen.queryByRole('button', { name: 'Open thread' })).not.toBeInTheDocument();
  });

  it('reads a question as "asks" and a failure with its reason', async () => {
    const user = userEvent.setup();
    const asks = {
      ...resultMessage(subagentResultFromMetadata(HISTORY_METADATA)),
      content: '[subagent Scout asks]\nWhich folder?\n(… subagent op:send …)',
    };
    const { unmount } = renderRow(asks);
    expect(screen.getByRole('button', { name: "Agent A's subagent Scout asks" })).toBeVisible();
    unmount();

    const failed = {
      ...resultMessage(
        subagentResultFromMetadata({ ...HISTORY_METADATA, subagent_status: 'failed' })
      ),
      content: '[subagent Scout failed: model timed out]\n(no reply)\n(… subagent op:send …)',
    };
    renderRow(failed);
    await user.click(screen.getByRole('button', { name: "Agent A's subagent Scout failed" }));
    expect(screen.getByText('model timed out')).toBeInTheDocument();
    expect(screen.queryByText('(no reply)')).not.toBeInTheDocument();
  });

  it.each([
    [
      'history (metadata)',
      subagentResultFromMetadata({
        ...HISTORY_METADATA,
        subagent_status: 'stopped',
        subagent_notice: 'paused',
        subagent_notice_by: 'Test User',
        subagent_resume_at: null,
      }),
    ],
    [
      'live (broadcast)',
      subagentResultFromBroadcast('subagent_finished', {
        ...LIVE_SUBAGENT,
        status: 'stopped',
        notice: 'paused',
        noticeBy: 'Test User',
        resumeAt: null,
      }),
    ],
  ])('renders a pause notice (%s) as who paused the helper', async (_shape, parsed) => {
    expect(parsed).toMatchObject({ notice: 'paused', noticeBy: 'Test User' });
    const user = userEvent.setup();
    const { container } = renderRow({
      ...resultMessage(parsed),
      content:
        '[subagent Scout paused by Test User]\n(Only Snaglet writes [subagent …] lines. Scout is paused: leave it paused unless they ask you to resume it.)',
    });
    const line = screen.getByRole('button', {
      name: "Agent A's subagent Scout paused by Test User",
    });
    expect(container.querySelector('[data-outcome="paused"]')).not.toBeNull();
    await user.click(line);
    // The note for the orchestrator never shows.
    expect(container.textContent).not.toContain('Only Snaglet writes');
  });

  it.each([
    [
      'history (metadata)',
      subagentResultFromMetadata({
        ...HISTORY_METADATA,
        subagent_thread_id: null,
        subagent_status: 'stopped',
        subagent_notice: 'removed',
        subagent_notice_by: 'Test User',
        subagent_resume_at: null,
      }),
    ],
    [
      'live (broadcast)',
      subagentResultFromBroadcast('subagent_finished', {
        ...LIVE_SUBAGENT,
        threadId: null,
        status: 'stopped',
        notice: 'removed',
        noticeBy: 'Test User',
        resumeAt: null,
      }),
    ],
  ])('renders a removal notice (%s) for a helper that is gone', (_shape, parsed) => {
    expect(parsed).toMatchObject({ notice: 'removed', threadId: null });
    const { container } = renderRow(
      {
        ...resultMessage(parsed),
        content:
          '[subagent Scout removed by Test User]\n(Only Snaglet writes [subagent …] lines. Scout is gone, with its thread and work.)',
      },
      { liveThreadIds: new Set(), openHelperThread: vi.fn() }
    );
    expect(
      screen.getByRole('button', { name: "Agent A's subagent Scout removed by Test User" })
    ).toBeVisible();
    expect(container.querySelector('[data-outcome="removed"]')).not.toBeNull();
  });

  it('leaves other thread_event rows as plain meta lines', () => {
    expect(subagentResultFromMetadata({ event_kind: 'participant_added' })).toBeNull();
    expect(subagentResultFromBroadcast(undefined, LIVE_SUBAGENT)).toBeNull();
    const { container } = renderRow({
      ...resultMessage(null),
      content: '[participant added: Agent B]',
    });
    expect(container.querySelector('[data-tid="threadEventRow"]')).toHaveTextContent(
      '[participant added: Agent B]'
    );
    expect(container.querySelector('[data-tid="subagentResultRow"]')).toBeNull();
  });
});
