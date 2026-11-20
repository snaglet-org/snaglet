type RegisteredHandler = (
  payload: unknown,
  meta: { clientId: string; channel?: string }
) => void | Promise<void>;

const handlers = new Map<string, RegisteredHandler>();
const registerHandlerMock = jest.fn((type: string, handler: RegisteredHandler) => {
  handlers.set(type, handler);
});
const sendToClientMock = jest.fn();

jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    registerHandler: (...args: unknown[]) => registerHandlerMock(...args),
    sendToClient: (...args: unknown[]) => sendToClientMock(...args),
  },
}));

const findThreadMock = jest.fn();
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (...args: unknown[]) => findThreadMock(...args) },
}));

const startMock = jest.fn();
const stopMock = jest.fn();
const sessionStateMock = jest.fn();
const statusMock = jest.fn();
jest.mock('@server/services/vision/VisionThreadService', () => ({
  visionThreadService: {
    start: (...args: unknown[]) => startMock(...args),
    stop: (...args: unknown[]) => stopMock(...args),
    sessionState: (...args: unknown[]) => sessionStateMock(...args),
    status: (...args: unknown[]) => statusMock(...args),
  },
}));

// Vision toggles are narrated as persisted thread_events from the call sites
// (here and the vision_mode tool), not from inside VisionThreadService — the
// service keeps no DB dependency and a shutdown stopAll() must not narrate.
const emitVisionModeChangedMock = jest.fn();
jest.mock('@server/services/SocketService/threadEvents', () => ({
  emitVisionModeChangedEvent: (...args: unknown[]) => emitVisionModeChangedMock(...args),
}));

import { registerVisionHandlers } from '@server/services/SocketService/visionSession';

const meta = { clientId: 'client-1', channel: 'thread-1' };

beforeEach(() => {
  jest.clearAllMocks();
  handlers.clear();
  findThreadMock.mockResolvedValue({ id: 'thread-1' });
  startMock.mockResolvedValue({ enabled: true, source: 'screen' });
  stopMock.mockResolvedValue({ enabled: false, source: null });
  statusMock.mockReturnValue({ enabled: false, source: null });
  emitVisionModeChangedMock.mockResolvedValue(undefined);
  sessionStateMock.mockReturnValue({
    threadId: 'thread-1',
    phase: 'active',
    enabled: true,
    source: 'camera',
  });
  registerVisionHandlers();
});

describe('vision WebSocket handlers', () => {
  it.each(['screen', 'camera', 'both'] as const)(
    'starts %s through the shared service',
    async (source) => {
      await handlers.get('vision:session:start')!({ threadId: 'thread-1', source }, meta);

      expect(startMock).toHaveBeenCalledWith('thread-1', source, 'client-1');
      expect(sendToClientMock).not.toHaveBeenCalled();
    }
  );

  it('stops through the shared service', async () => {
    await handlers.get('vision:session:stop')!({ threadId: 'thread-1' }, meta);
    expect(stopMock).toHaveBeenCalledWith('thread-1');
  });

  it('narrates the grant with the before/after source so agents learn about it', async () => {
    statusMock.mockReturnValue({ enabled: false, source: null });
    startMock.mockResolvedValue({ enabled: true, source: 'camera' });

    await handlers.get('vision:session:start')!({ threadId: 'thread-1', source: 'camera' }, meta);

    expect(emitVisionModeChangedMock).toHaveBeenCalledWith('thread-1', null, 'camera');
  });

  it('narrates a revocation with the source that was active before the stop', async () => {
    statusMock.mockReturnValue({ enabled: true, source: 'both' });

    await handlers.get('vision:session:stop')!({ threadId: 'thread-1' }, meta);

    expect(emitVisionModeChangedMock).toHaveBeenCalledWith('thread-1', 'both', null);
  });

  it('does not narrate when the toggle itself failed — state never changed', async () => {
    startMock.mockRejectedValueOnce(new Error('Camera permission denied'));
    await handlers.get('vision:session:start')!({ threadId: 'thread-1', source: 'camera' }, meta);
    expect(emitVisionModeChangedMock).not.toHaveBeenCalled();
  });

  it('re-emits current access state without hydrating deleted temporary pixels', async () => {
    await handlers.get('vision:session:status')!({ threadId: 'thread-1' }, meta);

    expect(sendToClientMock).toHaveBeenCalledWith('client-1', {
      type: 'vision:session:state',
      channel: 'thread-1',
      payload: expect.objectContaining({ threadId: 'thread-1', source: 'camera' }),
    });
    expect(sendToClientMock).toHaveBeenCalledTimes(1);
  });

  it('returns inline-safe errors for a mismatched channel and capture failure', async () => {
    await handlers.get('vision:session:start')!(
      { threadId: 'thread-1', source: 'screen' },
      { ...meta, channel: 'other-thread' }
    );
    expect(startMock).not.toHaveBeenCalled();
    expect(sendToClientMock).toHaveBeenLastCalledWith(
      'client-1',
      expect.objectContaining({ type: 'vision:session:error' })
    );

    startMock.mockRejectedValueOnce(new Error('Camera permission denied'));
    await handlers.get('vision:session:start')!({ threadId: 'thread-1', source: 'camera' }, meta);
    expect(sendToClientMock).toHaveBeenLastCalledWith(
      'client-1',
      expect.objectContaining({
        type: 'vision:session:error',
        payload: { threadId: 'thread-1', message: 'Camera permission denied' },
      })
    );
  });
});
