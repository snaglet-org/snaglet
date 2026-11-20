import { describe, expect, it } from 'vitest';
import type { VisionCaptureErrorCode } from '@snaglet/shared/types';
import {
  captureStreamFrame,
  classifyMediaError,
  VisionCaptureClientError,
  type VisionCaptureSource,
} from './captureFrame';

function domException(name: string, message = 'boom'): DOMException {
  return new DOMException(message, name);
}

const SOURCES: ReadonlyArray<VisionCaptureSource> = ['screen', 'camera'];

describe('classifyMediaError', () => {
  const cases: ReadonlyArray<{ name: string; code: VisionCaptureErrorCode }> = [
    { name: 'NotAllowedError', code: 'permission_denied' },
    { name: 'SecurityError', code: 'permission_denied' },
    { name: 'PermissionDeniedError', code: 'permission_denied' },
    { name: 'NotFoundError', code: 'device_not_found' },
    { name: 'OverconstrainedError', code: 'device_not_found' },
    { name: 'DevicesNotFoundError', code: 'device_not_found' },
    { name: 'NotReadableError', code: 'device_in_use' },
    { name: 'TrackStartError', code: 'device_in_use' },
    { name: 'AbortError', code: 'device_in_use' },
    { name: 'TimeoutError', code: 'frame_timeout' },
  ];

  for (const { name, code } of cases) {
    for (const source of SOURCES) {
      it(`maps DOMException ${name} to ${code} for ${source} and names the source`, () => {
        const result = classifyMediaError(domException(name), source);
        expect(result.code).toBe(code);
        expect(result.message.toLowerCase()).toContain(source);
        expect(result.message.length).toBeGreaterThan(0);
      });
    }
  }

  for (const source of SOURCES) {
    it(`maps a TypeError to unsupported for ${source}`, () => {
      const result = classifyMediaError(new TypeError('mediaDevices is undefined'), source);
      expect(result.code).toBe('unsupported');
      expect(result.message.toLowerCase()).toContain(source);
    });

    it(`falls back to unknown for an unrecognized error on ${source}`, () => {
      const result = classifyMediaError(new Error('something odd happened'), source);
      expect(result.code).toBe('unknown');
      expect(result.message.toLowerCase()).toContain(source);
    });

    it(`falls back to unknown for a non-Error thrown value on ${source}`, () => {
      const result = classifyMediaError('nope', source);
      expect(result.code).toBe('unknown');
      expect(result.message.toLowerCase()).toContain(source);
    });

    it(`passes a VisionCaptureClientError's code and message through untouched for ${source}`, () => {
      const error = new VisionCaptureClientError(
        'frame_encoding_failed',
        'Custom encoding message.'
      );
      const result = classifyMediaError(error, source);
      expect(result).toEqual({
        code: 'frame_encoding_failed',
        message: 'Custom encoding message.',
      });
    });
  }

  it('gives permission_denied messages that match the documented wording shape for camera', () => {
    const result = classifyMediaError(domException('NotAllowedError'), 'camera');
    expect(result).toEqual({
      code: 'permission_denied',
      message:
        'Camera access was denied. Allow Snaglet to use the camera in your system privacy settings ' +
        'and enable vision again.',
    });
  });

  it('gives permission_denied messages that name the screen source', () => {
    const result = classifyMediaError(domException('NotAllowedError'), 'screen');
    expect(result).toEqual({
      code: 'permission_denied',
      message:
        'Screen access was denied. Allow Snaglet to use the screen in your system privacy settings ' +
        'and enable vision again.',
    });
  });
});

describe('captureStreamFrame', () => {
  function fakeStream(track: Partial<MediaStreamTrack> | null): MediaStream {
    return {
      getVideoTracks: () => (track ? [track as MediaStreamTrack] : []),
    } as unknown as MediaStream;
  }

  for (const source of SOURCES) {
    it(`throws a stream_inactive VisionCaptureClientError when ${source} has no video track`, async () => {
      await expect(captureStreamFrame(fakeStream(null), source)).rejects.toMatchObject({
        code: 'stream_inactive',
      });
    });

    it(`throws a stream_inactive VisionCaptureClientError when the ${source} track is not live`, async () => {
      const track = { readyState: 'ended' } as Partial<MediaStreamTrack>;
      const error = await captureStreamFrame(fakeStream(track), source).catch((cause) => cause);
      expect(error).toBeInstanceOf(VisionCaptureClientError);
      expect((error as VisionCaptureClientError).code).toBe('stream_inactive');
      expect((error as Error).message.toLowerCase()).toContain(source);
    });
  }
});
