const mockHandlers = new Map<string, (payload: unknown, meta: { clientId: string }) => void>();
const mockSend = jest.fn();
let mockDisconnect: (clientId: string) => void;
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    registerHandler: (
      type: string,
      handler: (payload: unknown, meta: { clientId: string }) => void
    ) => mockHandlers.set(type, handler),
    sendToClient: (...args: unknown[]) => mockSend(...args),
    onDisconnect: (handler: (clientId: string) => void) => {
      mockDisconnect = handler;
    },
  },
}));
import {
  initUiSurface,
  requestSidebar,
  resolveAnyConnectedUserId,
  requestPaneLayout,
} from '@server/realtime/surfaces/ui';
const actor = { actorId: 'test-agent', actorKind: 'agent' as const };
const emit = (type: string, payload: unknown, clientId = 'test-client') =>
  mockHandlers.get(type)!(payload, { clientId });
const register = (userId = 'test-user', clientId = 'test-client') =>
  emit('ui.register_client', { userId }, clientId);
const request = () => requestSidebar({ userId: 'test-user', actor, command: { op: 'close' } });
const response = (requestId: string) => ({
  requestId,
  state: { open: false, active_tab: 'tools' },
});
beforeAll(() => initUiSurface());
beforeEach(() => {
  mockSend.mockReset().mockReturnValue(true);
});
afterEach(() => {
  mockDisconnect('test-client');
  mockDisconnect('other-client');
  jest.useRealTimers();
});

test('no registration returns no_active_client for sidebar and panes', async () => {
  expect(await request()).toEqual({ success: false, reason: 'no_active_client' });
  expect(await requestPaneLayout({ userId: 'test-user', actor })).toEqual({
    viewable: false,
    reason: 'no_active_client',
  });
});
test('awaits correlated ack from addressed client, rejecting unrelated or malformed replies', async () => {
  register();
  const promise = request();
  const id = mockSend.mock.calls[0][1].payload.requestId;
  emit('ui.sidebar_response', response(id), 'other-client');
  emit('ui.sidebar_response', { requestId: id, state: { open: 'false', active_tab: 'tools' } });
  emit('ui.sidebar_response', response('unknown'));
  emit('ui.sidebar_response', response(id));
  expect(await promise).toEqual({ success: true, state: { open: false, active_tab: 'tools' } });
});
test('timeout never reports success', async () => {
  jest.useFakeTimers();
  register();
  const promise = request();
  jest.advanceTimersByTime(3000);
  expect(await promise).toEqual({ success: false, reason: 'sidebar_timeout' });
});
test('dead sends prune the connection immediately', async () => {
  register();
  mockSend.mockReturnValue(false);
  expect(await request()).toEqual({ success: false, reason: 'no_active_client' });
  expect(resolveAnyConnectedUserId()).toBeNull();
});
test('profile re-registration removes old owner and disconnect prunes new owner', async () => {
  register('old-user');
  register();
  expect(await requestSidebar({ userId: 'old-user', actor, command: { op: 'status' } })).toEqual({
    success: false,
    reason: 'no_active_client',
  });
  expect(resolveAnyConnectedUserId()).toBe('test-user');
  mockDisconnect('test-client');
  expect(resolveAnyConnectedUserId()).toBeNull();
});
test('unavailable tabs return explicit failure', async () => {
  register();
  const promise = request();
  emit('ui.sidebar_response', {
    ...response(mockSend.mock.calls[0][1].payload.requestId),
    error: 'tab_unavailable',
  });
  expect(await promise).toEqual({ success: false, reason: 'tab_unavailable' });
});

test('registered client answers pane layout via the same repaired registry', async () => {
  register();
  const promise = requestPaneLayout({ userId: 'test-user', actor });
  const requestId = mockSend.mock.calls[0][1].payload.requestId;
  const layout = { panes: [] };
  emit('ui.pane_layout_response', { requestId, layout });
  expect(await promise).toEqual({ viewable: true, layout });
});

test('inspect requires valid detail and relays the actual snapshot', async () => {
  register();
  const promise = requestSidebar({ userId: 'test-user', actor, command: { op: 'inspect' } });
  const requestId = mockSend.mock.calls[0][1].payload.requestId;
  // A status-only or malformed detail reply cannot satisfy an inspect request.
  emit('ui.sidebar_response', response(requestId));
  emit('ui.sidebar_response', {
    ...response(requestId),
    state: { open: false, active_tab: 'tools', detail: { kind: 'invented' } },
  });
  const state = {
    open: false,
    active_tab: 'tools',
    detail: { kind: 'not_rendered', reason: 'closed' },
  };
  emit('ui.sidebar_response', { requestId, state });
  expect(await promise).toEqual({ success: true, state });
});

test('expand requires matching committed node and expanded state, not an optimistic status', async () => {
  register();
  const promise = requestSidebar({
    userId: 'test-user',
    actor,
    command: { op: 'expand', target: '["library","container","container-1"]' },
  });
  const requestId = mockSend.mock.calls[0][1].payload.requestId;
  emit('ui.sidebar_response', response(requestId));
  emit('ui.sidebar_response', {
    requestId,
    state: { open: true, active_tab: 'library', target: 'wrong-id', expanded: true },
  });
  const state = {
    open: true,
    active_tab: 'library',
    target: '["library","container","container-1"]',
    expanded: true,
  };
  emit('ui.sidebar_response', { requestId, state });
  expect(await promise).toEqual({ success: true, state });
});
test.each(['sidebar_closed', 'wrong_tab', 'node_unavailable', 'not_container'])(
  'disclosure failure %s is explicit',
  async (error) => {
    register();
    const promise = requestSidebar({
      userId: 'test-user',
      actor,
      command: { op: 'collapse', target: '["library","container","container-1"]' },
    });
    const requestId = mockSend.mock.calls[0][1].payload.requestId;
    emit('ui.sidebar_response', { ...response(requestId), error });
    expect(await promise).toEqual({ success: false, reason: error });
  }
);

test('concurrent open/close acknowledgments must match each requested state and tab', async () => {
  jest.useFakeTimers();
  register();
  const open = requestSidebar({
    userId: 'test-user',
    actor,
    command: { op: 'open', tab: 'calendar' },
  });
  const close = request();
  const openId = mockSend.mock.calls[0][1].payload.requestId;
  const closeId = mockSend.mock.calls[1][1].payload.requestId;
  emit('ui.sidebar_response', {
    requestId: openId,
    state: { open: false, active_tab: 'calendar' },
  });
  emit('ui.sidebar_response', { requestId: openId, state: { open: true, active_tab: 'tools' } });
  emit('ui.sidebar_response', {
    requestId: closeId,
    state: { open: true, active_tab: 'calendar' },
  });
  emit('ui.sidebar_response', { requestId: openId, state: { open: true, active_tab: 'calendar' } });
  expect(await open).toEqual({ success: true, state: { open: true, active_tab: 'calendar' } });
  jest.advanceTimersByTime(3000);
  expect(await close).toEqual({ success: false, reason: 'sidebar_timeout' });
});

test('open without a tab accepts any selected tab but requires open', async () => {
  register();
  const promise = requestSidebar({ userId: 'test-user', actor, command: { op: 'open' } });
  const requestId = mockSend.mock.calls[0][1].payload.requestId;
  emit('ui.sidebar_response', response(requestId));
  emit('ui.sidebar_response', { requestId, state: { open: true, active_tab: 'skills' } });
  expect(await promise).toEqual({ success: true, state: { open: true, active_tab: 'skills' } });
});

test('resize requires the confirmed native-clamped width, not an optimistic response', async () => {
  register();
  const promise = requestSidebar({
    userId: 'test-user',
    actor,
    command: { op: 'resize', width_px: 999 },
  });
  const requestId = mockSend.mock.calls[0][1].payload.requestId;
  emit('ui.sidebar_response', {
    requestId,
    state: { open: false, active_tab: 'skills', width_px: 999 },
  });
  emit('ui.sidebar_response', {
    requestId,
    state: { open: false, active_tab: 'skills', width_px: 560 },
  });
  expect(await promise).toEqual({
    success: true,
    state: { open: false, active_tab: 'skills', width_px: 560 },
  });
});

test('scroll requires finished-animation metrics, then returns them', async () => {
  register();
  const promise = requestSidebar({
    userId: 'test-user',
    actor,
    command: { op: 'scroll', to: 'bottom', duration_ms: 600 },
  });
  const requestId = mockSend.mock.calls[0][1].payload.requestId;
  emit('ui.sidebar_response', { requestId, state: { open: true, active_tab: 'providers' } });
  const metrics = {
    scrolled: true,
    scroll_top: 400,
    scroll_height: 900,
    client_height: 500,
    at_bottom: true,
  };
  emit('ui.sidebar_response', {
    requestId,
    state: { open: true, active_tab: 'providers', ...metrics },
  });
  expect(await promise).toEqual({
    success: true,
    state: { open: true, active_tab: 'providers', ...metrics },
  });
});
