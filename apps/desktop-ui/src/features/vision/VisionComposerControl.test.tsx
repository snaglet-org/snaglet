import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisionSessionStatePayload, WsMessage } from '@snaglet/shared/types';
import { VisionComposerControl } from './VisionComposerControl';
import { VisionSessionProvider, useVisionSessionContext } from './VisionSessionContext';

const sendMock = vi.fn();
const listeners = new Set<(message: WsMessage) => void>();
let connectionState: 'connecting' | 'open' | 'closed' | 'error' = 'open';
let userActivation = false;
const screenTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
const cameraTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
const screenStream = { getTracks: () => [screenTrack] } as unknown as MediaStream;
const cameraStream = { getTracks: () => [cameraTrack] } as unknown as MediaStream;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (cause: Error) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

vi.mock('@desktop/ws/useWs.js', () => ({
  useWs: () => ({
    send: sendMock,
    connectionState,
    addMessageListener: (listener: (message: WsMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }),
}));

function state(overrides: Partial<VisionSessionStatePayload> = {}): VisionSessionStatePayload {
  return {
    threadId: 'thread-1',
    phase: 'inactive',
    enabled: false,
    source: null,
    sessionId: null,
    sessionDir: null,
    ready: false,
    error: null,
    updatedAt: '2026-07-18T21:00:00.000Z',
    ...overrides,
  };
}

function emit(message: WsMessage): void {
  act(() => {
    for (const listener of listeners) listener(message);
  });
}

function renderControl() {
  return render(
    <VisionSessionProvider threadId="thread-1">
      <VisionComposerControl />
    </VisionSessionProvider>
  );
}

function controlTree() {
  return (
    <VisionSessionProvider threadId="thread-1">
      <VisionComposerControl />
    </VisionSessionProvider>
  );
}

function VisionSessionHarness() {
  const context = useVisionSessionContext();
  if (!context) return null;
  return (
    <>
      <button type="button" onClick={() => context.start('screen')}>
        Start screen
      </button>
      <button type="button" onClick={() => context.start('camera')}>
        Start camera
      </button>
      <button type="button" onClick={() => context.stop()}>
        Stop vision
      </button>
    </>
  );
}

function renderHarness() {
  return render(
    <VisionSessionProvider threadId="thread-1">
      <VisionSessionHarness />
    </VisionSessionProvider>
  );
}

async function clickWithActivation(element: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  userActivation = true;
  try {
    await user.click(element);
  } finally {
    userActivation = false;
  }
}

beforeEach(() => {
  sendMock.mockClear();
  listeners.clear();
  connectionState = 'open';
  userActivation = false;
  screenTrack.stop = vi.fn();
  cameraTrack.stop = vi.fn();
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getDisplayMedia: vi.fn().mockImplementation(() => {
        if (!userActivation) return Promise.reject(new Error('display activation missing'));
        return Promise.resolve(screenStream);
      }),
      getUserMedia: vi.fn().mockImplementation(() => {
        if (!userActivation) return Promise.reject(new Error('camera activation missing'));
        return Promise.resolve(cameraStream);
      }),
    },
  });
});

describe('VisionComposerControl', () => {
  it('offers distinct sources and switches an active session without a stop', async () => {
    renderControl();

    await clickWithActivation(screen.getByRole('button', { name: 'Vision' }));
    expect(screen.getByText('Screen share')).toBeInTheDocument();
    expect(screen.getByText('Camera')).toBeInTheDocument();
    expect(screen.getByText('Both')).toBeInTheDocument();
    await clickWithActivation(screen.getByRole('button', { name: /^Screen share/ }));
    await waitFor(() =>
      expect(sendMock).toHaveBeenLastCalledWith({
        type: 'vision:session:start',
        channel: 'thread-1',
        payload: { threadId: 'thread-1', source: 'screen' },
      })
    );
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1);

    emit({
      type: 'vision:session:state',
      channel: 'thread-1',
      payload: state({ phase: 'active', enabled: true, source: 'screen', ready: true }),
    });
    await clickWithActivation(screen.getByRole('button', { name: 'Screen access on' }));
    await clickWithActivation(screen.getByRole('button', { name: /^Camera/ }));

    await waitFor(() =>
      expect(sendMock).toHaveBeenLastCalledWith({
        type: 'vision:session:start',
        channel: 'thread-1',
        payload: { threadId: 'thread-1', source: 'camera' },
      })
    );
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'vision:session:stop' })
    );
  });

  it('starts both local streams from the explicit click before server access starts', async () => {
    renderControl();

    await clickWithActivation(screen.getByRole('button', { name: 'Vision' }));
    await clickWithActivation(screen.getByRole('button', { name: /^Both/ }));

    await waitFor(() =>
      expect(sendMock).toHaveBeenLastCalledWith({
        type: 'vision:session:start',
        channel: 'thread-1',
        payload: { threadId: 'thread-1', source: 'both' },
      })
    );
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledWith({ video: true });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
  });

  it('shows an inline error and does not start server access when browser media rejects', async () => {
    vi.mocked(navigator.mediaDevices.getDisplayMedia).mockRejectedValueOnce(
      new Error('display activation missing')
    );
    renderControl();

    await clickWithActivation(screen.getByRole('button', { name: 'Vision' }));
    await clickWithActivation(screen.getByRole('button', { name: /^Screen share/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Screen capture failed unexpectedly. Enable vision again and try once more.'
    );
    expect(sendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'vision:session:start' })
    );
    expect(sendMock).toHaveBeenLastCalledWith({
      type: 'vision:session:stop',
      channel: 'thread-1',
      payload: { threadId: 'thread-1' },
    });
  });

  it('invalidates a pending stream acquisition when vision is stopped before it resolves', async () => {
    const pendingScreen = deferred<MediaStream>();
    vi.mocked(navigator.mediaDevices.getDisplayMedia).mockImplementationOnce(() => {
      if (!userActivation) return Promise.reject(new Error('display activation missing'));
      return pendingScreen.promise;
    });
    renderHarness();

    await clickWithActivation(screen.getByRole('button', { name: 'Start screen' }));
    await clickWithActivation(screen.getByRole('button', { name: 'Stop vision' }));
    pendingScreen.resolve(screenStream);

    await waitFor(() => expect(screenTrack.stop).toHaveBeenCalledTimes(1));
    expect(sendMock).toHaveBeenCalledWith({
      type: 'vision:session:stop',
      channel: 'thread-1',
      payload: { threadId: 'thread-1' },
    });
    expect(sendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'vision:session:start',
        payload: expect.objectContaining({ source: 'screen' }),
      })
    );
  });

  it('drops an older pending acquisition when a newer source switch resolves first', async () => {
    const pendingScreen = deferred<MediaStream>();
    const pendingCamera = deferred<MediaStream>();
    vi.mocked(navigator.mediaDevices.getDisplayMedia).mockImplementationOnce(() => {
      if (!userActivation) return Promise.reject(new Error('display activation missing'));
      return pendingScreen.promise;
    });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(() => {
      if (!userActivation) return Promise.reject(new Error('camera activation missing'));
      return pendingCamera.promise;
    });
    renderHarness();

    await clickWithActivation(screen.getByRole('button', { name: 'Start screen' }));
    await clickWithActivation(screen.getByRole('button', { name: 'Start camera' }));
    pendingCamera.resolve(cameraStream);
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'vision:session:start',
        channel: 'thread-1',
        payload: { threadId: 'thread-1', source: 'camera' },
      })
    );

    pendingScreen.resolve(screenStream);

    await waitFor(() => expect(screenTrack.stop).toHaveBeenCalledTimes(1));
    expect(cameraTrack.stop).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'vision:session:start',
        payload: expect.objectContaining({ source: 'screen' }),
      })
    );
  });

  it('reflects agent-started and stopped server events without local lifecycle state', () => {
    renderControl();

    emit({
      type: 'vision:session:state',
      channel: 'thread-1',
      payload: state({ phase: 'starting', enabled: true, source: 'camera' }),
    });
    expect(screen.getByRole('button', { name: 'Starting Camera' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    emit({
      type: 'vision:session:state',
      channel: 'thread-1',
      payload: state({ phase: 'active', enabled: true, source: 'camera', ready: true }),
    });
    expect(screen.getByRole('button', { name: 'Camera access on' })).toBeInTheDocument();

    emit({
      type: 'vision:session:state',
      channel: 'thread-1',
      payload: state(),
    });
    expect(screen.getByRole('button', { name: 'Vision' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('requests authoritative state on connect and reconnect', () => {
    const view = renderControl();
    expect(sendMock).toHaveBeenCalledWith({
      type: 'vision:session:status',
      channel: 'thread-1',
      payload: { threadId: 'thread-1' },
    });

    sendMock.mockClear();
    connectionState = 'closed';
    view.rerender(controlTree());
    connectionState = 'open';
    view.rerender(controlTree());
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'vision:session:status', channel: 'thread-1' })
    );
  });

  it('shows capture errors inline and sends stop from the active menu', async () => {
    renderControl();
    emit({
      type: 'vision:session:state',
      channel: 'thread-1',
      payload: state({ phase: 'active', enabled: true, source: 'both', ready: true }),
    });
    emit({
      type: 'vision:session:error',
      channel: 'thread-1',
      payload: { threadId: 'thread-1', message: 'Camera permission denied' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Camera permission denied');

    await clickWithActivation(screen.getByRole('button', { name: 'Both access on' }));
    await clickWithActivation(screen.getByRole('button', { name: 'Stop vision access' }));
    expect(sendMock).toHaveBeenLastCalledWith({
      type: 'vision:session:stop',
      channel: 'thread-1',
      payload: { threadId: 'thread-1' },
    });
  });
});
