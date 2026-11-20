import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsMessage, SidebarTabId } from '@snaglet/shared/types';
import { useSidebarBridge } from './useSidebarBridge';
const ws = vi.hoisted(() => ({
  listeners: new Set<(message: WsMessage) => void>(),
  send: vi.fn(),
}));
vi.mock('./useWs', () => ({ useWs: () => ({ send: ws.send, addMessageListener: subscribe }) }));
function subscribe(listener: (message: WsMessage) => void) {
  ws.listeners.add(listener);
  return () => {
    ws.listeners.delete(listener);
  };
}
function Harness() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SidebarTabId>('tools');
  useSidebarBridge({ open, activeTab, setOpen, setActiveTab });
  return <div data-testid="state">{`${open}:${activeTab}`}</div>;
}
function command(op: string, tab?: string, target?: string) {
  act(() => {
    for (const listener of ws.listeners)
      listener({
        type: 'ui.sidebar_request',
        channel: 'ui',
        payload: {
          requestId: 'test-request',
          command: { op, ...(tab ? { tab } : {}), ...(target ? { target } : {}) },
        },
      });
  });
}
beforeEach(() => {
  ws.send.mockClear();
  ws.listeners.clear();
});
describe('sidebar UI acknowledgments', () => {
  it('opens, switches, closes and reopens while preserving the selected tab', () => {
    const view = render(<Harness />);
    command('open', 'library');
    expect(view.getByTestId('state').textContent).toBe('true:library');
    expect(ws.send.mock.lastCall?.[0].payload.state).toEqual({ open: true, active_tab: 'library' });
    command('open', 'agents');
    expect(view.getByTestId('state').textContent).toBe('true:agents');
    command('open', 'calendar');
    expect(view.getByTestId('state').textContent).toBe('true:calendar');
    command('open', 'library');
    command('close');
    expect(view.getByTestId('state').textContent).toBe('false:library');
    expect(ws.send.mock.lastCall?.[0].payload.state).toEqual({
      open: false,
      active_tab: 'library',
    });
    command('status');
    expect(ws.send.mock.lastCall?.[0].payload.state).toEqual({
      open: false,
      active_tab: 'library',
    });
    command('open');
    expect(view.getByTestId('state').textContent).toBe('true:library');
  });
  it('disclosure rejects closed sidebar, wrong tab and missing target without switching', () => {
    const view = render(<Harness />);
    command('expand', undefined, '["library","container","container-1"]');
    expect(ws.send.mock.lastCall?.[0].payload.error).toBe('sidebar_closed');
    command('open');
    command('collapse', undefined, '["library","container","container-1"]');
    expect(ws.send.mock.lastCall?.[0].payload.error).toBe('wrong_tab');
    command('expand', undefined, '["tools","group","builtin"]');
    expect(ws.send.mock.lastCall?.[0].payload.error).toBe('unsupported_target');
    command('expand');
    expect(ws.send.mock.lastCall?.[0].payload.error).toBe('invalid_command');
    expect(view.getByTestId('state').textContent).toBe('true:tools');
  });
  it('inspect reports the closed sidebar without mutation', () => {
    const view = render(<Harness />);
    command('inspect');
    expect(ws.send.mock.lastCall?.[0].payload.state).toEqual({
      open: false,
      active_tab: 'tools',
      detail: { kind: 'not_rendered', reason: 'closed' },
    });
    expect(view.getByTestId('state').textContent).toBe('false:tools');
  });
  it('rejects an unknown tab and malformed commands without mutation', () => {
    const view = render(<Harness />);
    command('open', 'board');
    expect(ws.send.mock.lastCall?.[0].payload.error).toBe('invalid_command');
    command('open', 'workspace');
    expect(ws.send.mock.lastCall?.[0].payload.error).toBe('invalid_command');
    command('close', 'tools');
    expect(ws.send.mock.lastCall?.[0].payload.error).toBe('invalid_command');
    expect(view.getByTestId('state').textContent).toBe('false:tools');
  });
});

import { useSidebarWidth } from '@desktop/pages/Dashboard/hooks/useSidebarWidth';
function ResizableHarness() {
  const { width, setWidth } = useSidebarWidth();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SidebarTabId>('skills');
  useSidebarBridge({
    width,
    setWidth,
    open,
    setOpen,
    activeTab,
    setActiveTab,
  });
  return <div data-testid="width-state">{`${open}:${activeTab}:${width}`}</div>;
}
it('resize clamps through native width hook, persists, and acknowledges committed width without opening or switching', () => {
  localStorage.removeItem('snaglet.dashboard.sidebarWidth');
  const view = render(<ResizableHarness />);
  for (const [requested, expected] of [
    [999, 560],
    [-10, 200],
    [312.5, 312.5],
  ]) {
    act(() => {
      for (const listener of ws.listeners)
        listener({
          type: 'ui.sidebar_request',
          channel: 'ui',
          payload: { requestId: 'resize', command: { op: 'resize', width_px: requested } },
        });
    });
    expect(view.getByTestId('width-state').textContent).toBe(`false:skills:${expected}`);
    expect(ws.send.mock.lastCall?.[0].payload.state).toEqual({
      open: false,
      active_tab: 'skills',
      width_px: expected,
    });
    expect(localStorage.getItem('snaglet.dashboard.sidebarWidth')).toBe(String(expected));
  }
  command('status');
  expect(ws.send.mock.lastCall?.[0].payload.state.width_px).toBe(312.5);
  view.unmount();
  const remount = render(<ResizableHarness />);
  // Existing persistence uses integer pixels on reload, just like native drag.
  expect(remount.getByTestId('width-state').textContent).toBe('false:skills:312');
});
it('batched open/close requests report committed state, never an optimistic state per command', () => {
  render(<Harness />);
  act(() => {
    command('open', 'calendar');
    command('close');
  });
  const replies = ws.send.mock.calls.map(([message]) => message.payload.state);
  expect(replies).toEqual([
    { open: false, active_tab: 'calendar' },
    { open: false, active_tab: 'calendar' },
  ]);
});

import { useRef } from 'react';
function ScrollHarness({ initiallyOpen = true }: { initiallyOpen?: boolean }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(initiallyOpen);
  const [activeTab, setActiveTab] = useState<SidebarTabId>('providers');
  useSidebarBridge({ panelRef, open, activeTab, setOpen, setActiveTab });
  return (
    <div ref={panelRef}>
      <div data-testid="scroller" style={{ overflowY: 'auto' }} />
    </div>
  );
}
function scrollCommand(payload: Record<string, unknown>) {
  act(() => {
    for (const listener of ws.listeners)
      listener({
        type: 'ui.sidebar_request',
        channel: 'ui',
        payload: { requestId: 'scroll', command: { op: 'scroll', ...payload } },
      });
  });
}
function fakeMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}
describe('sidebar scroll', () => {
  it('eases to the bottom over duration_ms and replies only after the last frame', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'performance', 'setTimeout'] });
    try {
      const view = render(<ScrollHarness />);
      const scroller = view.getByTestId('scroller');
      fakeMetrics(scroller, 1000, 400);
      scrollCommand({ to: 'bottom', duration_ms: 1000 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(ws.send).not.toHaveBeenCalled();
      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(scroller.scrollTop).toBeLessThan(600);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(scroller.scrollTop).toBe(600);
      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(ws.send.mock.lastCall?.[0].payload).toEqual({
        requestId: 'scroll',
        state: {
          open: true,
          active_tab: 'providers',
          scrolled: true,
          scroll_top: 600,
          scroll_height: 1000,
          client_height: 400,
          at_bottom: true,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('rejects a closed sidebar, wrong tab, bad params and an unscrollable panel', async () => {
    const closed = render(<ScrollHarness initiallyOpen={false} />);
    scrollCommand({ to: 'bottom' });
    expect(ws.send.mock.lastCall?.[0].payload.error).toBe('sidebar_closed');
    closed.unmount();
    ws.listeners.clear();
    render(<ScrollHarness />);
    scrollCommand({ target: '["tools","mounted","1"]' });
    expect(ws.send.mock.lastCall?.[0].payload.error).toBe('wrong_tab');
    scrollCommand({ to: 'bottom', target: '["providers","mounted","1"]' });
    expect(ws.send.mock.lastCall?.[0].payload.error).toBe('invalid_command');
    scrollCommand({});
    expect(ws.send.mock.lastCall?.[0].payload.error).toBe('invalid_command');
    // jsdom has no layout: scrollHeight === clientHeight, so nothing scrolls.
    await act(async () => {
      scrollCommand({ to: 'top', duration_ms: 0 });
      await Promise.resolve();
    });
    expect(ws.send.mock.lastCall?.[0].payload.error).toBe('not_scrollable');
  });
});
