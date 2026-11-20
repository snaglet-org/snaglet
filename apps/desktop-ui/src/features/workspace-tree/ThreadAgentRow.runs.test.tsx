/**
 * ThreadAgentRow — the "Runs" category.
 *
 * Two properties matter here and both fail silently if broken:
 *
 *  1. Runs are closed on first render and fetch only when expanded. A run
 *     history is an unbounded execution log, so an eager fetch would put a
 *     request on every agent row of every expanded thread for data nobody
 *     asked to see.
 *  2. The fetch is scoped to this row's agent server-side. Filtering a
 *     thread-wide page client-side isn't just wasteful — with several agents
 *     sharing a busy thread, one chatty agent fills the limit window and a
 *     quieter agent's runs never appear at all.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { ThreadAgentRow } from './ThreadAgentRow';
import { memoriesApi, runsApi } from '@desktop/utils/api';
import { threadsApi } from '@desktop/utils/api/threads';
import type { ThreadAgentEntry } from './types';
import type { ThreadTreeNode } from '@desktop/utils/api';

vi.mock('@desktop/utils/api', () => ({
  memoriesApi: { list: vi.fn() },
  runsApi: { listByThread: vi.fn() },
}));
vi.mock('@desktop/utils/api/threads', () => ({
  threadsApi: { listAgentSummaries: vi.fn() },
}));

const AGENT_ID = 'mango';
const RUN_ID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

const thread = {
  id: 'thread-1111111111111-nm6mjg7xf',
  title: 'Main thread',
} as unknown as ThreadTreeNode;
const entry = {
  agent: { id: AGENT_ID, name: 'mango', role: 'engineer' },
  participant: { agentId: AGENT_ID },
} as unknown as ThreadAgentEntry;

const listRuns = vi.mocked(runsApi.listByThread);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(memoriesApi.list).mockResolvedValue([]);
  vi.mocked(threadsApi.listAgentSummaries).mockResolvedValue([]);
  listRuns.mockResolvedValue([
    {
      id: RUN_ID,
      agentId: AGENT_ID,
      agentName: 'mango',
      status: 'completed',
      startedAt: '2026-08-01T10:00:00.000Z',
      finishedAt: '2026-08-01T10:01:00.000Z',
    },
  ]);
});

/** Expand the agent row itself — its chevron is the first one in the row. */
async function expandAgent(user: ReturnType<typeof userEvent.setup>) {
  render(<ThreadAgentRow thread={thread} entry={entry} depth={0} />);
  const agentRow = screen.getByTitle('mango · engineer');
  const chevron = agentRow.querySelector('span');
  await user.click(chevron as Element);
}

describe('ThreadAgentRow — Runs category', () => {
  it('starts collapsed and does not fetch runs until expanded', async () => {
    const user = userEvent.setup();
    await expandAgent(user);

    const runsHeader = await screen.findByRole('button', { name: /runs/i });
    expect(runsHeader).toHaveAttribute('aria-expanded', 'false');

    // Memories/summaries load with the agent row; runs deliberately do not.
    await waitFor(() => expect(memoriesApi.list).toHaveBeenCalled());
    expect(listRuns).not.toHaveBeenCalled();
    expect(screen.queryByText(RUN_ID.slice(0, 8))).not.toBeInTheDocument();
  });

  it('fetches and renders this agent\u2019s runs on first expand', async () => {
    const user = userEvent.setup();
    await expandAgent(user);

    await user.click(await screen.findByRole('button', { name: /runs/i }));

    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(1));
    // Scoped to this agent server-side, not filtered after the fact.
    expect(listRuns).toHaveBeenCalledWith(
      thread.id,
      expect.objectContaining({ agentId: AGENT_ID })
    );

    // Row renders the short run id and is draggable as a chip.
    const row = await screen.findByText('3f2a1b4c');
    expect(row).toBeInTheDocument();
    const draggable = document.querySelector(`[data-run-id="${RUN_ID}"]`);
    expect(draggable).toHaveAttribute('draggable', 'true');
  });

  it('does not refetch when collapsed and expanded again', async () => {
    const user = userEvent.setup();
    await expandAgent(user);

    const header = await screen.findByRole('button', { name: /runs/i });
    await user.click(header);
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(1));

    await user.click(header); // collapse
    await user.click(header); // expand again

    expect(listRuns).toHaveBeenCalledTimes(1);
  });

  it('shows an explicit empty state rather than a bare header', async () => {
    listRuns.mockResolvedValue([]);
    const user = userEvent.setup();
    await expandAgent(user);

    await user.click(await screen.findByRole('button', { name: /runs/i }));

    expect(await screen.findByText('No runs')).toBeInTheDocument();
  });
});
