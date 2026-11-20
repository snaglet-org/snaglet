import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useUiNavigationBridge } from './useUiNavigationBridge';
import type { LayoutNode } from '@desktop/pages/Dashboard/layout/paneTree';
const ws = vi.hoisted(() => ({
  connectionState: 'open',
  userId: null as string | null,
  send: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  addMessageListener: vi.fn(() => () => {}),
}));
vi.mock('./useWs', () => ({ useWs: () => ws }));
vi.mock('@desktop/config', () => ({
  getActiveUserId: () => ws.userId,
  ACTIVE_USER_CHANGED_EVENT: 'snaglet:active-user-changed',
  ACTIVE_USER_ID_KEY: 'snaglet.activeUserId',
}));
vi.mock('@desktop/pages/Dashboard/selection/resolveNavigationTarget', () => ({
  resolveNavigationTarget: vi.fn(),
}));
const args = { layout: {} as LayoutNode, activeThreadId: null, navigatePaneByKey: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  ws.userId = null;
  ws.connectionState = 'open';
});
it('registers when async identity arrives after the socket opens and on profile changes', () => {
  const { unmount } = renderHook(() => useUiNavigationBridge(args));
  expect(ws.send).not.toHaveBeenCalled();
  act(() => {
    ws.userId = 'test-user';
    window.dispatchEvent(new Event('snaglet:active-user-changed'));
  });
  expect(ws.send).toHaveBeenLastCalledWith({
    type: 'ui.register_client',
    channel: 'ui',
    payload: { userId: 'test-user' },
  });
  act(() => {
    ws.userId = 'other-user';
    window.dispatchEvent(new Event('snaglet:active-user-changed'));
  });
  expect(ws.send.mock.lastCall?.[0].payload.userId).toBe('other-user');
  unmount();
  const count = ws.send.mock.calls.length;
  act(() => window.dispatchEvent(new Event('snaglet:active-user-changed')));
  expect(ws.send).toHaveBeenCalledTimes(count);
  expect(ws.unsubscribe).toHaveBeenCalledWith('ui');
});
it('registers persisted identity at open and again on reconnect', () => {
  ws.userId = 'test-user';
  const { rerender } = renderHook(() => useUiNavigationBridge(args));
  expect(ws.send).toHaveBeenCalledTimes(1);
  ws.connectionState = 'closed';
  rerender();
  ws.connectionState = 'open';
  rerender();
  expect(ws.send).toHaveBeenCalledTimes(2);
});
