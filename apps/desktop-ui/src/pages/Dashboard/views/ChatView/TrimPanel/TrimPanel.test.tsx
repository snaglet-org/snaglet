/**
 * TrimPanel + useThreadTrim: the destructive control strip, driven through the
 * real hook (a small harness stands in for ChatView, which owns the state).
 * Handle moves keep the requested range, figures go stale rather than blank,
 * a noop plan or busy thread refuses to apply, and a failed apply keeps the
 * dialog up. The thread pane's dimming is tested in MessageList.trim.test.tsx.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { emptyThreadTrimTotals } from '@snaglet/shared/types';
import type {
  ThreadTrimBoundary,
  ThreadTrimPreview,
  ThreadTrimStats,
  ThreadTrimTotals,
} from '@snaglet/shared/types';
import { threadTrimApi } from '@desktop/utils/api/threadTrim';
import { TrimPanel } from './TrimPanel';
import { useThreadTrim, type UseThreadTrimResult } from './useThreadTrim';

vi.mock('@desktop/utils/api/threadTrim', () => ({
  threadTrimApi: { getStats: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));

const getStats = vi.mocked(threadTrimApi.getStats);
const previewApi = vi.mocked(threadTrimApi.preview);
const applyApi = vi.mocked(threadTrimApi.apply);

const THREAD_ID = 'thread-1';

/* fixtures */

function totals(messages: number, bytes = messages * 100, summaries = 0): ThreadTrimTotals {
  const empty = emptyThreadTrimTotals();
  return {
    ...empty,
    messages,
    summaries,
    bytes: { ...empty.bytes, messages: bytes, total: bytes },
  };
}

function stats(over: Partial<ThreadTrimStats> = {}): ThreadTrimStats {
  return { threadId: THREAD_ID, messageCount: 10, totals: totals(10), threadBusy: false, ...over };
}

function boundary(messageId: string, index: number): ThreadTrimBoundary {
  return {
    messageId,
    index,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    role: index % 2 === 0 ? 'user' : 'assistant',
    agentId: null,
    userId: null,
    authorLabel: 'Test User',
  };
}

interface PreviewSpec {
  first?: [string, number];
  last?: [string, number];
  sides: ThreadTrimPreview['sides'];
  removedMessages: number;
  remainingMessages?: number;
  expanded?: boolean;
  /** Whole-thread summary count (0: the thread never compacted). */
  summaries?: number;
}

function previewOf(spec: PreviewSpec): ThreadTrimPreview {
  const first = spec.first ?? (['m0', 0] as [string, number]);
  const last = spec.last ?? (['m9', 9] as [string, number]);
  return {
    threadId: THREAD_ID,
    sides: spec.sides,
    removeSummaries: false,
    requested: { firstRetainedIndex: first[1], lastRetainedIndex: last[1] },
    firstRetained: boundary(...first),
    lastRetained: boundary(...last),
    expandedForRunAtomicity: spec.expanded ?? false,
    totals: totals(10, 1000, spec.summaries ?? 0),
    removed: totals(spec.removedMessages),
    remaining: totals(spec.remainingMessages ?? 10 - spec.removedMessages),
    summaryImpact: {
      removedByChoice: 0,
      removedAsInvalidated: 0,
      preserved: 0,
      repairedCoverage: 0,
      removed: 0,
      removedBytes: 0,
    },
    noop: spec.removedMessages === 0,
    threadBusy: false,
    token: 'plan-token',
    tokenTtlMs: 60_000,
  };
}

const keepEverything = (): ThreadTrimPreview => previewOf({ sides: 'none', removedMessages: 0 });

/* harness */

/**
 * Stands in for ChatView, which owns the trim state so the message list can
 * dim against the same resolved plan the panel prices.
 */
function Harness({
  threadId = THREAD_ID,
  onTrimmed,
  onCancel,
  expose,
}: {
  threadId?: string;
  onTrimmed?: (
    result: Parameters<NonNullable<Parameters<typeof TrimPanel>[0]['onTrimmed']>>[0]
  ) => void;
  onCancel?: () => void;
  expose?: (trim: UseThreadTrimResult) => void;
}) {
  const trim = useThreadTrim(threadId);
  expose?.(trim);
  return (
    <TrimPanel
      trim={trim}
      {...(onTrimmed ? { onTrimmed } : {})}
      {...(onCancel ? { onCancel } : {})}
    />
  );
}

const tally = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('[data-tid="trimImpact"]');
  if (!el) throw new Error('impact tally not rendered');
  return el;
};

const firstHandle = (): HTMLElement =>
  screen.getByRole('slider', { name: 'First retained message' });
const lastHandle = (): HTMLElement => screen.getByRole('slider', { name: 'Last retained message' });
const trimButton = (): HTMLElement => screen.getByRole('button', { name: 'Trim…' });

const settled = async (): Promise<void> => {
  await waitFor(() => expect(previewApi).toHaveBeenCalled());
  await waitFor(() => expect(tally().dataset.stale).toBeUndefined());
};

beforeEach(() => {
  vi.clearAllMocks();
  getStats.mockResolvedValue(stats());
  previewApi.mockResolvedValue(keepEverything());
});

/* the scrubber */

describe('TrimPanel — the scrubber', () => {
  it('seeds both handles to "keep everything" and prices that', async () => {
    render(<Harness />);
    await settled();

    expect(firstHandle()).toHaveAttribute('aria-valuenow', '0');
    expect(lastHandle()).toHaveAttribute('aria-valuenow', '9');
    expect(previewApi).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ firstRetainedIndex: 0, lastRetainedIndex: 9 })
    );
  });

  it('moves the first handle locally and prices the new interval', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await settled();
    previewApi.mockClear();
    previewApi.mockResolvedValue(
      previewOf({ first: ['m3', 3], sides: 'prefix', removedMessages: 3 })
    );

    firstHandle().focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');

    // The handle answers to the keystroke, not to the server.
    expect(firstHandle()).toHaveAttribute('aria-valuenow', '3');
    await waitFor(() =>
      expect(previewApi).toHaveBeenCalledWith(
        THREAD_ID,
        expect.objectContaining({ firstRetainedIndex: 3, lastRetainedIndex: 9 })
      )
    );
    await waitFor(() => expect(tally().textContent).toContain('Removing'));
    expect(tally().textContent).toContain('3');
  });

  it('moves the last handle and prices a tail cut', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await settled();
    previewApi.mockClear();
    previewApi.mockResolvedValue(previewOf({ last: ['m7', 7], sides: 'tail', removedMessages: 2 }));

    lastHandle().focus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');

    expect(lastHandle()).toHaveAttribute('aria-valuenow', '7');
    await waitFor(() =>
      expect(previewApi).toHaveBeenCalledWith(
        THREAD_ID,
        expect.objectContaining({ firstRetainedIndex: 0, lastRetainedIndex: 7 })
      )
    );
  });

  it('asks the pane to seek to whichever handle moved', async () => {
    const user = userEvent.setup();
    const seen: { trim: UseThreadTrimResult | null } = { trim: null };
    render(
      <Harness
        expose={(trim) => {
          seen.trim = trim;
        }}
      />
    );
    await settled();
    // Opening the panel must not scroll the thread out from under the user.
    expect(seen.trim?.seekRequest).toBeNull();

    lastHandle().focus();
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(seen.trim?.seekRequest?.edge).toBe('last'));

    firstHandle().focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(seen.trim?.seekRequest?.edge).toBe('first'));
  });

  it('never lets the server reposition a handle under the user', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await settled();

    // The server widens the kept span back to m0 to keep a run whole. The
    // handle must stay where the user put it (otherwise a drag jumps
    // backwards every time a response lands), and the warning must survive.
    previewApi.mockResolvedValue(
      previewOf({ first: ['m0', 0], sides: 'none', removedMessages: 0, expanded: true })
    );

    firstHandle().focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(firstHandle()).toHaveAttribute('aria-valuenow', '2');

    await waitFor(() =>
      expect(screen.getByText(/widened to keep agent runs whole/i)).toBeVisible()
    );
    expect(firstHandle()).toHaveAttribute('aria-valuenow', '2');
    // …and the request keeps carrying what the user asked for, so the warning
    // cannot retract itself on the next round trip.
    expect(previewApi).toHaveBeenLastCalledWith(
      THREAD_ID,
      expect.objectContaining({ firstRetainedIndex: 2 })
    );
  });

  it('pushes the other handle rather than letting them cross', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await settled();

    lastHandle().focus();
    await user.keyboard('{Home}');

    expect(lastHandle()).toHaveAttribute('aria-valuenow', '0');
    expect(firstHandle()).toHaveAttribute('aria-valuenow', '0');
  });

  it('states where the handles ARE, never its own count of what is removed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await settled();
    // The server keeps two more messages than asked for, to hold a run whole.
    previewApi.mockResolvedValue(
      previewOf({ first: ['m1', 1], sides: 'prefix', removedMessages: 1, expanded: true })
    );

    firstHandle().focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    await waitFor(() => expect(tally().textContent).toContain('Removing'));

    // Only one removal figure on the panel, and it is the server's.
    const span = document.querySelector('[data-tid="trimSpanLabel"]');
    expect(span?.textContent).toContain('keeping 4–10 of 10');
    expect(span?.textContent).not.toMatch(/removed/i);
    expect(tally().textContent).toContain('Removing');
    expect(tally().textContent).toContain('1');
  });
});

/* jump to the cut */

describe('TrimPanel — Jump to prefix / Jump to tail', () => {
  const jumpPrefix = (): HTMLElement => screen.getByRole('button', { name: 'Jump to prefix' });
  const jumpTail = (): HTMLElement => screen.getByRole('button', { name: 'Jump to tail' });

  it('offers neither jump while the plan cuts nothing', async () => {
    render(<Harness />);
    await settled();

    expect(jumpPrefix()).toBeDisabled();
    expect(jumpTail()).toBeDisabled();
  });

  it('enables only the side the resolved plan actually cuts', async () => {
    previewApi.mockResolvedValue(
      previewOf({ first: ['m2', 2], sides: 'prefix', removedMessages: 2 })
    );
    render(<Harness />);
    await waitFor(() => expect(jumpPrefix()).toBeEnabled());
    // Nothing is removed after the kept range, so jumping there would be a lie.
    expect(jumpTail()).toBeDisabled();
  });

  it('enables the tail jump for a tail-only cut', async () => {
    previewApi.mockResolvedValue(previewOf({ last: ['m7', 7], sides: 'tail', removedMessages: 2 }));
    render(<Harness />);
    await waitFor(() => expect(jumpTail()).toBeEnabled());
    expect(jumpPrefix()).toBeDisabled();
  });

  it('seeks the pane to each boundary, and re-seeks on every press', async () => {
    const user = userEvent.setup();
    const seen: { trim: UseThreadTrimResult | null } = { trim: null };
    previewApi.mockResolvedValue(
      previewOf({ first: ['m2', 2], last: ['m7', 7], sides: 'both', removedMessages: 4 })
    );
    render(
      <Harness
        expose={(trim) => {
          seen.trim = trim;
        }}
      />
    );
    await waitFor(() => expect(jumpPrefix()).toBeEnabled());

    await user.click(jumpPrefix());
    await waitFor(() => expect(seen.trim?.seekRequest?.edge).toBe('first'));
    const first = seen.trim?.seekRequest?.nonce ?? 0;

    await user.click(jumpTail());
    await waitFor(() => expect(seen.trim?.seekRequest?.edge).toBe('last'));

    // Pressing the same button again must move the pane again — the user may
    // have scrolled away in between.
    await user.click(jumpPrefix());
    await waitFor(() => expect(seen.trim?.seekRequest?.edge).toBe('first'));
    expect(seen.trim?.seekRequest?.nonce).toBeGreaterThan(first);
  });

  it('stays usable while an agent is running — looking is not destructive', async () => {
    getStats.mockResolvedValue(stats({ threadBusy: true }));
    previewApi.mockResolvedValue(
      previewOf({ first: ['m2', 2], sides: 'prefix', removedMessages: 2 })
    );
    render(<Harness />);
    await waitFor(() => expect(jumpPrefix()).toBeEnabled());
    expect(trimButton()).toBeDisabled();
  });
});

/* figures in flight */

describe('TrimPanel — figures in flight', () => {
  it('marks the last settled figures stale instead of blanking them', async () => {
    const user = userEvent.setup();
    // A thread with summaries, so the "Remove summaries" toggle is offered.
    getStats.mockResolvedValue(stats({ totals: totals(10, 1000, 2) }));
    previewApi.mockResolvedValueOnce(
      previewOf({ first: ['m3', 3], sides: 'prefix', removedMessages: 3, summaries: 2 })
    );

    render(<Harness />);
    await waitFor(() => expect(tally().textContent).toContain('Removing'));
    expect(tally().textContent).toContain('3');
    expect(tally().dataset.stale).toBeUndefined();

    let release!: (value: ThreadTrimPreview) => void;
    previewApi.mockImplementationOnce(
      () =>
        new Promise<ThreadTrimPreview>((resolve) => {
          release = resolve;
        })
    );

    await user.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(tally().dataset.stale).toBe('true'));
    // Stale, NOT blank: the previous answer is still readable.
    expect(tally().textContent).toContain('Removing');
    expect(tally().textContent).toContain('3');

    release(previewOf({ first: ['m5', 5], sides: 'prefix', removedMessages: 5, summaries: 2 }));
    await waitFor(() => expect(tally().textContent).toContain('5'));
    expect(tally().dataset.stale).toBeUndefined();
  });

  it('surfaces a preview failure in place of the figures', async () => {
    previewApi.mockRejectedValue(new Error('Could not reach the server'));
    render(<Harness />);
    await waitFor(() => expect(tally().textContent).toContain('Could not reach the server'));
  });

  it('surfaces a stats failure with a retry', async () => {
    getStats.mockRejectedValue(new Error('Could not read thread totals'));
    render(<Harness />);
    await screen.findByText('Could not read thread totals');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

/* remove summaries */

describe('TrimPanel — Remove summaries', () => {
  it('is not offered when the thread has no summaries', async () => {
    render(<Harness />);
    await settled();
    expect(screen.queryByRole('checkbox', { name: /remove summaries/i })).toBeNull();
    expect(previewApi).toHaveBeenLastCalledWith(
      THREAD_ID,
      expect.objectContaining({ removeSummaries: false })
    );
  });

  it('is offered when the thread has summaries, and prices the choice', async () => {
    const user = userEvent.setup();
    getStats.mockResolvedValue(stats({ totals: totals(10, 1000, 3) }));
    previewApi.mockResolvedValue(previewOf({ sides: 'none', removedMessages: 0, summaries: 3 }));
    render(<Harness />);
    await settled();

    await user.click(screen.getByRole('checkbox', { name: /remove summaries/i }));
    await waitFor(() =>
      expect(previewApi).toHaveBeenLastCalledWith(
        THREAD_ID,
        expect.objectContaining({ removeSummaries: true })
      )
    );
  });

  it('drops a checked choice once the thread has no summaries left', async () => {
    const user = userEvent.setup();
    getStats.mockResolvedValue(stats({ totals: totals(10, 1000, 1) }));
    previewApi.mockResolvedValue(previewOf({ sides: 'none', removedMessages: 0, summaries: 1 }));
    let latest!: UseThreadTrimResult;
    render(<Harness expose={(trim) => (latest = trim)} />);
    await settled();
    await user.click(screen.getByRole('checkbox', { name: /remove summaries/i }));
    await waitFor(() => expect(latest.removeSummaries).toBe(true));

    // The next preview reports none left (they were trimmed away).
    previewApi.mockResolvedValue(previewOf({ sides: 'none', removedMessages: 0, summaries: 0 }));
    latest.refresh();
    await waitFor(() => expect(latest.removeSummaries).toBe(false));
    expect(screen.queryByRole('checkbox', { name: /remove summaries/i })).toBeNull();
  });
});

/* the destructive action */

describe('TrimPanel — confirming a trim', () => {
  it('disables the action while the plan is a noop', async () => {
    render(<Harness />);
    await settled();
    expect(trimButton()).toBeDisabled();
  });

  it('disables the action while an agent is running in the thread', async () => {
    getStats.mockResolvedValue(stats({ threadBusy: true }));
    previewApi.mockResolvedValue(
      previewOf({ first: ['m2', 2], sides: 'prefix', removedMessages: 2 })
    );

    render(<Harness />);
    await settled();

    expect(await screen.findByRole('status')).toHaveTextContent('An agent is running');
    expect(trimButton()).toBeDisabled();
  });

  it('enables the action once the plan removes something', async () => {
    previewApi.mockResolvedValue(
      previewOf({ first: ['m2', 2], sides: 'prefix', removedMessages: 2 })
    );
    render(<Harness />);
    await waitFor(() => expect(trimButton()).toBeEnabled());
  });

  it('keeps the dialog open and shows the error when apply fails', async () => {
    const user = userEvent.setup();
    previewApi.mockResolvedValue(
      previewOf({ first: ['m2', 2], sides: 'prefix', removedMessages: 2 })
    );
    applyApi.mockRejectedValue(new Error('Thread changed under the preview'));

    render(<Harness />);
    await waitFor(() => expect(trimButton()).toBeEnabled());

    await user.click(trimButton());
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Trim' }));

    await waitFor(() =>
      expect(within(dialog).getByText('Thread changed under the preview')).toBeInTheDocument()
    );
    // Still open — a failed destructive action must not vanish silently.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(applyApi).toHaveBeenCalledTimes(1);
  });

  it('submits the reviewed plan verbatim, token included', async () => {
    const user = userEvent.setup();
    const onTrimmed = vi.fn();
    previewApi.mockResolvedValue(
      previewOf({ first: ['m2', 2], sides: 'prefix', removedMessages: 2 })
    );
    applyApi.mockResolvedValue({
      threadId: THREAD_ID,
      sides: 'prefix',
      removeSummaries: false,
      firstRetainedMessageId: 'm2',
      lastRetainedMessageId: 'm9',
      removed: totals(2),
      remaining: totals(8),
      summaryImpact: {
        removedByChoice: 0,
        removedAsInvalidated: 0,
        preserved: 0,
        repairedCoverage: 0,
        removed: 0,
        removedBytes: 0,
      },
      anchorMessageId: 'm2',
    });

    render(<Harness onTrimmed={onTrimmed} />);
    await waitFor(() => expect(trimButton()).toBeEnabled());

    await user.click(trimButton());
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Trim' }));

    await waitFor(() =>
      expect(applyApi).toHaveBeenCalledWith(THREAD_ID, {
        firstRetainedMessageId: 'm2',
        lastRetainedMessageId: 'm9',
        removeSummaries: false,
        token: 'plan-token',
      })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onTrimmed).toHaveBeenCalledTimes(1);
  });
});

/* leaving without trimming */

describe('TrimPanel — Cancel', () => {
  it('leaves without deleting anything, beside the confirmed Trim action', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    previewApi.mockResolvedValue(
      previewOf({ first: ['m2', 2], sides: 'prefix', removedMessages: 2 })
    );

    render(<Harness onCancel={onCancel} />);
    await waitFor(() => expect(trimButton()).toBeEnabled());

    // Trim still routes through its confirmation dialog, and dismissing that
    // dialog leaves the panel (and its Cancel) in place.
    await user.click(trimButton());
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onCancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(applyApi).not.toHaveBeenCalled();
  });

  it('offers Cancel when there is nothing to trim or the size failed to load', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    getStats.mockResolvedValue(stats({ messageCount: 0, totals: totals(0) }));
    const { unmount } = render(<Harness onCancel={onCancel} />);
    await waitFor(() => expect(screen.getByText(/no messages to trim/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();

    getStats.mockRejectedValue(new Error('stats down'));
    render(<Harness onCancel={onCancel} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});

/* inert while closed */

describe('TrimPanel — while the panel is closed', () => {
  it('fetches nothing when ChatView passes no thread', async () => {
    render(<Harness threadId="" />);
    await waitFor(() => expect(screen.getByText(/no messages to trim/i)).toBeInTheDocument());
    expect(getStats).not.toHaveBeenCalled();
    expect(previewApi).not.toHaveBeenCalled();
  });
});
