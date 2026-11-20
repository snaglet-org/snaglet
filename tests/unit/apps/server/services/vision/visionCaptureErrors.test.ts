import {
  VisionCaptureError,
  describeVisionCaptureFailure,
  isVisionCaptureErrorCode,
  type VisionCaptureFailure,
} from '@server/services/vision/visionCaptureErrors';

const CODES: VisionCaptureFailure[] = [
  'permission_denied',
  'device_not_found',
  'device_in_use',
  'stream_inactive',
  'frame_timeout',
  'frame_encoding_failed',
  'unsupported',
  'unknown',
  'access_off',
  'source_not_granted',
  'no_capture_client',
  'client_disconnected',
  'cancelled',
  'native_capture_unsupported',
];

describe('describeVisionCaptureFailure', () => {
  it('gives every camera failure a distinct, actionable message', () => {
    const messages = CODES.map((code) => describeVisionCaptureFailure(code, 'camera'));
    expect(new Set(messages).size).toBe(CODES.length);
    for (const [index, message] of messages.entries()) {
      if (CODES[index] === 'access_off') continue; // source-agnostic by design
      expect(message).toMatch(/camera/i);
    }
  });

  it('words the same failure for the screen without mentioning the camera', () => {
    for (const code of CODES) {
      if (code === 'access_off') continue;
      expect(describeVisionCaptureFailure(code, 'screen')).not.toMatch(/camera/i);
    }
  });

  it('keeps the browser detail only for unknown failures', () => {
    expect(describeVisionCaptureFailure('unknown', 'camera', 'weird')).toMatch(/weird/);
    expect(describeVisionCaptureFailure('permission_denied', 'camera', 'weird')).not.toMatch(
      /weird/
    );
  });
});

describe('VisionCaptureError', () => {
  it('carries the code and source and keeps a stable name', () => {
    const error = new VisionCaptureError('device_in_use', 'busy', 'camera');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'VisionCaptureError',
      code: 'device_in_use',
      source: 'camera',
    });
  });

  it('recognizes only browser-side codes', () => {
    expect(isVisionCaptureErrorCode('permission_denied')).toBe(true);
    expect(isVisionCaptureErrorCode('client_disconnected')).toBe(false);
    expect(isVisionCaptureErrorCode(42)).toBe(false);
  });
});
