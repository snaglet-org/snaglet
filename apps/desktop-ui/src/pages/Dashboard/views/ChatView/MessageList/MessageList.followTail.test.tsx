/**
 * MessageList — staying pinned to the tail while rows grow.
 *
 * A row can change height long after the pin that followed it: a stored
 * image or an included doc loads, a diagram renders. The scroll signature
 * does not move for any of that, so without a resize observer the newest
 * message slid below the fold until the next message arrived.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMessage } from '@desktop/utils/api';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { MessageList } from './MessageList';

/** jsdom has no ResizeObserver; this one is driven by the test. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.add(target);
  }
  unobserve(target: Element) {
    this.observed.delete(target);
  }
  disconnect() {
    this.observed.clear();
  }
  /** A row changed size. */
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let contentHeight = 1000;
const VIEWPORT = 300;

function message(id: string, i: number): ThreadMessage {
  return {
    id,
    threadId: 'thread-1',
    role: 'user',
    agentId: null,
    content: `message ${i}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  };
}

const messages = Array.from({ length: 5 }, (_, i) => message(`m${i}`, i));

function renderList() {
  render(
    <MessageList
      messages={messages}
      activities={new Map()}
      agentNameById={new Map()}
      loading={false}
      renderMode="raw"
    />
  );
  return screen.getByTestId('message-list');
}

const observer = (): FakeResizeObserver => {
  const instance = FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1];
  if (!instance) throw new Error('MessageList created no ResizeObserver');
  return instance;
};

beforeEach(() => {
  FakeResizeObserver.instances = [];
  contentHeight = 1000;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => VIEWPORT);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MessageList — following the tail while rows grow', () => {
  it('watches every rendered row', () => {
    const list = renderList();
    // Every row, plus the list itself (a shrinking viewport re-pins too).
    expect(observer().observed.size).toBe(list.children.length + 1);
  });

  it('re-pins to the bottom when a row grows after the pin', () => {
    const list = renderList();
    expect(list.scrollTop).toBe(1000);

    contentHeight = 1400; // the last message's image loaded
    observer().fire();

    expect(list.scrollTop).toBe(1400);
  });

  it('leaves a reader who scrolled up where they are', () => {
    const list = renderList();
    fireEvent.wheel(list, { deltaY: -400 });
    list.scrollTop = 200;
    fireEvent.scroll(list);

    contentHeight = 1400;
    observer().fire();

    expect(list.scrollTop).toBe(200);
  });

  it('keeps following when a layout shift (not the user) moves the view off the bottom', () => {
    const list = renderList();
    // The composer's status bar appears for a live run: the viewport shrinks and
    // the browser fires a scroll with the list now short of the bottom.
    contentHeight = 1100;
    list.scrollTop = 700; // 100px short of the bottom, no user input involved
    fireEvent.scroll(list);

    contentHeight = 1600; // the run's activity streams in
    observer().fire();

    expect(list.scrollTop).toBe(1600);
  });

  it('resumes following once the reader scrolls back to the bottom', () => {
    const list = renderList();
    fireEvent.wheel(list, { deltaY: -400 });
    list.scrollTop = 200;
    fireEvent.scroll(list);

    fireEvent.wheel(list, { deltaY: 900 });
    list.scrollTop = contentHeight - VIEWPORT;
    fireEvent.scroll(list);
    contentHeight = 1500;
    observer().fire();

    expect(list.scrollTop).toBe(1500);
  });

  it('manual mode leaves the view put, and the jump button brings it to the tail', () => {
    const list = renderList();
    fireEvent.click(screen.getByTestId('auto-scroll-toggle'));
    expect(screen.getByTestId('auto-scroll-toggle')).toHaveAttribute('aria-pressed', 'false');

    contentHeight = 1500; // new output arrives
    observer().fire();
    expect(list.scrollTop).toBe(1000);

    fireEvent.scroll(list); // off the bottom: the jump button shows
    fireEvent.click(screen.getByTestId('jump-to-latest'));
    expect(list.scrollTop).toBe(1500);

    fireEvent.click(screen.getByTestId('auto-scroll-toggle')); // back to auto for other tests
  });
});
