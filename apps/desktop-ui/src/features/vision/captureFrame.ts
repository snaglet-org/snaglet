import type { VisionCaptureErrorCode, VisionSessionSource } from '@snaglet/shared/types';
import { capitalize } from '@snaglet/shared/utils';

/** A capture always targets one concrete stream, never the combined `'both'` selector. */
export type VisionCaptureSource = Exclude<VisionSessionSource, 'both'>;

/**
 * A capture failure whose `code` is already known (e.g. an inactive track, an
 * encoding failure) rather than something `classifyMediaError` has to infer
 * from a raw `DOMException`. `classifyMediaError` passes these straight
 * through so the code and message it reports always agree.
 */
export class VisionCaptureClientError extends Error {
  code: VisionCaptureErrorCode;

  constructor(code: VisionCaptureErrorCode, message: string) {
    super(message);
    this.name = 'VisionCaptureClientError';
    this.code = code;
  }
}

function sourceLabel(source: VisionCaptureSource): 'camera' | 'screen' {
  return source === 'camera' ? 'camera' : 'screen';
}

/** Captures a single frame from `stream` and returns it as a base64 JPEG. */
export async function captureStreamFrame(
  stream: MediaStream,
  source: VisionCaptureSource
): Promise<{
  mimeType: 'image/jpeg';
  base64: string;
}> {
  const label = sourceLabel(source);
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') {
    throw new VisionCaptureClientError(
      'stream_inactive',
      `The selected ${label} stream is no longer active.`
    );
  }
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () =>
            reject(
              new VisionCaptureClientError(
                'frame_timeout',
                `Timed out waiting for the selected ${label} frame.`
              )
            ),
          5_000
        );
        video.addEventListener(
          'loadeddata',
          () => {
            window.clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      });
    }
    if (video.videoWidth < 1 || video.videoHeight < 1) {
      throw new VisionCaptureClientError(
        'frame_encoding_failed',
        `The selected ${label} returned an empty frame.`
      );
    }
    const scale = Math.min(1, 1_280 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      throw new VisionCaptureClientError(
        'frame_encoding_failed',
        `${capitalize(label)} capture canvas is unavailable.`
      );
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(
                new VisionCaptureClientError(
                  'frame_encoding_failed',
                  `${capitalize(label)} frame encoding failed.`
                )
              ),
        'image/jpeg',
        0.9
      )
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { mimeType: 'image/jpeg', base64: btoa(binary) };
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

const ERROR_MESSAGES: Record<VisionCaptureErrorCode, (label: 'camera' | 'screen') => string> = {
  permission_denied: (label) =>
    `${capitalize(label)} access was denied. Allow Snaglet to use the ${label} in your system ` +
    `privacy settings and enable vision again.`,
  device_not_found: (label) => `No ${label} was found. Connect a ${label} and enable vision again.`,
  device_in_use: (label) =>
    `The ${label} is already in use by another application. Close other apps using it and ` +
    `enable vision again.`,
  stream_inactive: (label) =>
    `The selected ${label} stream is no longer active. Enable vision again to select a new ${label}.`,
  frame_timeout: (label) =>
    `Timed out waiting for the selected ${label} frame. Enable vision again and try once more.`,
  frame_encoding_failed: (label) =>
    `Capturing the ${label} frame failed. Enable vision again and try once more.`,
  unsupported: (label) => `${capitalize(label)} capture isn't supported in this browser.`,
  unknown: (label) =>
    `${capitalize(label)} capture failed unexpectedly. Enable vision again and try once more.`,
};

function domExceptionName(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

function classifyErrorCode(error: unknown): VisionCaptureErrorCode {
  switch (domExceptionName(error)) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'permission_denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return 'device_not_found';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'device_in_use';
    case 'TimeoutError':
      return 'frame_timeout';
    default:
      break;
  }
  if (error instanceof TypeError) return 'unsupported';
  return 'unknown';
}

/**
 * Maps a capture/acquisition failure to a `VisionCaptureErrorCode` and a
 * short, source-aware message safe to show to a person. Errors that already
 * know their code (`VisionCaptureClientError`, thrown by
 * `captureStreamFrame`) pass straight through; anything else — typically a
 * `DOMException` from `getDisplayMedia`/`getUserMedia` — is classified by
 * its `name`.
 */
export function classifyMediaError(
  error: unknown,
  source: VisionCaptureSource
): { code: VisionCaptureErrorCode; message: string } {
  const label = sourceLabel(source);
  if (error instanceof VisionCaptureClientError) {
    return { code: error.code, message: error.message };
  }
  const code = classifyErrorCode(error);
  const message = ERROR_MESSAGES[code](label);
  if (code !== 'unknown') return { code, message };
  // Unknown failures keep the raw detail: it is the only clue anyone has.
  const detail = error instanceof Error ? error.message.trim() : '';
  return { code, message: detail ? `${message} (${detail})` : message };
}
