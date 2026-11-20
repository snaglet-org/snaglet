import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  VisionPreviewFramePayload,
  VisionSessionSource,
  VisionSessionStatePayload,
  WsMessage,
} from '@snaglet/shared/types';
import { getApiUrl } from '@desktop/utils/api/core';
import { VisionComposerControl } from './VisionComposerControl';
import { VisionPreviewPanel } from './VisionPreviewPanel';
import { VisionTransientCaptureCards } from './VisionTransientCaptureCards';
import { VisionSessionProvider } from './VisionSessionContext';

const sendMock = vi.fn();
const fetchMock = vi.fn();
const createObjectUrlMock = vi.fn(() => 'blob:capture-preview');
const revokeObjectUrlMock = vi.fn();
const listeners = new Set<(message: WsMessage) => void>();
const screenTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
const cameraTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
const screenStream = { getTracks: () => [screenTrack] } as unknown as MediaStream;
const cameraStream = { getTracks: () => [cameraTrack] } as unknown as MediaStream;
let userActivation = false;

vi.mock('@desktop/ws/useWs.js', () => ({
  useWs: () => ({
    send: sendMock,
    connectionState: 'open',
    addMessageListener: (listener: (message: WsMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }),
}));

function emit(message: WsMessage): void {
  act(() => {
    for (const listener of listeners) listener(message);
  });
}

function session(overrides: Partial<VisionSessionStatePayload> = {}): VisionSessionStatePayload {
  return {
    threadId: 'thread-1',
    phase: 'active',
    enabled: true,
    source: 'screen',
    sessionId: 'session-1',
    sessionDir: '/tmp/vision/session-1',
    ready: true,
    error: null,
    updatedAt: '2026-07-18T21:00:00.000Z',
    ...overrides,
  };
}

function frame(expiresAt = '2999-01-01T00:01:00.000Z'): VisionPreviewFramePayload {
  return {
    threadId: 'thread-1',
    sessionId: 'session-1',
    frameId: 'frame-screen',
    source: 'screen',
    frameTs: '2026-07-18T21:00:01.000Z',
    mimeType: 'image/jpeg',
    deliveryUrl: '/api/AQID',
    byteLength: 3,
    expiresAt,
    updatedAt: '2026-07-18T21:00:01.050Z',
  };
}

beforeEach(() => {
  sendMock.mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    blob: () => Promise.resolve(new Blob(['frame'], { type: 'image/jpeg' })),
  });
  createObjectUrlMock.mockClear();
  revokeObjectUrlMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: createObjectUrlMock },
    revokeObjectURL: { configurable: true, value: revokeObjectUrlMock },
  });
  listeners.clear();
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
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    writable: true,
    value: null,
  });
});

function renderVision() {
  return render(
    <VisionSessionProvider threadId="thread-1">
      <VisionComposerControl />
      <VisionTransientCaptureCards />
      <VisionPreviewPanel />
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

async function startVision(
  source: VisionSessionSource,
  stateOverrides: Partial<VisionSessionStatePayload> = {}
) {
  await clickWithActivation(screen.getByRole('button', { name: 'Vision' }));
  const buttonName =
    source === 'screen' ? /^Screen share/ : source === 'camera' ? /^Camera/ : /^Both/;
  await clickWithActivation(screen.getByRole('button', { name: buttonName }));
  await waitFor(() =>
    expect(sendMock).toHaveBeenLastCalledWith({
      type: 'vision:session:start',
      channel: 'thread-1',
      payload: { threadId: 'thread-1', source },
    })
  );
  emit({ type: 'vision:session:state', payload: session({ source, ...stateOverrides }) });
}

describe('transient vision UI', () => {
  it('fails closed when a capture request has no browser-selected stream', async () => {
    renderVision();
    emit({
      type: 'vision:capture:request',
      channel: 'thread-1',
      payload: {
        threadId: 'thread-1',
        requestId: 'capture-1',
        source: 'screen',
      },
    });

    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'vision:capture:response',
        channel: 'thread-1',
        payload: {
          threadId: 'thread-1',
          requestId: 'capture-1',
          source: 'screen',
          error: 'The browser-selected screen stream is unavailable.',
          errorCode: 'stream_inactive',
        },
      })
    );
  });

  it('renders a client-local live preview independently from the captured bytes', async () => {
    renderVision();
    await startVision('screen');
    expect(await screen.findByLabelText('Live local screen preview')).toHaveProperty(
      'srcObject',
      screenStream
    );
    expect(screen.queryByTestId('vision-preview-screen-capture-flash')).not.toBeInTheDocument();
    emit({ type: 'vision:preview:frame', payload: frame() });
    expect(screen.getByTestId('vision-preview-screen-capture-flash')).toBeInTheDocument();
    expect(
      await screen.findByAltText('Temporary screen capture requested for this turn')
    ).toHaveAttribute('src', 'blob:capture-preview');
    expect(screen.getByText('Captured for current turn')).toBeInTheDocument();
  });

  it('flashes only the live preview matching the captured source', async () => {
    renderVision();
    await startVision('both');
    await screen.findByLabelText('Live local camera preview');
    expect(screen.queryByTestId('vision-preview-screen-capture-flash')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vision-preview-camera-capture-flash')).not.toBeInTheDocument();

    emit({ type: 'vision:preview:frame', payload: frame() });

    expect(screen.getByTestId('vision-preview-screen-capture-flash')).toBeInTheDocument();
    expect(screen.queryByTestId('vision-preview-camera-capture-flash')).not.toBeInTheDocument();
  });

  it('acquires both streams locally and stops them on source switch', async () => {
    renderVision();
    await startVision('both');
    expect(await screen.findByLabelText('Live local screen preview')).toHaveProperty(
      'srcObject',
      screenStream
    );
    expect(await screen.findByLabelText('Live local camera preview')).toHaveProperty(
      'srcObject',
      cameraStream
    );
    emit({
      type: 'vision:session:state',
      payload: session({ source: 'camera', sessionId: 'session-2' }),
    });
    await waitFor(() => expect(screenTrack.stop).toHaveBeenCalled());
    expect(cameraTrack.stop).not.toHaveBeenCalled();
  });

  it('loads the temporary capture preview through authenticated fetch and a blob URL', async () => {
    renderVision();
    await startVision('screen');
    emit({ type: 'vision:preview:frame', payload: frame() });

    const image = await screen.findByAltText('Temporary screen capture requested for this turn');
    expect(fetchMock).toHaveBeenCalledWith(getApiUrl('/AQID'), {
      signal: expect.any(AbortSignal),
    });
    expect(createObjectUrlMock).toHaveBeenCalledWith(expect.any(Blob));
    expect(image).toHaveAttribute('src', 'blob:capture-preview');
  });

  it('removes the temporary card on revocation without stopping local preview', async () => {
    renderVision();
    await startVision('screen');
    emit({ type: 'vision:preview:frame', payload: frame() });
    expect(
      await screen.findByAltText('Temporary screen capture requested for this turn')
    ).toBeInTheDocument();
    emit({
      type: 'vision:preview:clear',
      payload: {
        threadId: 'thread-1',
        sessionId: 'session-1',
        frameId: 'frame-screen',
        source: 'screen',
        updatedAt: new Date().toISOString(),
      },
    });
    expect(
      screen.queryByAltText('Temporary screen capture requested for this turn')
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Live local screen preview')).toBeInTheDocument();
  });

  it('shows an honest delivery failure state', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    renderVision();
    await startVision('screen');
    emit({ type: 'vision:preview:frame', payload: frame() });
    expect(await screen.findByText('Capture delivery failed')).toBeInTheDocument();
    expect(screen.getByText('Capture preview unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Vision captured')).not.toBeInTheDocument();
  });
});
