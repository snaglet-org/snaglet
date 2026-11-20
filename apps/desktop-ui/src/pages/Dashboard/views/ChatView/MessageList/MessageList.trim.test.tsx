/**
 * MessageList as the trim panel's viewer: messages the plan removes dim in
 * place, and moving a handle seeks the pane to that boundary. Dimming follows
 * the server's resolved plan by position in the loaded order (never by
 * `createdAt`); a boundary outside the loaded window is reported, not guessed;
 * a seek fires only when the boundary moves.
 */

import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import type { ThreadMessage } from '@desktop/utils/api';
import {
  MAX_RENDERED,
  MAX_SEEK_PAGE_LOADS,
  MessageList,
  SEEK_CONTEXT_ROWS,
  computeTrimView,
  type TrimOverlay,
} from './MessageList';

// The row's own internals (markdown, clipboard, activity disclosure) decide
// nothing about what gets deleted; only its `data-message-id` matters here.
vi.mock('../MessageRow/MessageRow', () => ({
  MessageRow: ({ message }: { message?: ThreadMessage }) =>
    message ? <div data-message-id={message.id}>{message.content}</div> : <div data-stub-row />,
}));

const scrollIntoView = vi.fn();

function msg(id: string, i: number): ThreadMessage {
  return {
    id,
    threadId: 't1',
    role: i % 2 === 0 ? 'user' : 'assistant',
    agentId: i % 2 === 0 ? null : 'a1',
    content: `message ${i}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  };
}

const window10 = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, i));
const rowsOf = (messages: ThreadMessage[]): Array<{ message?: ThreadMessage }> =>
  messages.map((message) => ({ message }));

function overlay(over: Partial<TrimOverlay> = {}): TrimOverlay {
  return {
    firstRetainedId: 'm0',
    lastRetainedId: 'm9',
    sides: 'none',
    seek: null,
    ...over,
  };
}

function renderList(trim: TrimOverlay | null, messages: ThreadMessage[] = window10) {
  return render(
    <MessageList
      messages={messages}
      activities={new Map()}
      agentNameById={new Map()}
      loading={false}
      renderMode="md"
      trim={trim}
    />
  );
}

const dimmedIds = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-trim-doomed="true"]')).map(
    (el) => el.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId ?? '?'
  );

beforeEach(() => {
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
});

/* the rule, in isolation */

describe('computeTrimView', () => {
  const rows = rowsOf(window10);

  it('dims nothing when there is no overlay or the plan cuts nothing', () => {
    expect(computeTrimView(rows, null).doomedIds.size).toBe(0);
    expect(computeTrimView(rows, overlay({ sides: 'none' })).doomedIds.size).toBe(0);
  });

  it('dims the prefix only, when only the prefix is cut', () => {
    const view = computeTrimView(rows, overlay({ firstRetainedId: 'm3', sides: 'prefix' }));
    expect([...view.doomedIds]).toEqual(['m0', 'm1', 'm2']);
  });

  it('dims the tail only, when only the tail is cut', () => {
    const view = computeTrimView(rows, overlay({ lastRetainedId: 'm7', sides: 'tail' }));
    expect([...view.doomedIds]).toEqual(['m8', 'm9']);
  });

  it('dims both ends and never the retained span', () => {
    const view = computeTrimView(
      rows,
      overlay({ firstRetainedId: 'm2', lastRetainedId: 'm7', sides: 'both' })
    );
    expect([...view.doomedIds].sort()).toEqual(['m0', 'm1', 'm8', 'm9']);
    for (const kept of ['m2', 'm3', 'm4', 'm5', 'm6', 'm7']) {
      expect(view.doomedIds.has(kept)).toBe(false);
    }
  });

  it('follows the RESOLVED span when the server widened it for run atomicity', () => {
    // The user asked to keep from m5; the server pulled the boundary back to m3
    // so a run stayed whole. m3 and m4 are therefore kept, and must not dim.
    const view = computeTrimView(rows, overlay({ firstRetainedId: 'm3', sides: 'prefix' }));
    expect(view.doomedIds.has('m3')).toBe(false);
    expect(view.doomedIds.has('m4')).toBe(false);
    expect([...view.doomedIds]).toEqual(['m0', 'm1', 'm2']);
  });

  it('reports — never guesses — a first boundary that precedes the window', () => {
    const view = computeTrimView(
      rows,
      overlay({ firstRetainedId: 'not-loaded', lastRetainedId: 'm7', sides: 'both' })
    );
    // The last boundary IS loaded, so the tail is exactly known…
    expect([...view.doomedIds]).toEqual(['m8', 'm9']);
    // …and the first must lie before the window, so nothing here is prefix.
    expect(view.firstBoundaryAbove).toBe(true);
    expect(view.lastBoundaryBelow).toBe(false);
    expect(view.unlocatable).toBe(false);
  });

  it('reports a last boundary that follows the window', () => {
    const view = computeTrimView(
      rows,
      overlay({ firstRetainedId: 'm2', lastRetainedId: 'not-loaded', sides: 'both' })
    );
    expect([...view.doomedIds]).toEqual(['m0', 'm1']);
    expect(view.lastBoundaryBelow).toBe(true);
    expect(view.firstBoundaryAbove).toBe(false);
  });

  it('dims nothing and says so when neither boundary is loaded', () => {
    const view = computeTrimView(
      rows,
      overlay({ firstRetainedId: 'gone-a', lastRetainedId: 'gone-b', sides: 'both' })
    );
    expect(view.doomedIds.size).toBe(0);
    expect(view.unlocatable).toBe(true);
  });

  it('never dims an activity-only stub row, which has no message to delete', () => {
    const mixed = [...rowsOf(window10.slice(0, 3)), {}, ...rowsOf(window10.slice(3))];
    const view = computeTrimView(mixed, overlay({ firstRetainedId: 'm5', sides: 'prefix' }));
    expect([...view.doomedIds]).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('ignores timestamps entirely — position in the loaded order is the truth', () => {
    // Every row shares one millisecond, as sub-millisecond-adjacent messages do
    // once the server's microsecond precision is truncated for display. A
    // timestamp comparison would be unable to place the boundary; position can.
    const sameMs = window10.map((m) => ({ ...m, createdAt: '2026-01-01T00:00:00.000Z' }));
    const view = computeTrimView(
      rowsOf(sameMs),
      overlay({ firstRetainedId: 'm4', sides: 'prefix' })
    );
    expect([...view.doomedIds]).toEqual(['m0', 'm1', 'm2', 'm3']);
  });
});

/* what the pane renders */

describe('MessageList — trim viewer', () => {
  it('renders normally, with no wrapper state, when the panel is closed', () => {
    renderList(null);
    expect(document.querySelectorAll('[data-trim-doomed]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-message-id]')).toHaveLength(10);
  });

  it('dims the removed messages in place and leaves the kept span alone', () => {
    renderList(overlay({ firstRetainedId: 'm2', lastRetainedId: 'm7', sides: 'both' }));
    expect(dimmedIds()).toEqual(['m0', 'm1', 'm8', 'm9']);
    // Every message is still rendered — dimming hides nothing.
    expect(document.querySelectorAll('[data-message-id]')).toHaveLength(10);
  });

  it('marks a first boundary that is earlier than the loaded window', () => {
    renderList(overlay({ firstRetainedId: 'earlier', lastRetainedId: 'm7', sides: 'both' }));
    const marker = document.querySelector('[data-tid="trimFirstBoundaryAbove"]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain('earlier than this view');
    expect(dimmedIds()).toEqual(['m8', 'm9']);
  });

  it('marks a last boundary that is later than the loaded window', () => {
    renderList(overlay({ firstRetainedId: 'm2', lastRetainedId: 'later', sides: 'both' }));
    expect(document.querySelector('[data-tid="trimLastBoundaryBelow"]')).not.toBeNull();
    expect(dimmedIds()).toEqual(['m0', 'm1']);
  });

  it('admits it cannot place either boundary rather than implying the view is safe', () => {
    renderList(overlay({ firstRetainedId: 'gone-a', lastRetainedId: 'gone-b', sides: 'both' }));
    const marker = document.querySelector('[data-tid="trimBoundariesOffscreen"]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain('outside this view');
    expect(dimmedIds()).toEqual([]);
  });
});

/* scrubbing seeks the viewer */

describe('MessageList — seeking to a boundary', () => {
  it('does not seek on open, before any handle has been touched', () => {
    renderList(overlay({ firstRetainedId: 'm2', sides: 'prefix', seek: null }));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('seeks to the boundary message when a handle moves', () => {
    const { rerender } = render(
      <MessageList
        messages={window10}
        activities={new Map()}
        agentNameById={new Map()}
        loading={false}
        renderMode="md"
        trim={overlay({ firstRetainedId: 'm2', sides: 'prefix', seek: null })}
      />
    );
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender(
      <MessageList
        messages={window10}
        activities={new Map()}
        agentNameById={new Map()}
        loading={false}
        renderMode="md"
        trim={overlay({
          firstRetainedId: 'm5',
          sides: 'prefix',
          seek: { messageId: 'm5', nonce: 1 },
        })}
      />
    );

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const target = scrollIntoView.mock.instances[0] as HTMLElement;
    expect(target.dataset.messageId).toBe('m5');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' });
  });

  it('does not re-seek while the boundary stays put', () => {
    const props = {
      messages: window10,
      activities: new Map(),
      agentNameById: new Map(),
      loading: false,
      renderMode: 'md' as const,
      trim: overlay({
        firstRetainedId: 'm5',
        sides: 'prefix',
        seek: { messageId: 'm5', nonce: 1 },
      }),
    };
    const { rerender } = render(<MessageList {...props} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // An unrelated re-render (a new message streaming in, say) must not yank
    // the pane away from wherever the user has scrolled to.
    rerender(<MessageList {...props} />);
    rerender(<MessageList {...props} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('seeks again when the same boundary is asked for twice', () => {
    // "Jump to prefix", scroll away, "Jump to prefix" again: same message, and
    // it must move the pane both times.
    const base = {
      messages: window10,
      activities: new Map(),
      agentNameById: new Map(),
      loading: false,
      renderMode: 'md' as const,
    };
    const jump = (nonce: number) =>
      overlay({
        firstRetainedId: 'm4',
        sides: 'prefix' as const,
        seek: { messageId: 'm4', nonce },
      });

    const { rerender } = render(<MessageList {...base} trim={jump(1)} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    rerender(<MessageList {...base} trim={jump(2)} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect((scrollIntoView.mock.instances[1] as HTMLElement).dataset.messageId).toBe('m4');
  });

  it('completes a pending jump once the boundary is paged in', () => {
    const base = {
      activities: new Map(),
      agentNameById: new Map(),
      loading: false,
      renderMode: 'md' as const,
      trim: overlay({
        firstRetainedId: 'm0',
        sides: 'prefix' as const,
        seek: { messageId: 'm0', nonce: 1 },
      }),
    };
    // The boundary is older than the loaded page — nowhere to jump to yet.
    const { rerender } = render(<MessageList {...base} messages={window10.slice(4)} />);
    expect(scrollIntoView).not.toHaveBeenCalled();

    // "Load earlier messages" brings it in; the pending jump lands.
    rerender(<MessageList {...base} messages={window10} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect((scrollIntoView.mock.instances[0] as HTMLElement).dataset.messageId).toBe('m0');
  });

  it('seeks back when the handle returns to a boundary it already visited', () => {
    const base = {
      messages: window10,
      activities: new Map(),
      agentNameById: new Map(),
      loading: false,
      renderMode: 'md' as const,
    };
    const at = (id: string, nonce: number) =>
      overlay({
        firstRetainedId: id,
        sides: 'prefix' as const,
        seek: { messageId: id, nonce },
      });

    const { rerender } = render(<MessageList {...base} trim={at('m3', 1)} />);
    rerender(<MessageList {...base} trim={at('m6', 2)} />);
    rerender(<MessageList {...base} trim={at('m3', 3)} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(3);
    expect((scrollIntoView.mock.instances[2] as HTMLElement).dataset.messageId).toBe('m3');
  });

  it('does not jump anywhere when the boundary is not in the thread at all', () => {
    const base = {
      messages: window10,
      activities: new Map(),
      agentNameById: new Map(),
      loading: false,
      renderMode: 'md' as const,
      // Nothing left to page in: the whole thread is loaded and this id is not
      // in it, so there is nowhere the jump could land.
      hasMoreOlder: false,
    };
    const { rerender } = render(<MessageList {...base} trim={overlay()} />);
    rerender(
      <MessageList
        {...base}
        trim={overlay({
          firstRetainedId: 'offscreen',
          sides: 'prefix',
          seek: { messageId: 'offscreen', nonce: 1 },
        })}
      />
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    // …and the pane says why rather than silently showing the wrong thing.
    expect(document.querySelector('[data-tid="trimFirstBoundaryAbove"]')).not.toBeNull();
  });
});

/* seeking past the render cap */

/**
 * The list renders only the newest {@link MAX_RENDERED} rows. A trim prefix
 * boundary sits at the oldest end of the thread, so on a long thread the cap
 * has dropped it and the seek has to reach it anyway.
 */
describe('MessageList — seeking past the render cap', () => {
  const bigThread = (count: number) => Array.from({ length: count }, (_, i) => msg(`m${i}`, i));
  /** A prefix-only cut: keep from `id` through the thread's last message. */
  const seekTo = (id: string, lastId: string, nonce = 1): TrimOverlay =>
    overlay({
      firstRetainedId: id,
      lastRetainedId: lastId,
      sides: 'prefix',
      seek: { messageId: id, nonce },
    });

  const listProps = (messages: ThreadMessage[]) => ({
    messages,
    activities: new Map(),
    agentNameById: new Map(),
    loading: false,
    renderMode: 'md' as const,
  });

  const renderedIds = (): string[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]')).map(
      (el) => el.dataset.messageId ?? '?'
    );

  it('seeks to a boundary the render cap had dropped', () => {
    const messages = bigThread(300);
    const base = listProps(messages);
    // m10 is 290 rows from the end — far outside the rendered tail.
    const { rerender } = render(<MessageList {...base} trim={overlay()} />);
    expect(renderedIds()).not.toContain('m10');

    rerender(<MessageList {...base} trim={seekTo('m10', 'm299')} />);

    expect(renderedIds()).toContain('m10');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect((scrollIntoView.mock.instances[0] as HTMLElement).dataset.messageId).toBe('m10');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' });
  });

  it('keeps the rendered row count bounded however deep the jump goes', () => {
    const messages = bigThread(5000);
    const base = listProps(messages);
    const { rerender } = render(<MessageList {...base} trim={overlay()} />);
    expect(renderedIds()).toHaveLength(MAX_RENDERED);

    rerender(<MessageList {...base} trim={seekTo('m3', 'm4999')} />);

    const ids = renderedIds();
    expect(ids).toContain('m3');
    expect(ids.length).toBeLessThanOrEqual(MAX_RENDERED + 2 * SEEK_CONTEXT_ROWS + 1);
  });

  it('never unrenders the newest rows, where streaming and optimistic bubbles live', () => {
    const messages = bigThread(1000);
    const base = listProps(messages);
    const { rerender } = render(<MessageList {...base} trim={overlay()} />);
    rerender(<MessageList {...base} trim={seekTo('m5', 'm999')} />);

    const ids = renderedIds();
    expect(ids).toContain('m5');
    expect(ids).toContain('m999');
    expect(ids).toContain('m998');
  });

  it('keeps the hidden-row notices honest about what is actually hidden', () => {
    const messages = bigThread(1000);
    const base = listProps(messages);
    const { rerender } = render(<MessageList {...base} trim={overlay()} />);
    rerender(<MessageList {...base} trim={seekTo('m400', 'm999')} />);

    const rendered = renderedIds().length;
    const before = Number(
      document.querySelector('[data-tid="renderHiddenBefore"]')?.getAttribute('data-hidden') ?? '0'
    );
    const between = Number(
      document.querySelector('[data-tid="renderHiddenBetween"]')?.getAttribute('data-hidden') ?? '0'
    );
    expect(before).toBeGreaterThan(0);
    expect(between).toBeGreaterThan(0);
    expect(before + between + rendered).toBe(1000);
  });

  it('dims the doomed prefix around a boundary the cap had dropped', () => {
    const messages = bigThread(300);
    const base = listProps(messages);
    const { rerender } = render(<MessageList {...base} trim={overlay()} />);
    rerender(
      <MessageList
        {...base}
        trim={overlay({
          firstRetainedId: 'm10',
          lastRetainedId: 'm299',
          sides: 'prefix',
          seek: { messageId: 'm10', nonce: 1 },
        })}
      />
    );
    // Rows older than the boundary that are now on screen dim; the boundary
    // itself and everything after it do not.
    expect(dimmedIds()).toContain('m9');
    expect(dimmedIds()).not.toContain('m10');
    expect(document.querySelector('[data-tid="trimFirstBoundaryAbove"]')).toBeNull();
  });
});

/* seeking to a boundary that is not loaded yet */

describe('MessageList — seeking to an unloaded boundary', () => {
  type ListProps = ComponentProps<typeof MessageList>;
  const props = (over: Partial<ListProps>): ListProps => ({
    messages: window10,
    activities: new Map(),
    agentNameById: new Map(),
    loading: false,
    renderMode: 'md',
    ...over,
  });

  it('pages older messages in and lands the jump when they arrive', () => {
    const onLoadOlder = vi.fn();
    const trim = overlay({
      firstRetainedId: 'm0',
      sides: 'prefix' as const,
      seek: { messageId: 'm0', nonce: 1 },
    });
    const base = props({ hasMoreOlder: true, onLoadOlder, trim });

    const { rerender } = render(<MessageList {...base} messages={window10.slice(6)} />);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).not.toHaveBeenCalled();

    // The page arrives; the pending jump completes without a second request.
    rerender(<MessageList {...base} messages={window10} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect((scrollIntoView.mock.instances[0] as HTMLElement).dataset.messageId).toBe('m0');
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('stops paging after a bounded number of attempts and says the jump failed', () => {
    const onLoadOlder = vi.fn();
    const trim = overlay({
      firstRetainedId: 'ghost',
      sides: 'prefix' as const,
      seek: { messageId: 'ghost', nonce: 1 },
    });
    // The server keeps claiming there is more, but the boundary never shows up
    // (it was deleted out from under the plan). Each page toggles `paginating`,
    // which is what gives the seek another go.
    const base = props({ hasMoreOlder: true, onLoadOlder, trim, messages: window10 });
    const { rerender } = render(<MessageList {...base} paginating={false} />);
    for (let i = 0; i < MAX_SEEK_PAGE_LOADS + 5; i += 1) {
      rerender(<MessageList {...base} paginating />);
      rerender(<MessageList {...base} paginating={false} />);
    }

    expect(onLoadOlder.mock.calls.length).toBeLessThanOrEqual(MAX_SEEK_PAGE_LOADS);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.querySelector('[data-tid="seekUnreachable"]')).not.toBeNull();
  });

  it('does not page when the whole thread is already loaded — it says so instead', () => {
    const onLoadOlder = vi.fn();
    const base = props({
      hasMoreOlder: false,
      onLoadOlder,
      messages: window10,
      trim: overlay({
        firstRetainedId: 'ghost',
        sides: 'prefix' as const,
        seek: { messageId: 'ghost', nonce: 1 },
      }),
    });
    render(<MessageList {...base} />);
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(document.querySelector('[data-tid="seekUnreachable"]')).not.toBeNull();
  });

  it('clears the failure when the user asks again', () => {
    const onLoadOlder = vi.fn();
    const base = (seekId: string, nonce: number) =>
      props({
        hasMoreOlder: false,
        onLoadOlder,
        messages: window10,
        trim: overlay({
          firstRetainedId: seekId,
          sides: 'prefix' as const,
          seek: { messageId: seekId, nonce },
        }),
      });
    const { rerender } = render(<MessageList {...base('ghost', 1)} />);
    expect(document.querySelector('[data-tid="seekUnreachable"]')).not.toBeNull();

    rerender(<MessageList {...base('m4', 2)} />);
    expect(document.querySelector('[data-tid="seekUnreachable"]')).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('pages FORWARD when the boundary must lie after the loaded window', () => {
    const onLoadOlder = vi.fn();
    const onLoadNewer = vi.fn();
    // The first boundary is loaded, so the last one — missing — can only be
    // newer than this window. Paging backwards would never reach it.
    const trim = overlay({
      firstRetainedId: 'm2',
      lastRetainedId: 'later',
      sides: 'both' as const,
      seek: { messageId: 'later', nonce: 1 },
    });
    render(
      <MessageList
        {...props({
          messages: window10,
          hasMoreOlder: true,
          hasMoreNewer: true,
          onLoadOlder,
          onLoadNewer,
          trim,
        })}
      />
    );
    expect(onLoadNewer).toHaveBeenCalledTimes(1);
    expect(onLoadOlder).not.toHaveBeenCalled();
  });
});
