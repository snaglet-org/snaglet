// Plain-language text for a microphone that would not start. getUserMedia
// rejects with DOMExceptions written for developers ("The request is not
// allowed by the user agent or the platform in the current context…"), so name
// the cause and the fix instead.

import { getErrorMessage } from '@snaglet/shared/utils';

/** Thrown by MicCapture when this page has no getUserMedia at all. */
export class MicUnsupportedError extends Error {
  constructor() {
    super('navigator.mediaDevices.getUserMedia is unavailable');
    this.name = 'MicUnsupportedError';
  }
}

function errorName(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'name' in err) {
    const { name } = err as { name?: unknown };
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

export function micErrorMessage(err: unknown): string {
  switch (errorName(err)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return (
        "Snaglet isn't allowed to use the microphone. Allow it (on a Mac: System Settings → " +
        'Privacy & Security → Microphone → Snaglet), then try again.'
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect one, then try again.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return "The microphone couldn't start. Another app may be using it — close that app, then try again.";
    case 'MicUnsupportedError':
      return "This window can't use the microphone. Use the Snaglet app, or open Snaglet on localhost or https.";
    default:
      return `The microphone couldn't start: ${getErrorMessage(err, 'unknown error')}`;
  }
}
