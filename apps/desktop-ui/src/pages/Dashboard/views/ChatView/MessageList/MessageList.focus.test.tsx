/**
 * MessageList — opening on one message (a message chip, a search hit).
 *
 * The message must land in view, stay there while the rows around it load and
 * resize, and stay highlighted until the user scrolls or clicks in the list.
 * jsdom has no layout, so rows are stacked by a small fake: each message row is
 * `heights[id]` tall, `extraAbove` stands in for rows without a message id
 * (activity stubs) above them, and the view is VIEWPORT tall.
 */
import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMessage } from '@desktop/utils/api';
import type { RunActivity } from '../hooks/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { FOCUS_TOP_MARGIN_PX, MAX_RENDERED, MessageList, focusScrollTop } from './MessageList';

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  /** A row changed size. */
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const VIEWPORT = 300;
const ROW = 100;
let heights: Map<string, number>;
let extraAbove: number;
/** A CSS transform on an ancestor (a modal's entrance animation) scales client rects. */
let rectScale: number;
/** The list's client-rect height before scaling; layout rounds offsetHeight. */
let listHeight: number;

function listEl(): HTMLElement {
  return screen.getByTestId('message-list');
}

function messageRows(): HTMLElement[] {
  return Array.from(listEl().querySelectorAll<HTMLElement>('[data-message-id]'));
}

function rowHeight(el: Element): number {
  return heights.get(el.getAttribute('data-message-id') ?? '') ?? ROW;
}

function contentHeight(): number {
  return extraAbove + messageRows().reduce((sum, el) => sum + rowHeight(el), 0);
}

/** Top of `id` within the scrolled content. */
function contentTop(id: string): number {
  let top = extraAbove;
  for (const el of messageRows()) {
    if (el.getAttribute('data-message-id') === id) return top;
    top += rowHeight(el);
  }
  throw new Error(`no row for ${id}`);
}

function fakeRect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
  } as DOMRect;
}

beforeEach(() => {
  heights = new Map();
  extraAbove = 0;
  rectScale = 1;
  listHeight = VIEWPORT;
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => VIEWPORT);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => VIEWPORT);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === 'message-list' ? contentHeight() : 0;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const id = this.getAttribute('data-message-id');
    if (!id) return fakeRect(0, listHeight * rectScale);
    return fakeRect((contentTop(id) - listEl().scrollTop) * rectScale, rowHeight(this) * rectScale);
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function reply(i: number): ThreadMessage {
  return {
    id: `m${i}`,
    threadId: 'thread-1',
    role: 'assistant',
    agentId: 'a1',
    runId: `r${i}`,
    content: `reply ${i}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  };
}

const messages = Array.from({ length: 10 }, (_, i) => reply(i));

function activityFor(...indexes: number[]): Map<string, RunActivity> {
  return new Map(
    indexes.map((i) => [
      `r${i}`,
      {
        runId: `r${i}`,
        agentId: 'a1',
        threadId: 'thread-1',
        steps: [],
        status: 'complete',
        startedAt: messages[i].createdAt,
        finishedAt: messages[i].createdAt,
      },
    ])
  );
}

interface ListProps {
  focusMessageId?: string | null;
  focusRequestId?: number | null;
  holdFocus?: boolean;
  activities?: Map<string, RunActivity>;
  rows?: ThreadMessage[];
  extra?: Partial<ComponentProps<typeof MessageList>>;
}

function ui({
  focusMessageId = 'm5',
  focusRequestId = 1,
  holdFocus,
  activities,
  rows,
  extra,
}: ListProps = {}) {
  return (
    <MessageList
      messages={rows ?? messages}
      activities={activities ?? new Map()}
      agentNameById={new Map()}
      loading={false}
      renderMode="raw"
      focusMessageId={focusMessageId}
      focusRequestId={focusRequestId}
      holdFocus={holdFocus}
      {...extra}
    />
  );
}

/** Where focusScrollTop puts m5 (100 tall) in a 300 tall view: centered. */
const centeredOn = (id: string) => contentTop(id) - (VIEWPORT - ROW) / 2;

function highlightedIds(): string[] {
  return Array.from(
    listEl().querySelectorAll('[data-focus-highlight="true"] [data-message-id]'),
    (el) => el.getAttribute('data-message-id') ?? ''
  );
}

const observer = () => FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1];

/** Activity-only runs, newer than every message, as runs outside the loaded page render. */
function stubRuns(count: number): Map<string, RunActivity> {
  const runs = new Map<string, RunActivity>();
  for (let i = 0; i < count; i++) {
    runs.set(`stub-${i}`, {
      runId: `stub-${i}`,
      agentId: 'a1',
      threadId: 'thread-1',
      steps: [],
      status: 'complete',
      startedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(),
      finishedAt: null,
    });
  }
  return runs;
}

describe('focusScrollTop', () => {
  const view = { height: 300, maxScrollTop: 5000 };

  it('centers a message that fits in the view', () => {
    expect(focusScrollTop({ top: 1000, height: 100 }, view)).toBe(900);
  });

  it('shows the top of a message taller than the view, with a small margin', () => {
    expect(focusScrollTop({ top: 1000, height: 800 }, view)).toBe(1000 - FOCUS_TOP_MARGIN_PX);
  });

  it('treats a message that only fits without its margins as tall', () => {
    expect(focusScrollTop({ top: 1000, height: 290 }, view)).toBe(1000 - FOCUS_TOP_MARGIN_PX);
  });

  it('stays within the scrollable range', () => {
    expect(focusScrollTop({ top: 20, height: 100 }, view)).toBe(0);
    expect(focusScrollTop({ top: 4990, height: 100 }, { height: 300, maxScrollTop: 4800 })).toBe(
      4800
    );
  });
});

describe('MessageList — opening on a message', () => {
  it('lands the message in the middle of the view and highlights it', () => {
    render(ui());
    expect(listEl().scrollTop).toBe(centeredOn('m5'));
    expect(highlightedIds()).toEqual(['m5']);
    expect(listEl().querySelector('[aria-current="true"] [data-message-id="m5"]')).not.toBeNull();
  });

  it('measures in the list’s own pixels while an ancestor is scaled', () => {
    rectScale = 0.985;
    render(ui());
    expect(listEl().scrollTop).toBeCloseTo(centeredOn('m5'), 5);

    // The animation ends: the same layout, unscaled, is not a user scroll.
    rectScale = 1;
    fireEvent.scroll(listEl());
    expect(highlightedIds()).toEqual(['m5']);
  });

  it('shows the top of a message taller than the view', () => {
    heights.set('m5', 900);
    render(ui());
    expect(listEl().scrollTop).toBe(contentTop('m5') - FOCUS_TOP_MARGIN_PX);
  });

  it('holds the message when the activity log lands and grows the rows above it', () => {
    const view = render(ui());
    // The runs' tool calls render into the rows above, and stub rows for runs
    // outside the loaded page sort in at the top. The rows that gain activity
    // remount under a new key.
    extraAbove = 400;
    for (let i = 0; i < 5; i++) heights.set(`m${i}`, 160);
    view.rerender(ui({ activities: activityFor(0, 1, 2, 3, 4, 5) }));
    expect(listEl().scrollTop).toBe(centeredOn('m5'));
    expect(highlightedIds()).toEqual(['m5']);
  });

  it('holds the message when a row above resizes without a re-render', () => {
    render(ui());
    heights.set('m2', 700); // an image or diagram finished loading
    observer().fire();
    expect(listEl().scrollTop).toBe(centeredOn('m5'));
  });

  it('puts the message back when a scroll comes with rows above it moved', () => {
    render(ui());
    extraAbove = 300; // rows above grew; the engine shifted the offset with them
    listEl().scrollTop = 0;
    fireEvent.scroll(listEl());
    expect(listEl().scrollTop).toBe(centeredOn('m5'));
    expect(highlightedIds()).toEqual(['m5']);
  });

  it('lets go when the view scrolls while nothing around the message moved', () => {
    // Assistive tech, keys sent elsewhere, focus moving into the list: no
    // input event reaches the list, but the user moved the view.
    render(ui());
    listEl().scrollTop = 40;
    fireEvent.scroll(listEl());
    expect(listEl().scrollTop).toBe(40);
    expect(highlightedIds()).toEqual([]);

    heights.set('m2', 700);
    observer().fire();
    expect(listEl().scrollTop).toBe(40);
  });

  it('does not move the view when a live message arrives at the tail', async () => {
    const view = render(ui());
    const placed = listEl().scrollTop;
    view.rerender(ui({ rows: [...messages, reply(10)] }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(listEl().scrollTop).toBe(placed);
    expect(highlightedIds()).toEqual(['m5']);
  });

  it('lets go and clears the highlight once the user scrolls', () => {
    render(ui());
    fireEvent.wheel(listEl(), { deltaY: -200 });
    listEl().scrollTop = 120;
    fireEvent.scroll(listEl());
    expect(highlightedIds()).toEqual([]);

    heights.set('m2', 700);
    observer().fire();
    expect(listEl().scrollTop).toBe(120);
  });

  it.each([
    ['clicks in the list', (el: HTMLElement) => fireEvent.pointerDown(el)],
    ['presses a key in the list', (el: HTMLElement) => fireEvent.keyDown(el, { key: 'ArrowUp' })],
    ['touch-scrolls the list', (el: HTMLElement) => fireEvent.touchMove(el)],
    ['moves focus into the list', (el: HTMLElement) => fireEvent.focusIn(el)],
  ])('lets go when the user %s', (_, interact) => {
    render(ui());
    interact(listEl());
    expect(highlightedIds()).toEqual([]);
    heights.set('m2', 700);
    observer().fire();
    expect(listEl().scrollTop).not.toBe(centeredOn('m5'));
  });

  it('lets go when find moves to a match', () => {
    const view = render(ui());
    view.rerender(
      ui({
        extra: {
          find: {
            messageId: 'm1',
            query: 'reply',
            caseSensitive: false,
            occurrence: 0,
            request: 'f1',
          },
        },
      })
    );
    expect(highlightedIds()).toEqual([]);
  });

  it('lets go when a trim seek lands', () => {
    const view = render(ui());
    view.rerender(
      ui({
        extra: {
          trim: {
            firstRetainedId: 'm1',
            lastRetainedId: 'm9',
            sides: 'prefix',
            seek: { messageId: 'm1', nonce: 1 },
          },
        },
      })
    );
    expect(highlightedIds()).toEqual([]);
  });

  it('lets go when earlier messages are loaded', () => {
    const onLoadOlder = vi.fn();
    render(ui({ extra: { hasMoreOlder: true, onLoadOlder } }));
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(onLoadOlder).toHaveBeenCalled();
    expect(highlightedIds()).toEqual([]);
  });

  it('lets go when the user jumps to the latest message', () => {
    render(ui());
    fireEvent.scroll(listEl()); // reports the view is off the bottom: the jump button shows
    fireEvent.click(screen.getByTestId('jump-to-latest'));
    expect(highlightedIds()).toEqual([]);
    expect(listEl().scrollTop).toBe(contentHeight());
  });

  it('does not land again on an unrelated re-render after the user moved on', () => {
    const view = render(ui());
    fireEvent.wheel(listEl(), { deltaY: -200 });
    listEl().scrollTop = 50;
    view.rerender(ui({ rows: [...messages, reply(10)] }));
    expect(listEl().scrollTop).toBe(50);
    expect(highlightedIds()).toEqual([]);
  });

  it('still lands when the user scrolls activity rows that load before the message', () => {
    // The activity log can arrive first; the anchor is null until the page lands.
    const view = render(
      ui({ rows: [], focusMessageId: null, focusRequestId: null, activities: stubRuns(5) })
    );
    fireEvent.wheel(listEl(), { deltaY: 100 });
    listEl().scrollTop = 30;
    view.rerender(ui({ activities: stubRuns(5) }));
    expect(listEl().scrollTop).toBe(centeredOn('m5'));
    expect(highlightedIds()).toEqual(['m5']);
  });

  it('lands and highlights the same message again for a new request', () => {
    const view = render(ui({ focusRequestId: 1 }));
    fireEvent.wheel(listEl(), { deltaY: -200 });
    listEl().scrollTop = 0;
    view.rerender(ui({ focusRequestId: 2 }));
    expect(listEl().scrollTop).toBe(centeredOn('m5'));
    expect(highlightedIds()).toEqual(['m5']);
  });

  it('lands the same message again after a reload empties the list for a new request', () => {
    const view = render(ui({ focusRequestId: 1 }));
    fireEvent.wheel(listEl(), { deltaY: -200 });
    view.rerender(ui({ rows: [], focusMessageId: null, focusRequestId: null }));
    expect(highlightedIds()).toEqual([]);
    listEl().scrollTop = 0;

    view.rerender(ui({ focusMessageId: 'm5', focusRequestId: 2 }));
    expect(listEl().scrollTop).toBe(centeredOn('m5'));
    expect(highlightedIds()).toEqual(['m5']);
  });

  it('drops the highlight while a reload clears the anchor, then marks only the new message', () => {
    const view = render(ui({ focusMessageId: 'm5', focusRequestId: 1 }));
    view.rerender(ui({ rows: [], focusMessageId: null, focusRequestId: null }));
    view.rerender(ui({ rows: messages, focusMessageId: null, focusRequestId: null }));
    expect(highlightedIds()).toEqual([]);

    view.rerender(ui({ focusMessageId: 'm2', focusRequestId: 2 }));
    expect(highlightedIds()).toEqual(['m2']);
    expect(listEl().scrollTop).toBe(centeredOn('m2'));
  });

  it('only lands on the anchor of a reload after a trim: no highlight, no hold', () => {
    render(ui({ holdFocus: false }));
    expect(listEl().scrollTop).toBe(centeredOn('m5'));
    expect(highlightedIds()).toEqual([]);

    const landed = listEl().scrollTop;
    heights.set('m2', 700);
    observer().fire();
    expect(listEl().scrollTop).toBe(landed);
  });

  it('keeps holding nothing, without errors, when the pinned message is deleted', () => {
    const view = render(ui());
    const placed = listEl().scrollTop;
    view.rerender(ui({ rows: messages.filter((m) => m.id !== 'm5') }));
    expect(highlightedIds()).toEqual([]);
    expect(listEl().scrollTop).toBe(placed);

    listEl().scrollTop = 10;
    fireEvent.scroll(listEl());
    heights.set('m2', 700);
    observer().fire();
    expect(listEl().scrollTop).toBe(10);
  });

  it('keeps the message rendered when activity stubs push it past the render cap', () => {
    render(ui({ focusMessageId: 'm2', activities: stubRuns(MAX_RENDERED) }));
    expect(highlightedIds()).toEqual(['m2']);
  });

  it.each([
    ['scrolls', (el: HTMLElement) => fireEvent.wheel(el, { deltaY: 40 })],
    ['clicks', (el: HTMLElement) => fireEvent.pointerDown(el)],
  ])('keeps a message past the render cap rendered after the user %s', (_, interact) => {
    render(ui({ focusMessageId: 'm2', activities: stubRuns(MAX_RENDERED) }));
    interact(listEl());
    expect(highlightedIds()).toEqual([]);
    expect(listEl().querySelector('[data-message-id="m2"]')).not.toBeNull();
  });

  it('returns the render window to the tail when the user jumps to the latest', () => {
    render(ui({ focusMessageId: 'm2', activities: stubRuns(MAX_RENDERED) }));
    fireEvent.scroll(listEl()); // the jump button shows once the view is off the bottom
    fireEvent.click(screen.getByTestId('jump-to-latest'));
    expect(listEl().querySelector('[data-message-id="m2"]')).toBeNull();
  });

  it('holds the message when content below it shrinks and the view is clamped to the end', () => {
    heights.set('m9', 200);
    render(ui({ focusMessageId: 'm8' }));
    expect(listEl().scrollTop).toBe(centeredOn('m8'));
    heights.set('m9', 20); // a disclosure below collapsed: the end moves up
    listEl().scrollTop = contentHeight() - VIEWPORT;
    fireEvent.scroll(listEl());
    expect(highlightedIds()).toEqual(['m8']);
    heights.set('m9', 200);
    observer().fire();
    expect(listEl().scrollTop).toBe(centeredOn('m8'));
  });

  it('drops an earlier pin when a land-only focus replaces it', () => {
    const view = render(ui({ focusMessageId: 'm5', focusRequestId: 1 }));
    view.rerender(ui({ focusMessageId: 'm2', focusRequestId: 1, holdFocus: false }));
    expect(listEl().scrollTop).toBe(centeredOn('m2'));
    expect(highlightedIds()).toEqual([]);
    const landed = listEl().scrollTop;
    heights.set('m0', 150);
    observer().fire();
    expect(listEl().scrollTop).toBe(landed);
  });

  it('places exactly when the list height has a sub-pixel fraction', () => {
    listHeight = VIEWPORT + 0.45;
    render(ui({ focusMessageId: 'm70', rows: Array.from({ length: 80 }, (_, i) => reply(i)) }));
    expect(listEl().scrollTop).toBe(centeredOn('m70'));
  });
});
