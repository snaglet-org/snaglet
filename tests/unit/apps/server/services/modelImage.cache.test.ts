/**
 * toModelImage caching: a result that will always repeat (a copy, or an image
 * left out for good) is reused on the next call without touching sharp; a
 * decode that threw is not cached, so the next call tries again.
 */

import { describe, expect, it, jest } from '@jest/globals';

const mockSharp = { calls: 0, decodeFailures: 0 };
jest.mock('sharp', () => {
  const real = jest.requireActual<(input?: unknown, options?: unknown) => unknown>('sharp');
  return (input?: unknown, options?: { autoOrient?: boolean }) => {
    mockSharp.calls += 1;
    if (options?.autoOrient && mockSharp.decodeFailures > 0) {
      mockSharp.decodeFailures -= 1;
      throw new Error('out of memory');
    }
    return real(input, options);
  };
});
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import sharp from 'sharp';
import { toModelImage } from '@server/services/modelImage';

function solidJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .jpeg()
    .toBuffer();
}

describe('toModelImage cache', () => {
  it('tries a decode that failed again on the next call', async () => {
    const wide = await solidJpeg(9000, 600);
    const cacheKey = 'image-retry:2026-01-01T00:00:00.000Z';
    mockSharp.decodeFailures = 1;

    expect(await toModelImage(wide, 'image/jpeg', { cacheKey })).toBeNull();
    const retried = await toModelImage(wide, 'image/jpeg', { cacheKey });

    expect(retried?.mediaType).toBe('image/jpeg');
    expect(await sharp(Buffer.from(retried?.base64 ?? '', 'base64')).metadata()).toMatchObject({
      width: 2000,
      height: 133,
    });
  });

  it('reuses a downscaled copy without decoding again', async () => {
    const wide = await solidJpeg(9000, 600);
    const cacheKey = 'image-copy:2026-01-01T00:00:00.000Z';
    const first = await toModelImage(wide, 'image/jpeg', { cacheKey });
    mockSharp.calls = 0;

    expect(await toModelImage(wide, 'image/jpeg', { cacheKey })).toBe(first);
    expect(mockSharp.calls).toBe(0);
  });

  it('remembers an image left out for good without reading it again', async () => {
    const huge = await solidJpeg(10_500, 10_000);
    const cacheKey = 'image-huge:2026-01-01T00:00:00.000Z';
    expect(await toModelImage(huge, 'image/jpeg', { cacheKey })).toBeNull();
    mockSharp.calls = 0;

    expect(await toModelImage(huge, 'image/jpeg', { cacheKey })).toBeNull();
    expect(mockSharp.calls).toBe(0);
  });
});
