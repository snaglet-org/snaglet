/**
 * ActivityDisclosure — a live run's activity box shows its NEWEST step: it opens
 * at the bottom, keeps following as steps and output stream in (a growing tool
 * bundle included), and stops following once the user scrolls up to read.
 */
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { ActivityDisclosure } from './ActivityDisclosure';
import type { ActivityStep, RunActivity } from '../hooks/types';

/** jsdom has no layout or ResizeObserver; both are driven by the test. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    FakeResizeObserver.instances = FakeResizeObserver.instances.filter((o) => o !== this);
  }
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let contentHeight = 2000;
const VIEWPORT = 340;

function tool(i: number, output?: string): ActivityStep {
  return {
    kind: 'tool_call',
    id: `t${i}`,
    toolName: 'shell',
    input: { op: 'run', cmd: `echo ${i}` },
    output,
    status: output ? 'done' : 'running',
    success: true,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  };
}

function activity(steps: ActivityStep[]): RunActivity {
  return {
    runId: 'run-1111111111111-aaaaaaaaa',
    agentId: 'test-agent-a',
    threadId: 'thread-1',
    steps,
    status: 'live',
    startedAt: '2026-01-01T00:00:00Z',
  } as RunActivity;
}

const bottom = () => contentHeight - VIEWPORT;

function body(container: HTMLElement): HTMLDivElement {
  return container.querySelector('details > div') as HTMLDivElement;
}

const flushFrames = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

beforeEach(() => {
  contentHeight = 2000;
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    return setTimeout(() => cb(performance.now()), 0) as unknown as number;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => clearTimeout(id));
  // Report real dimensions from the first layout effect on, and clamp
  // scrollTop to the scrollable range like a browser does.
  const tops = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => contentHeight,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      tops.set(this, Math.max(0, Math.min(v, contentHeight - VIEWPORT)));
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ['scrollHeight', 'clientHeight', 'scrollTop'])
    Reflect.deleteProperty(HTMLElement.prototype, k);
});

describe('ActivityDisclosure — follows the live tail', () => {
  it('opens a live run at its newest step, not the first one', async () => {
    const steps = Array.from({ length: 32 }, (_, i) => tool(i, `out ${i}`));
    const { container } = render(<ActivityDisclosure activity={activity(steps)} />);
    const el = body(container);
    await flushFrames();
    expect(el.scrollTop).toBe(bottom());
  });

  it('keeps following while a tool bundle grows without a new step', async () => {
    const { container } = render(<ActivityDisclosure activity={activity([tool(0), tool(1)])} />);
    const el = body(container);
    await flushFrames();
    // Output lays out after the pin; the pin's own late scroll event must not
    // be mistaken for the user scrolling away.
    contentHeight = 3000;
    fireEvent.scroll(el);
    act(() => FakeResizeObserver.instances.forEach((o) => o.fire()));
    expect(el.scrollTop).toBe(bottom());
  });

  it('stops following once the user scrolls up, and resumes at the bottom', async () => {
    const { container, rerender } = render(
      <ActivityDisclosure activity={activity([tool(0, 'a'), tool(1)])} />
    );
    const el = body(container);
    await flushFrames();
    el.scrollTop = 100;
    fireEvent.scroll(el);
    contentHeight = 2600;
    rerender(<ActivityDisclosure activity={activity([tool(0, 'a'), tool(1, 'b'), tool(2)])} />);
    await flushFrames();
    act(() => FakeResizeObserver.instances.forEach((o) => o.fire()));
    expect(el.scrollTop).toBe(100);

    el.scrollTop = bottom();
    fireEvent.scroll(el);
    contentHeight = 3200;
    act(() => FakeResizeObserver.instances.forEach((o) => o.fire()));
    expect(el.scrollTop).toBe(bottom());
  });
});
