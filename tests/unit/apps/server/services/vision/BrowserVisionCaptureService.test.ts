const sendToClientMock = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { sendToClient: (...args: unknown[]) => sendToClientMock(...args) },
}));

import { BrowserVisionCaptureService } from '@server/services/vision/BrowserVisionCaptureService';

type Sent = { type: string; channel: string; payload: { requestId: string; source: string } };

function lastRequestId(): string {
  const sent = sendToClientMock.mock.calls.at(-1)?.[1] as Sent | undefined;
  if (!sent) throw new Error('nothing was sent to the client');
  return sent.payload.requestId;
}

beforeEach(() => {
  jest.useFakeTimers();
  sendToClientMock.mockReset();
  sendToClientMock.mockReturnValue(true);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('BrowserVisionCaptureService', () => {
  it.each(['camera', 'screen'] as const)(
    'asks the owning Snaglet window for one %s frame and resolves its bytes',
    async (source) => {
      const service = new BrowserVisionCaptureService();
      const pending = service.request('client-1', 'thread-1', source);
      const requestId = lastRequestId();
      expect(sendToClientMock).toHaveBeenCalledWith('client-1', {
        type: 'vision:capture:request',
        channel: 'thread-1',
        payload: { threadId: 'thread-1', requestId, source },
      });

      service.respond('client-1', {
        threadId: 'thread-1',
        requestId,
        source,
        mimeType: 'image/jpeg',
        base64: Buffer.from('frame').toString('base64'),
      });

      expect((await pending).toString()).toBe('frame');
      expect(service.pendingCount()).toBe(0);
    }
  );

  it('rejects with no_capture_client when no Snaglet window owns the camera session', async () => {
    const service = new BrowserVisionCaptureService();
    await expect(service.request('', 'thread-1', 'camera')).rejects.toMatchObject({
      name: 'VisionCaptureError',
      code: 'no_capture_client',
      source: 'camera',
      message: expect.stringMatching(/camera/),
    });
    expect(sendToClientMock).not.toHaveBeenCalled();
  });

  it('rejects with client_disconnected when the owning window is gone', async () => {
    sendToClientMock.mockReturnValue(false);
    const service = new BrowserVisionCaptureService();
    await expect(service.request('client-1', 'thread-1', 'camera')).rejects.toMatchObject({
      code: 'client_disconnected',
      message: expect.stringMatching(/no longer connected/),
    });
    expect(service.pendingCount()).toBe(0);
  });

  it('rejects with frame_timeout when the window never answers', async () => {
    const service = new BrowserVisionCaptureService();
    const pending = service.request('client-1', 'thread-1', 'camera');
    const rejection = expect(pending).rejects.toMatchObject({ code: 'frame_timeout' });
    jest.advanceTimersByTime(15_000);
    await rejection;
    expect(service.pendingCount()).toBe(0);
  });

  it('rejects with canceled when the turn is aborted', async () => {
    const service = new BrowserVisionCaptureService();
    const controller = new AbortController();
    const pending = service.request('client-1', 'thread-1', 'camera', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(service.pendingCount()).toBe(0);
  });

  it.each([
    ['permission_denied', /denied Snaglet access to the camera/],
    ['device_not_found', /No camera was found/],
    ['device_in_use', /another application is using it/],
    ['stream_inactive', /camera stream .* has ended/],
    ['frame_encoding_failed', /could not encode the camera frame/],
    ['unsupported', /cannot capture the camera/],
  ] as const)('maps the browser code %s to its own remediation', async (code, expected) => {
    const service = new BrowserVisionCaptureService();
    const pending = service.request('client-1', 'thread-1', 'camera');
    service.respond('client-1', {
      threadId: 'thread-1',
      requestId: lastRequestId(),
      source: 'camera',
      error: 'browser detail',
      errorCode: code,
    });
    await expect(pending).rejects.toMatchObject({ code, source: 'camera' });
    await expect(pending).rejects.toThrow(expected);
  });

  it('treats an unknown browser code as unknown and keeps the browser detail', async () => {
    const service = new BrowserVisionCaptureService();
    const pending = service.request('client-1', 'thread-1', 'camera');
    service.respond('client-1', {
      threadId: 'thread-1',
      requestId: lastRequestId(),
      source: 'camera',
      error: 'something odd',
    });
    await expect(pending).rejects.toMatchObject({ code: 'unknown' });
    await expect(pending).rejects.toThrow(/something odd/);
  });

  it('rejects an empty success payload as frame_encoding_failed', async () => {
    const service = new BrowserVisionCaptureService();
    const pending = service.request('client-1', 'thread-1', 'screen');
    service.respond('client-1', {
      threadId: 'thread-1',
      requestId: lastRequestId(),
      source: 'screen',
    });
    await expect(pending).rejects.toMatchObject({
      code: 'frame_encoding_failed',
      source: 'screen',
    });
  });

  it('ignores answers from another client, thread, or source', async () => {
    const service = new BrowserVisionCaptureService();
    const pending = service.request('client-1', 'thread-1', 'camera');
    const requestId = lastRequestId();
    const frame = { mimeType: 'image/jpeg' as const, base64: 'AQID' };
    service.respond('client-2', { threadId: 'thread-1', requestId, source: 'camera', ...frame });
    service.respond('client-1', { threadId: 'thread-2', requestId, source: 'camera', ...frame });
    service.respond('client-1', { threadId: 'thread-1', requestId, source: 'screen', ...frame });
    expect(service.pendingCount()).toBe(1);
    service.respond('client-1', { threadId: 'thread-1', requestId, source: 'camera', ...frame });
    expect((await pending).toString('base64')).toBe('AQID');
  });
});
