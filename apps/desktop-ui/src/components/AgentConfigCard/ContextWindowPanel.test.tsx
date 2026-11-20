import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadContextUsage } from '@desktop/utils/api/threads';
import { ContextWindowPanel } from './ContextWindowPanel';

const api = vi.hoisted(() => ({
  getContextUsage: vi.fn(),
  getCompactStatus: vi.fn(),
  compactAgent: vi.fn(),
}));

/** Capturing WS stub so tests can push frames at the panel's listener. */
const ws = vi.hoisted(() => {
  const listeners = new Set<(msg: unknown) => void>();
  return {
    listeners,
    emit: (msg: unknown) => {
      for (const listener of [...listeners]) listener(msg);
    },
  };
});

vi.mock('@desktop/utils/api/threads', () => ({ threadsApi: api }));
vi.mock('@desktop/ws/useWs', () => ({
  useWs: () => ({
    addMessageListener: (fn: (msg: unknown) => void) => {
      ws.listeners.add(fn);
      return () => ws.listeners.delete(fn);
    },
  }),
}));

function usage(
  provider: string,
  model: string | null,
  contextWindowTokens: number
): ThreadContextUsage {
  return {
    threadId: 'thread-1',
    agentId: 'agent-1',
    provider,
    model,
    tokens: {
      estimated: 1_000,
      raw: 1_000,
      compressed: false,
      keptMessages: 2,
      threadSummaryUsed: false,
      messagesCounted: 2,
      messageTokens: 675,
      systemPromptChars: 100,
      systemPromptTokens: 25,
      toolCatalogTokens: 300,
      toolCount: 12,
    },
    budget: {
      contextWindowTokens,
      maxOutputTokens: 1_000,
      usableBudget: contextWindowTokens - 1_025,
      tokenThreshold: Math.floor((contextWindowTokens - 1_025) * 0.6),
    },
    percent: (1_000 / contextWindowTokens) * 100,
    percentOfUsable: (1_000 / (contextWindowTokens - 1_025)) * 100,
    source: 'character-estimate',
    latestSummary: null,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const MODEL_A = { providerId: 'provider-a', modelId: 'model-a' };
const MODEL_B = { providerId: 'provider-a', modelId: 'model-b' };
const PROVIDER_B_MODEL = { providerId: 'provider-b', modelId: 'model-b' };

async function openContextWindow(): Promise<void> {
  const toggle = screen.getByRole('button', { name: /context window/i });
  if (toggle.getAttribute('aria-expanded') === 'false') {
    await userEvent.setup().click(toggle);
  }
}

beforeEach(() => {
  api.getContextUsage.mockReset();
  api.getCompactStatus.mockReset().mockResolvedValue({ compacting: false, since: null });
  api.compactAgent.mockReset().mockResolvedValue(undefined);
  ws.listeners.clear();
});

describe('ContextWindowPanel effective-model refresh', () => {
  it('hides the old budget while a model change reloads authoritative usage', async () => {
    const next = deferred<ThreadContextUsage>();
    api.getContextUsage
      .mockResolvedValueOnce(usage('provider-a', 'model-a', 8_192))
      .mockReturnValueOnce(next.promise);

    const view = render(
      <ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_A} />
    );
    expect(await screen.findByText(/1,000 \/ 8,192 tokens/)).toBeInTheDocument();

    view.rerender(
      <ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_B} />
    );
    expect(screen.queryByText(/1,000 \/ 8,192 tokens/)).toBeNull();
    expect(screen.getByText('Estimating…')).toBeInTheDocument();

    await act(async () => next.resolve(usage('provider-a', 'model-b', 131_072)));
    expect(await screen.findByText(/1,000 \/ 131,072 tokens/)).toBeInTheDocument();
  });

  it('reloads when only the provider changes', async () => {
    api.getContextUsage
      .mockResolvedValueOnce(usage('provider-a', 'model-a', 8_192))
      .mockResolvedValueOnce(usage('provider-b', 'model-b', 200_000));
    const view = render(
      <ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_A} />
    );
    await screen.findByText(/1,000 \/ 8,192 tokens/);

    view.rerender(
      <ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={PROVIDER_B_MODEL} />
    );

    expect(await screen.findByText(/1,000 \/ 200,000 tokens/)).toBeInTheDocument();
    expect(api.getContextUsage).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest model when an older request resolves last', async () => {
    const requestA = deferred<ThreadContextUsage>();
    const requestB = deferred<ThreadContextUsage>();
    api.getContextUsage.mockReturnValueOnce(requestA.promise).mockReturnValueOnce(requestB.promise);

    const view = render(
      <ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_A} />
    );
    await waitFor(() => expect(api.getContextUsage).toHaveBeenCalledTimes(1));
    view.rerender(
      <ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_B} />
    );
    await waitFor(() => expect(api.getContextUsage).toHaveBeenCalledTimes(2));

    await act(async () => requestB.resolve(usage('provider-a', 'model-b', 131_072)));
    expect(await screen.findByText(/1,000 \/ 131,072 tokens/)).toBeInTheDocument();
    await act(async () => requestA.resolve(usage('provider-a', 'model-a', 8_192)));

    expect(screen.getByText(/1,000 \/ 131,072 tokens/)).toBeInTheDocument();
    expect(screen.queryByText(/1,000 \/ 8,192 tokens/)).toBeNull();
  });

  it('rejects mismatched or missing model metadata instead of showing a false budget', async () => {
    api.getContextUsage.mockResolvedValue(usage('provider-a', null, 8_192));
    render(<ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_B} />);
    await openContextWindow();

    expect(
      await screen.findByText(
        'Context usage is unavailable for provider-a · model-b. The server did not return matching model metadata.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/1,000 \/ 8,192 tokens/)).toBeNull();
  });

  it('shows a truthful unavailable state and does not fetch without an effective model', async () => {
    render(<ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={null} />);
    await openContextWindow();

    expect(
      screen.getByText('Context usage unavailable: no effective model configured.')
    ).toBeInTheDocument();
    expect(api.getContextUsage).not.toHaveBeenCalled();
  });

  it('surfaces the current request error without retaining the prior budget', async () => {
    api.getContextUsage.mockRejectedValue(new Error('metadata lookup failed'));
    render(<ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_A} />);
    await openContextWindow();

    expect(await screen.findByText('metadata lookup failed')).toBeInTheDocument();
    expect(screen.queryByText(/tokens ·/)).toBeNull();
  });

  it('does not refetch an unchanged selection but reloads persisted selection on remount', async () => {
    api.getContextUsage.mockResolvedValue(usage('provider-a', 'model-a', 8_192));
    const view = render(
      <ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_A} />
    );
    await screen.findByText(/1,000 \/ 8,192 tokens/);

    view.rerender(
      <ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={{ ...MODEL_A }} />
    );
    expect(api.getContextUsage).toHaveBeenCalledTimes(1);

    view.unmount();
    render(<ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_A} />);
    await waitFor(() => expect(api.getContextUsage).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/1,000 \/ 8,192 tokens/)).toBeInTheDocument();
  });
});

describe('ContextWindowPanel disclosure and labels', () => {
  it('keeps the summary and Compact action accessible while diagnostics are collapsed', async () => {
    api.getContextUsage.mockResolvedValue(usage('provider-a', 'model-a', 8_192));
    render(<ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_A} />);

    const toggle = screen.getByRole('button', { name: /context window/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await screen.findByText('1,000 / 8,192 tokens · 12.2%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compact' })).toBeEnabled();
    expect(screen.getByText('Auto-compaction')).toBeInTheDocument();
    expect(
      screen.getByText(/Messages 675 \/ 4,300 tokens · 15\.7% of compaction threshold/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Auto-compaction threshold usage' })
    ).toHaveAttribute('aria-valuenow', '15.7');
    expect(screen.queryByText('Current context')).toBeNull();
  });

  it('reveals revised labels and spelled-out token units', async () => {
    api.getContextUsage.mockResolvedValue(usage('provider-a', 'model-a', 8_192));
    render(<ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_A} />);
    await screen.findByText('1,000 / 8,192 tokens · 12.2%');
    await openContextWindow();

    expect(
      screen.getByText(/Messages 675 \/ 4,300 tokens · 15\.7% of compaction threshold/)
    ).toBeInTheDocument();
    expect(screen.getByText('Auto-compaction')).toBeInTheDocument();
    expect(screen.getByText('Current context')).toBeInTheDocument();
    expect(screen.queryByText('Context this request')).toBeNull();
    expect(screen.getAllByText('1,000 / 8,192 tokens · 12.2%')).toHaveLength(2);
    expect(screen.queryByText(/of model window/i)).toBeNull();
    expect(screen.getByText(/7,167 tokens · messages at 14% of usable/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\btok\b/);
    expect(
      screen.getByRole('progressbar', { name: 'Auto-compaction threshold usage' })
    ).toHaveAttribute('aria-valuenow', '15.7');
  });
});

/**
 * "Last compacted … ago" follows the latest summary: run-end auto-compaction
 * broadcasts only `socket:thread:summary` (never compact:*), and the anchor
 * is the summary version's createdAt, not the node row's updatedAt.
 */
describe('ContextWindowPanel last-compacted anchoring', () => {
  function summarized(
    latestSummary: NonNullable<ThreadContextUsage['latestSummary']>
  ): ThreadContextUsage {
    return { ...usage('provider-a', 'model-a', 8_192), latestSummary };
  }

  it('anchors to the summary version creation time, not the node updatedAt', async () => {
    api.getContextUsage.mockResolvedValue(
      summarized({
        version: 3,
        createdAt: new Date(Date.now() - 30_000).toISOString(),
        updatedAt: new Date(Date.now() - 27 * 60_000).toISOString(),
        messagesCovered: 12,
      })
    );
    render(<ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_A} />);
    await openContextWindow();

    expect(await screen.findByText(/Last compacted v3 · 30s ago/)).toBeInTheDocument();
  });

  it('falls back to updatedAt when an older server sends no createdAt', async () => {
    api.getContextUsage.mockResolvedValue(
      summarized({
        version: 2,
        updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        messagesCovered: 8,
      })
    );
    render(<ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_A} />);
    await openContextWindow();

    expect(await screen.findByText(/Last compacted v2 · 5m ago/)).toBeInTheDocument();
  });

  it('re-anchors when an auto-compaction lands via socket:thread:summary', async () => {
    const staleAt = new Date(Date.now() - 27 * 60_000).toISOString();
    api.getContextUsage
      .mockResolvedValueOnce(
        summarized({ version: 3, createdAt: staleAt, updatedAt: staleAt, messagesCovered: 10 })
      )
      .mockResolvedValueOnce(
        summarized({
          version: 4,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messagesCovered: 14,
        })
      );
    render(<ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_A} />);
    await openContextWindow();
    expect(await screen.findByText(/Last compacted v3 · 27m ago/)).toBeInTheDocument();

    await act(async () => {
      ws.emit({
        type: 'socket:thread:summary',
        payload: {
          threadId: 'thread-1',
          agentId: 'agent-1',
          summaryId: 'summary-4',
          messagesCovered: 14,
          summaryText: 'summary',
        },
      });
    });

    // Refetched (forcing the summary into the estimate) and re-anchored: the
    // panel confirms the compaction that just landed instead of showing the
    // previous version's 27-minute-old timestamp.
    await waitFor(() => expect(api.getContextUsage).toHaveBeenCalledTimes(2));
    expect(api.getContextUsage).toHaveBeenLastCalledWith('thread-1', 'agent-1', {
      applySummary: 'force',
    });
    expect(await screen.findByText(/Just compacted · v4/)).toBeInTheDocument();
    expect(screen.queryByText(/27m ago/)).toBeNull();
  });

  it('ignores summary frames scoped to another agent or thread', async () => {
    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    api.getContextUsage.mockResolvedValue(
      summarized({ version: 1, createdAt: staleAt, updatedAt: staleAt, messagesCovered: 4 })
    );
    render(<ContextWindowPanel threadId="thread-1" agentId="agent-1" effectiveModel={MODEL_A} />);
    await openContextWindow();
    await screen.findByText(/Last compacted v1 · 10m ago/);

    await act(async () => {
      ws.emit({
        type: 'socket:thread:summary',
        payload: { threadId: 'thread-1', agentId: 'agent-2', summaryId: 's', summaryText: 'x' },
      });
      ws.emit({
        type: 'socket:thread:summary',
        payload: { threadId: 'thread-9', agentId: 'agent-1', summaryId: 's', summaryText: 'x' },
      });
    });

    expect(api.getContextUsage).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Last compacted v1 · 10m ago/)).toBeInTheDocument();
  });
});
