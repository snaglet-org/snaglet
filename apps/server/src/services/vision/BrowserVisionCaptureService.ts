import { randomUUID } from 'node:crypto';
import type { VisionCaptureResponsePayload } from '@snaglet/shared/types';
import { wsService } from '@server/services/WebSocketService';
import {
  VisionCaptureError,
  describeVisionCaptureFailure,
  isVisionCaptureErrorCode,
} from './visionCaptureErrors';

const CAPTURE_TIMEOUT_MS = 15_000;

type FrameSource = 'screen' | 'camera';

interface PendingCapture {
  clientId: string;
  threadId: string;
  source: FrameSource;
  resolve: (data: Buffer) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
}

/**
 * The one bridge from the server to the Snaglet window that holds the user's
 * granted media streams. Screen AND camera frames come through here: the
 * window already owns both streams (getDisplayMedia / getUserMedia), which is
 * the only capture path that works identically on macOS and Windows and needs
 * no native helper. Every failure is a `VisionCaptureError` with a distinct
 * code so callers can tell a denied permission from a missing device.
 */
class BrowserVisionCaptureService {
  private readonly pending = new Map<string, PendingCapture>();

  request(
    clientId: string,
    threadId: string,
    source: FrameSource,
    signal?: AbortSignal
  ): Promise<Buffer> {
    const fail = (
      code: 'no_capture_client' | 'client_disconnected' | 'cancelled' | 'frame_timeout'
    ) => new VisionCaptureError(code, describeVisionCaptureFailure(code, source), source);
    if (!clientId) return Promise.reject(fail('no_capture_client'));
    if (signal?.aborted) return Promise.reject(fail('cancelled'));
    const requestId = randomUUID();
    return new Promise<Buffer>((resolve, reject) => {
      const finish = (error: Error) => {
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.removeAbort?.();
        reject(error);
      };
      const timer = setTimeout(() => finish(fail('frame_timeout')), CAPTURE_TIMEOUT_MS);
      const entry: PendingCapture = { clientId, threadId, source, resolve, reject, timer };
      if (signal) {
        const onAbort = () => finish(fail('cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
        entry.removeAbort = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(requestId, entry);
      if (
        !wsService.sendToClient(clientId, {
          type: 'vision:capture:request',
          channel: threadId,
          payload: { threadId, requestId, source },
        })
      ) {
        finish(fail('client_disconnected'));
      }
    });
  }

  respond(clientId: string, payload: VisionCaptureResponsePayload): void {
    const entry = this.pending.get(payload.requestId);
    if (
      !entry ||
      entry.clientId !== clientId ||
      entry.threadId !== payload.threadId ||
      entry.source !== payload.source
    ) {
      return;
    }
    this.pending.delete(payload.requestId);
    clearTimeout(entry.timer);
    entry.removeAbort?.();
    if (payload.error || payload.errorCode) {
      const code = isVisionCaptureErrorCode(payload.errorCode) ? payload.errorCode : 'unknown';
      entry.reject(
        new VisionCaptureError(
          code,
          describeVisionCaptureFailure(code, entry.source, payload.error),
          entry.source
        )
      );
    } else if (!payload.base64 || !payload.mimeType) {
      entry.reject(
        new VisionCaptureError(
          'frame_encoding_failed',
          describeVisionCaptureFailure('frame_encoding_failed', entry.source),
          entry.source
        )
      );
    } else {
      entry.resolve(Buffer.from(payload.base64, 'base64'));
    }
  }

  /** Test/diagnostic visibility only. */
  pendingCount(): number {
    return this.pending.size;
  }
}

export const browserVisionCaptureService = new BrowserVisionCaptureService();
export { BrowserVisionCaptureService };
