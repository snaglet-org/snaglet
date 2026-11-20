/**
 * CompactAllAgentsPanel — the thread Context tab's "Compress all" affordance.
 *
 * Two layers under test:
 *   1. `runCompactAll` — the pure fan-out orchestration. Pins that it hits
 *      every agent, runs them strictly sequentially (never in parallel), and
 *      that one agent failing is collected without aborting the rest.
 *   2. The panel UI — confirm dialog fronts the sweep, the trigger disables
 *      while running, and a per-agent failure surfaces inline.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactAllAgentsPanel, runCompactAll } from './CompactAllAgentsPanel';
import { threadsApi, agentsApi } from '@desktop/utils/api';
import type { ThreadParticipant } from '@desktop/utils/api';
import type { SnagletAgent } from '@snaglet/shared/types';

vi.mock('@desktop/utils/api', () => ({
  threadsApi: {
    listParticipants: vi.fn(),
    compactAgent: vi.fn(),
  },
  agentsApi: {
    list: vi.fn(),
  },
}));

const listParticipants = vi.mocked(threadsApi.listParticipants);
const compactAgent = vi.mocked(threadsApi.compactAgent);
const listAgents = vi.mocked(agentsApi.list);

function participant(agentId: string, kind: 'agent' | 'user' = 'agent'): ThreadParticipant {
  return {
    id: `p-${agentId}`,
    threadId: 't1',
    memberId: `m-${agentId}`,
    kind,
    agentId,
    role: 'participant',
    credentialId: null,
    providerId: null,
    modelId: null,
    addedAt: '',
    systemPromptAddendum: null,
    toolAccessMode: null,
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    toolOverrides: null,
    maxToolCallsPerTurn: null,
    maxDurationSeconds: null,
    autoRespond: true,
    disableFallback: false,
  };
}

function agent(id: string, name: string): SnagletAgent {
  return { id, name } as unknown as SnagletAgent;
}

/** Seed the two load calls the panel fires on mount. */
function setupAgents(entries: Array<[string, string]>, opts?: { extra?: ThreadParticipant[] }) {
  listParticipants.mockResolvedValue([
    ...(opts?.extra ?? []),
    ...entries.map(([id]) => participant(id, 'agent')),
  ]);
  listAgents.mockResolvedValue(entries.map(([id, name]) => agent(id, name)));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  listParticipants.mockReset();
  compactAgent.mockReset();
  listAgents.mockReset();
});

describe('runCompactAll (fan-out logic)', () => {
  it('calls compactOne for every agent and emits running→done progress in order', async () => {
    const calls: string[] = [];
    const compactOne = vi.fn(async (id: string) => {
      calls.push(id);
    });
    const progress: Array<[string, string]> = [];
    const res = await runCompactAll(['a', 'b', 'c'], compactOne, (id, status) =>
      progress.push([id, status])
    );

    expect(calls).toEqual(['a', 'b', 'c']);
    expect(res.succeeded).toEqual(['a', 'b', 'c']);
    expect(res.failed).toEqual([]);
    expect(progress).toEqual([
      ['a', 'running'],
      ['a', 'done'],
      ['b', 'running'],
      ['b', 'done'],
      ['c', 'running'],
      ['c', 'done'],
    ]);
  });

  it('runs strictly sequentially — will not start the next agent until the prior resolves', async () => {
    const started: string[] = [];
    const gates: Record<string, () => void> = {};
    const compactOne = vi.fn(
      (id: string) =>
        new Promise<void>((resolve) => {
          started.push(id);
          gates[id] = resolve;
        })
    );

    const done = runCompactAll(['a', 'b', 'c'], compactOne, () => {});

    await waitFor(() => expect(started).toEqual(['a']));
    // 'b' must not have started while 'a' is still pending.
    expect(started).toEqual(['a']);

    gates['a']();
    await waitFor(() => expect(started).toEqual(['a', 'b']));
    gates['b']();
    await waitFor(() => expect(started).toEqual(['a', 'b', 'c']));
    gates['c']();

    const res = await done;
    expect(res.succeeded).toEqual(['a', 'b', 'c']);
  });

  it('collects a failing agent but keeps going through the rest', async () => {
    const calls: string[] = [];
    const compactOne = vi.fn(async (id: string) => {
      calls.push(id);
      if (id === 'b') throw new Error('boom-b');
    });
    const errorProgress: Array<[string, string | undefined]> = [];
    const res = await runCompactAll(['a', 'b', 'c'], compactOne, (id, status, err) => {
      if (status === 'error') errorProgress.push([id, err]);
    });

    // 'c' still ran even though 'b' threw.
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(res.succeeded).toEqual(['a', 'c']);
    expect(res.failed).toEqual([{ agentId: 'b', error: 'boom-b' }]);
    expect(errorProgress).toEqual([['b', 'boom-b']]);
  });
});

describe('CompactAllAgentsPanel (UI)', () => {
  it('renders a trigger sized to the agent-participant count, excluding humans', async () => {
    setupAgents(
      [
        ['a1', 'Alpha'],
        ['a2', 'Beta'],
      ],
      { extra: [participant('human-1', 'user')] }
    );
    render(<CompactAllAgentsPanel threadId="t1" />);

    // Human participant excluded → count is 2, not 3.
    expect(await screen.findByRole('button', { name: /compress all \(2\)/i })).toBeTruthy();
  });

  it('shows an empty hint when the thread has no agent participants', async () => {
    listParticipants.mockResolvedValue([]);
    listAgents.mockResolvedValue([]);
    render(<CompactAllAgentsPanel threadId="t1" />);

    expect(await screen.findByText(/no agents in this thread to compress/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /compress all/i })).toBeNull();
  });

  it('opens a confirmation dialog; Cancel closes it without compacting', async () => {
    const user = userEvent.setup();
    setupAgents([['a1', 'Alpha']]);
    render(<CompactAllAgentsPanel threadId="t1" />);

    await user.click(await screen.findByRole('button', { name: /compress all \(1\)/i }));
    expect(screen.getByText(/compress all agent contexts\?/i)).toBeTruthy();
    // Confirm copy is dialog-unique ("can take a while" only appears in the modal).
    expect(screen.getByText(/can take a while/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByText(/compress all agent contexts\?/i)).toBeNull());
    expect(compactAgent).not.toHaveBeenCalled();
  });

  it('on confirm, disables the trigger while the sweep runs, then reports success', async () => {
    const user = userEvent.setup();
    setupAgents([
      ['a1', 'Alpha'],
      ['a2', 'Beta'],
    ]);
    const first = deferred<{ agentId: string; durationMs: number }>();
    compactAgent
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ agentId: 'a2', durationMs: 1 });

    render(<CompactAllAgentsPanel threadId="t1" />);
    await user.click(await screen.findByRole('button', { name: /compress all \(2\)/i }));
    await user.click(screen.getByRole('button', { name: 'Compress all' })); // confirm

    // Sweep in flight on the first agent: trigger disabled + progress label.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /compressing/i })).toBeDisabled();
    });

    first.resolve({ agentId: 'a1', durationMs: 1 });

    await waitFor(() => expect(screen.getByText(/compressed 2 of 2/i)).toBeTruthy());
    expect(compactAgent).toHaveBeenCalledTimes(2);
    expect(compactAgent).toHaveBeenNthCalledWith(1, 't1', 'a1');
    expect(compactAgent).toHaveBeenNthCalledWith(2, 't1', 'a2');
  });

  it('reports a failing agent inline without aborting the rest', async () => {
    const user = userEvent.setup();
    setupAgents([
      ['a1', 'Alpha'],
      ['a2', 'Beta'],
      ['a3', 'Gamma'],
    ]);
    compactAgent.mockImplementation(async (_threadId: string, agentId: string) => {
      if (agentId === 'a2') throw new Error('provider exploded');
      return { agentId, durationMs: 1 };
    });

    render(<CompactAllAgentsPanel threadId="t1" />);
    await user.click(await screen.findByRole('button', { name: /compress all \(3\)/i }));
    await user.click(screen.getByRole('button', { name: 'Compress all' }));

    await waitFor(() => expect(screen.getByText(/compressed 2 of 3 · 1 failed/i)).toBeTruthy());
    // All three attempted despite the middle failure.
    expect(compactAgent).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/provider exploded/i)).toBeTruthy();
  });
});
