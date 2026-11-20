import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisionCaptureResponsePayload, WsMessage } from '@snaglet/shared/types';
import { VisionSessionProvider, useVisionSessionContext } from './VisionSessionContext';
import * as captureFrameModule from './captureFrame';

vi.mock('./captureFrame', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./captureFrame')>();
  return {
    ...actual,
    captureStreamFrame: vi.fn(actual.captureStreamFrame),
  };
});

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

const sendMock = vi.fn();
const listeners = new Set<(message: WsMessage) => void>();
let userActivation = false;
let cameraStreamToReturn: MediaStream | null = null;

function fakeTrack(readyState: 'live' | 'ended'): MediaStreamTrack {
  return { readyState, stop: vi.fn() } as unknown as MediaStreamTrack;
}

function fakeStream(readyState: 'live' | 'ended'): MediaStream {
  const track = fakeTrack(readyState);
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

function emit(message: WsMessage): void {
  act(() => {
    for (const listener of listeners) listener(message);
  });
}

function VisionSessionHarness() {
  const context = useVisionSessionContext();
  if (!context) return null;
  return (
    <button type="button" onClick={() => context.start('camera')}>
      Start camera
    </button>
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

async function startCameraWithStream(readyState: 'live' | 'ended'): Promise<void> {
  cameraStreamToReturn = fakeStream(readyState);
  renderHarness();
  await clickWithActivation(screen.getByRole('button', { name: 'Start camera' }));
  await waitFor(() =>
    expect(sendMock).toHaveBeenCalledWith({
      type: 'vision:session:start',
      channel: 'thread-1',
      payload: { threadId: 'thread-1', source: 'camera' },
    })
  );
}

function lastCaptureResponse(): VisionCaptureResponsePayload {
  const call = sendMock.mock.calls.find(([message]) => message.type === 'vision:capture:response');
  if (!call) throw new Error('No vision:capture:response was sent');
  return call[0].payload as VisionCaptureResponsePayload;
}

beforeEach(() => {
  sendMock.mockClear();
  listeners.clear();
  userActivation = false;
  cameraStreamToReturn = null;
  vi.mocked(captureFrameModule.captureStreamFrame).mockClear();
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getDisplayMedia: vi.fn().mockImplementation(() => {
        if (!userActivation) return Promise.reject(new Error('display activation missing'));
        return Promise.resolve(fakeStream('live'));
      }),
      getUserMedia: vi.fn().mockImplementation(() => {
        if (!userActivation) return Promise.reject(new Error('camera activation missing'));
        return Promise.resolve(cameraStreamToReturn);
      }),
    },
  });
});

describe('VisionSessionContext capture requests', () => {
  it('replies stream_inactive and names the camera when there is no local stream', async () => {
    renderHarness();

    emit({
      type: 'vision:capture:request',
      channel: 'thread-1',
      payload: { threadId: 'thread-1', requestId: 'capture-1', source: 'camera' },
    });

    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'vision:capture:response' })
      )
    );
    const response = lastCaptureResponse();
    expect(response.errorCode).toBe('stream_inactive');
    expect(response.error?.toLowerCase()).toContain('camera');
    expect(response.base64).toBeUndefined();
  });

  it('replies stream_inactive when the local camera stream track is not live', async () => {
    await startCameraWithStream('ended');

    emit({
      type: 'vision:capture:request',
      channel: 'thread-1',
      payload: { threadId: 'thread-1', requestId: 'capture-2', source: 'camera' },
    });

    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'vision:capture:response' })
      )
    );
    const response = lastCaptureResponse();
    expect(response.errorCode).toBe('stream_inactive');
    expect(response.error?.toLowerCase()).toContain('camera');
    expect(response.base64).toBeUndefined();
  });

  it('replies with base64 and mimeType and no error for a live stream', async () => {
    vi.mocked(captureFrameModule.captureStreamFrame).mockResolvedValueOnce({
      mimeType: 'image/jpeg',
      base64: 'abc123',
    });
    await startCameraWithStream('live');

    emit({
      type: 'vision:capture:request',
      channel: 'thread-1',
      payload: { threadId: 'thread-1', requestId: 'capture-3', source: 'camera' },
    });

    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'vision:capture:response' })
      )
    );
    const response = lastCaptureResponse();
    expect(response).toEqual({
      threadId: 'thread-1',
      requestId: 'capture-3',
      source: 'camera',
      mimeType: 'image/jpeg',
      base64: 'abc123',
    });
    expect(response.error).toBeUndefined();
    expect(response.errorCode).toBeUndefined();
  });
});
