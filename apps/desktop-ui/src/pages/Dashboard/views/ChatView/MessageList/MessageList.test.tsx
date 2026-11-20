/**
 * MessageList — context-compaction divider injection.
 *
 * The divider is derived purely client-side: for a given agent, the per-message
 * `usage.inputTokens` (the prompt size the model was actually sent) grows
 * turn-over-turn as the conversation accumulates, and the only thing that
 * shrinks it is the agent's context being compacted. So a meaningful drop
 * vs. that agent's previous turn marks the later message as a compaction point,
 * and the list renders a dotted "Agent context compacted" divider above it.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadMessage } from '@desktop/utils/api';
import type { RunActivity } from '../hooks/types';

// MessageList value-imports the API barrel (via MessageRow), whose config
// module throws at import when VITE_API_BASE_URL is unset. Stub the env before
// those imports load, matching MessageRow.test.tsx.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { MessageList, computeCompactionMessageIds, memoryExtractionLabel } from './MessageList';
import type { MemoryExtractionNotice } from '../hooks/types';

function assistant(over: Partial<ThreadMessage> & { id: string }): ThreadMessage {
  return {
    threadId: 'thread-1',
    role: 'assistant',
    agentId: 'a1',
    content: `reply ${over.id}`,
    createdAt: `2026-07-04T00:00:0${over.id.replace(/\D/g, '')}.000Z`,
    ...over,
  };
}

describe('computeCompactionMessageIds', () => {
  it('flags the message whose agent input-token count dropped past the ratio', () => {
    const rows = [
      { message: assistant({ id: 'm1', usage: { inputTokens: 1000 } }) },
      { message: assistant({ id: 'm2', usage: { inputTokens: 2000 } }) },
      { message: assistant({ id: 'm3', usage: { inputTokens: 800 } }) }, // compaction
      { message: assistant({ id: 'm4', usage: { inputTokens: 1200 } }) }, // grows again
    ];
    const ids = computeCompactionMessageIds(rows);
    expect([...ids]).toEqual(['m3']);
  });

  it('ignores a trivial dip below the 10% threshold (provider jitter)', () => {
    const rows = [
      { message: assistant({ id: 'm1', usage: { inputTokens: 2000 } }) },
      { message: assistant({ id: 'm2', usage: { inputTokens: 1950 } }) }, // ~2.5% dip
    ];
    expect(computeCompactionMessageIds(rows).size).toBe(0);
  });

  it('tracks agents independently in a multi-agent thread', () => {
    const rows = [
      { message: assistant({ id: 'a1-1', agentId: 'a1', usage: { inputTokens: 5000 } }) },
      { message: assistant({ id: 'a2-1', agentId: 'a2', usage: { inputTokens: 1000 } }) },
      { message: assistant({ id: 'a1-2', agentId: 'a1', usage: { inputTokens: 900 } }) }, // a1 compaction
      { message: assistant({ id: 'a2-2', agentId: 'a2', usage: { inputTokens: 2000 } }) }, // a2 grows
    ];
    expect([...computeCompactionMessageIds(rows)]).toEqual(['a1-2']);
  });

  it('ignores user messages and rows without usage', () => {
    const rows = [
      { message: assistant({ id: 'm1', usage: { inputTokens: 3000 } }) },
      { message: { ...assistant({ id: 'u1' }), role: 'user', usage: null } },
      { message: assistant({ id: 'm2' }) }, // no usage
      { message: undefined }, // activity-only stub
      { message: assistant({ id: 'm3', usage: { inputTokens: 500 } }) }, // vs m1 → compaction
    ];
    expect([...computeCompactionMessageIds(rows)]).toEqual(['m3']);
  });

  it('flags a reply whose run compacted its own context, even when its prompt grew', () => {
    const rows = [
      { message: assistant({ id: 'm1', usage: { inputTokens: 1000 } }) },
      { message: assistant({ id: 'm2', usage: { inputTokens: 1500, runCompactions: 2 } }) },
      { message: assistant({ id: 'm3', usage: { inputTokens: 1400 } }) }, // ordinary jitter
      { message: assistant({ id: 'm4', usage: { runCompactions: 1 } }) }, // no prompt size
    ];
    expect([...computeCompactionMessageIds(rows)]).toEqual(['m2', 'm4']);
  });
});

describe('MessageList — divider rendering', () => {
  const noActivities = new Map<string, RunActivity>();
  const agentNameById = new Map<string, string>([['a1', 'Nova']]);

  it('renders a single compaction divider above the message whose context was compacted', () => {
    const messages: ThreadMessage[] = [
      assistant({ id: 'm1', runId: 'r1', usage: { inputTokens: 1000 } }),
      assistant({ id: 'm2', runId: 'r2', usage: { inputTokens: 2000 } }),
      assistant({ id: 'm3', runId: 'r3', usage: { inputTokens: 800 } }),
    ];
    const { container } = render(
      <MessageList
        messages={messages}
        activities={noActivities}
        agentNameById={agentNameById}
        loading={false}
        renderMode="raw"
      />
    );

    const dividers = container.querySelectorAll('[data-tid="compactionDivider"]');
    expect(dividers).toHaveLength(1);
    expect(dividers[0]?.textContent).toContain('Agent context compacted');

    // The divider must sit immediately before the compacted message row. Each
    // row is wrapped (the wrapper is what the trim overlay dims), so the
    // divider's next sibling is that wrapper rather than the row itself.
    const compactedRow = container.querySelector('[data-message-id="m3"]');
    expect(compactedRow).toBeTruthy();
    expect(dividers[0]?.nextElementSibling?.contains(compactedRow)).toBe(true);
  });

  it('renders no divider when input tokens only ever grow', () => {
    const messages: ThreadMessage[] = [
      assistant({ id: 'm1', runId: 'r1', usage: { inputTokens: 1000 } }),
      assistant({ id: 'm2', runId: 'r2', usage: { inputTokens: 2000 } }),
      assistant({ id: 'm3', runId: 'r3', usage: { inputTokens: 3000 } }),
    ];
    const { container } = render(
      <MessageList
        messages={messages}
        activities={noActivities}
        agentNameById={agentNameById}
        loading={false}
        renderMode="raw"
      />
    );
    expect(container.querySelectorAll('[data-tid="compactionDivider"]')).toHaveLength(0);
  });
});

describe('memoryExtractionLabel', () => {
  it('joins agent name, saved, and proposed segments', () => {
    expect(memoryExtractionLabel({ saved: 2, proposed: 1 }, 'Nova')).toBe(
      'Nova · 2 memories saved · 1 proposed for your approval'
    );
  });

  it('uses singular copy for one memory', () => {
    expect(memoryExtractionLabel({ saved: 1, proposed: 0 }, 'Nova')).toBe('Nova · 1 memory saved');
  });

  it('skips the name segment when no name resolved', () => {
    expect(memoryExtractionLabel({ saved: 3, proposed: 0 })).toBe('3 memories saved');
  });

  it('spells out a proposed-only notice', () => {
    expect(memoryExtractionLabel({ saved: 0, proposed: 1 })).toBe(
      '1 memory proposed for your approval'
    );
  });

  it('returns null for an all-zero notice', () => {
    expect(memoryExtractionLabel({ saved: 0, proposed: 0 }, 'Nova')).toBeNull();
  });
});

describe('MessageList — memory-extraction meta line', () => {
  const noActivities = new Map<string, RunActivity>();
  const agentNameById = new Map<string, string>([['a1', 'Nova']]);

  function notice(over: Partial<MemoryExtractionNotice> = {}): MemoryExtractionNotice {
    return {
      id: 'memx-1',
      agentId: 'a1',
      saved: 2,
      proposed: 1,
      createdAt: '2026-07-04T00:00:09.000Z',
      ...over,
    };
  }

  it('renders a quiet meta line after the message it followed, with the agent name', () => {
    const messages: ThreadMessage[] = [
      assistant({ id: 'm1', runId: 'r1' }),
      assistant({ id: 'm2', runId: 'r2' }),
    ];
    const { container } = render(
      <MessageList
        messages={messages}
        activities={noActivities}
        agentNameById={agentNameById}
        loading={false}
        renderMode="raw"
        memoryExtractions={[notice()]}
      />
    );

    const lines = container.querySelectorAll('[data-tid="memoryExtraction"]');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toContain(
      'Nova · 2 memories saved · 1 proposed for your approval'
    );
    // Interleaved by time: the notice's createdAt is after both messages, so
    // it renders below the last message row.
    const lastRow = container.querySelector('[data-message-id="m2"]');
    expect(lastRow).toBeTruthy();
    expect(
      lastRow!.compareDocumentPosition(lines[0]!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('opens the agent’s memories when the notice is clicked', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <MessageList
        messages={[assistant({ id: 'm1', runId: 'r1' })]}
        activities={noActivities}
        agentNameById={agentNameById}
        loading={false}
        renderMode="raw"
        memoryExtractions={[notice()]}
        onOpenMemoryNotice={onOpen}
      />
    );
    fireEvent.click(container.querySelector('[data-tid="memoryExtraction"] button')!);
    expect(onOpen).toHaveBeenCalledWith('a1');
  });

  it('omits the name segment when the agent id does not resolve', () => {
    const { container } = render(
      <MessageList
        messages={[assistant({ id: 'm1', runId: 'r1' })]}
        activities={noActivities}
        agentNameById={new Map()}
        loading={false}
        renderMode="raw"
        memoryExtractions={[notice()]}
      />
    );
    const line = container.querySelector('[data-tid="memoryExtraction"]');
    expect(line?.textContent).toContain('2 memories saved · 1 proposed for your approval');
    expect(line?.textContent).not.toContain('Nova');
  });

  it('never renders an all-zero notice', () => {
    const { container } = render(
      <MessageList
        messages={[assistant({ id: 'm1', runId: 'r1' })]}
        activities={noActivities}
        agentNameById={agentNameById}
        loading={false}
        renderMode="raw"
        memoryExtractions={[notice({ saved: 0, proposed: 0 })]}
      />
    );
    expect(container.querySelectorAll('[data-tid="memoryExtraction"]')).toHaveLength(0);
  });
});

describe('MessageList — row order', () => {
  it('orders rows by instant when their timestamps come in different forms', () => {
    const { container } = render(
      <MessageList
        messages={[
          // Already in the order the stream would hand over (by text).
          {
            id: 'event-1',
            threadId: 'thread-1',
            role: 'user',
            agentId: null,
            content: '[agent run ended · Agent A · 30s]',
            createdAt: '2026-10-13T10:02:12.120000-08:00',
            messageType: 'thread_event',
          },
          {
            id: 'user-1',
            threadId: 'thread-1',
            role: 'user',
            agentId: null,
            content: 'Run the check.',
            createdAt: '2026-10-13T18:01:42.864Z',
          },
        ]}
        activities={new Map()}
        agentNameById={new Map()}
        loading={false}
        renderMode="raw"
      />
    );
    const ids = [...container.querySelectorAll('[data-message-id]')].map((el) =>
      el.getAttribute('data-message-id')
    );
    expect(ids).toEqual(['user-1', 'event-1']);
  });
});

describe('MessageList — empty state', () => {
  const props = {
    messages: [],
    activities: new Map<string, RunActivity>(),
    agentNameById: new Map<string, string>(),
    loading: false,
    renderMode: 'md' as const,
  };

  it('says there are no messages in a thread that has none', () => {
    render(<MessageList {...props} />);
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
  });

  it('does not call a thread empty when its history failed to load', () => {
    render(<MessageList {...props} failed />);
    expect(screen.queryByText('No messages yet')).not.toBeInTheDocument();
  });
});

describe('MessageList — a page that failed to load', () => {
  const props = {
    messages: [assistant({ id: 'm1' })],
    activities: new Map<string, RunActivity>(),
    agentNameById: new Map<string, string>(),
    loading: false,
    renderMode: 'md' as const,
  };

  it('says why the earlier messages did not load, beside the button that retries', () => {
    render(
      <MessageList
        {...props}
        hasMoreOlder
        onLoadOlder={vi.fn()}
        pageError={{ edge: 'older', message: 'server unavailable' }}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Couldn’t load earlier messages: server unavailable'
    );
    expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeInTheDocument();
  });

  it('says why newer messages did not load, and hides the line during a retry', () => {
    const { rerender } = render(
      <MessageList {...props} hasMoreNewer pageError={{ edge: 'newer', message: 'timed out' }} />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load newer messages: timed out');

    rerender(
      <MessageList
        {...props}
        hasMoreNewer
        paginating
        pageError={{ edge: 'newer', message: 'timed out' }}
      />
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
