import type { VisionCaptureErrorCode, VisionSessionSource } from '@snaglet/shared/types';

type FrameSource = Exclude<VisionSessionSource, 'both'>;

/**
 * Server-side failure reasons for one on-demand vision frame. Browser codes
 * (`VisionCaptureErrorCode`) are carried through unchanged; the rest describe
 * bridge failures that the browser never sees.
 */
export type VisionCaptureFailure =
  | VisionCaptureErrorCode
  | 'access_off'
  | 'source_not_granted'
  | 'no_capture_client'
  | 'client_disconnected'
  | 'cancelled'
  | 'native_capture_unsupported';

/**
 * One error type for every way a frame can fail, so a tool result, a log
 * line, and a test can all tell a denied permission from a missing device.
 * The message is already actionable — callers should surface it verbatim.
 */
export class VisionCaptureError extends Error {
  readonly code: VisionCaptureFailure;
  readonly source: FrameSource | 'both' | null;

  constructor(code: VisionCaptureFailure, message: string, source: FrameSource | 'both' | null) {
    super(message);
    this.name = 'VisionCaptureError';
    this.code = code;
    this.source = source;
  }
}

const NOUN: Record<FrameSource, string> = { camera: 'camera', screen: 'screen' };

/** Human remediation for a failure code, worded for the source that failed. */
export function describeVisionCaptureFailure(
  code: VisionCaptureFailure,
  source: FrameSource,
  detail?: string
): string {
  const noun = NOUN[source];
  const reEnable = `Ask the user to enable ${noun} access again in the chat composer.`;
  switch (code) {
    case 'permission_denied':
      return (
        `The user's system denied Snaglet access to the ${noun}. ` +
        `Ask them to allow Snaglet in their operating system's ${noun} privacy settings, then enable ${noun} access again.`
      );
    case 'device_not_found':
      return source === 'camera'
        ? 'No camera was found on this computer. Ask the user to connect or enable a camera, then enable camera access again.'
        : `No screen could be selected. ${reEnable}`;
    case 'device_in_use':
      return source === 'camera'
        ? 'The camera is busy or could not be started, usually because another application is using it. Ask the user to close that application and enable camera access again.'
        : `The selected screen could not be read. ${reEnable}`;
    case 'stream_inactive':
      return `The ${noun} stream the user granted has ended. ${reEnable}`;
    case 'frame_timeout':
      return `The Snaglet window did not return a ${noun} frame in time. ${reEnable}`;
    case 'frame_encoding_failed':
      return `The Snaglet window could not encode the ${noun} frame. Try once more; if it repeats, ${reEnable.charAt(0).toLowerCase()}${reEnable.slice(1)}`;
    case 'unsupported':
      return `This Snaglet window cannot capture the ${noun} (media capture is unavailable in it). Ask the user to open the thread in the Snaglet desktop app or a current browser and enable ${noun} access there.`;
    case 'no_capture_client':
      return `No Snaglet window owns this ${noun} access session. ${reEnable}`;
    case 'client_disconnected':
      return `The Snaglet window that granted ${noun} access is no longer connected. ${reEnable}`;
    case 'cancelled':
      return `The ${noun} capture was canceled.`;
    case 'access_off':
      return 'Vision access is off for this thread. Ask the user to enable vision first.';
    case 'source_not_granted':
      return `Vision ${noun} access is not enabled for this thread.`;
    case 'native_capture_unsupported':
      return `Native ${noun} capture is not available on this platform; ${noun} frames come from the Snaglet window.`;
    case 'unknown':
    default:
      return `The Snaglet window could not capture the ${noun}${detail ? `: ${detail}` : '.'} ${reEnable}`;
  }
}

const BROWSER_CODES: ReadonlySet<string> = new Set<VisionCaptureErrorCode>([
  'permission_denied',
  'device_not_found',
  'device_in_use',
  'stream_inactive',
  'frame_timeout',
  'frame_encoding_failed',
  'unsupported',
  'unknown',
]);

export function isVisionCaptureErrorCode(value: unknown): value is VisionCaptureErrorCode {
  return typeof value === 'string' && BROWSER_CODES.has(value);
}
