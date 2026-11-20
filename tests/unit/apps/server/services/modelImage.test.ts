/**
 * toModelImage: the copy of a stored image sent to a model fits the provider
 * limits (5 MB of Base64, 8000 px per side). Images that already fit go
 * through untouched; an image over a cap that cannot be brought under it is
 * left out, and the model gets a short note in its place.
 */

import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it, jest } from '@jest/globals';

const findImageById = jest.fn<(id: string) => Promise<unknown>>();
jest.mock('@snaglet/db/tables/images', () => ({
  Images: { findImageById: (id: string) => findImageById(id), createImage: jest.fn() },
}));
jest.mock('@snaglet/db/tables/messages', () => ({ Messages: { create: jest.fn() } }));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn() },
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { OMITTED_IMAGE_NOTE, toModelImage, type ModelImage } from '@server/services/modelImage';
import { buildImageBlocksForIds } from '@server/services/SocketService/handlers/chatPhases/extractToolImages';
import { resolveImageMarkers } from '@server/services/imageMarkers';

const BASE64_CAP = 5 * 1024 * 1024;
const BYTE_CAP = (BASE64_CAP / 4) * 3;

/** Random pixels, which PNG cannot compress: about width × height × channels bytes. */
function noisePng(width: number, height: number, channels: 3 | 4, opaque = false) {
  const pixels = randomBytes(width * height * channels);
  if (opaque && channels === 4) for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  return sharp(pixels, { raw: { width, height, channels } })
    .png({ compressionLevel: 1 })
    .toBuffer();
}

function solid(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#336699' } });
}

/** The prepared copy, failing the test when the image was left out. */
async function prepared(data: Buffer, mimeType: string, cacheKey?: string): Promise<ModelImage> {
  const image = await toModelImage(data, mimeType, cacheKey ? { cacheKey } : undefined);
  if (!image) throw new Error('expected a model copy, got null');
  return image;
}

async function decoded(image: ModelImage) {
  return sharp(Buffer.from(image.base64, 'base64')).metadata();
}

describe('toModelImage', () => {
  it('passes an image that fits through untouched', async () => {
    const png = await solid(40, 30).png().toBuffer();

    expect(await toModelImage(png, 'image/png')).toEqual({
      mediaType: 'image/png',
      base64: png.toString('base64'),
    });
  });

  it('sends an image stored as image/jpg as image/jpeg', async () => {
    const jpeg = await solid(40, 30).jpeg().toBuffer();

    expect(await toModelImage(jpeg, 'image/jpg')).toEqual({
      mediaType: 'image/jpeg',
      base64: jpeg.toString('base64'),
    });
  });

  it('re-encodes an image over the byte cap as JPEG under it, without enlarging it', async () => {
    const png = await noisePng(1400, 1400, 3);
    expect(png.length).toBeGreaterThan(BYTE_CAP);

    const image = await prepared(png, 'image/png');

    expect(image.mediaType).toBe('image/jpeg');
    expect(image.base64.length).toBeLessThanOrEqual(BASE64_CAP);
    expect(await decoded(image)).toMatchObject({ format: 'jpeg', width: 1400, height: 1400 });
  });

  it('sends an RGBA image with no transparent pixels as JPEG', async () => {
    const png = await noisePng(1400, 1000, 4, true);
    expect(png.length).toBeGreaterThan(BYTE_CAP);

    const image = await prepared(png, 'image/png');

    expect(image.mediaType).toBe('image/jpeg');
    expect(await decoded(image)).toMatchObject({ format: 'jpeg', channels: 3 });
  });

  it('keeps transparency, shrinking until the PNG is under the byte cap', async () => {
    const png = await noisePng(1600, 1200, 4);

    const image = await prepared(png, 'image/png');

    expect(image.mediaType).toBe('image/png');
    expect(image.base64.length).toBeLessThanOrEqual(BASE64_CAP);
    const meta = await decoded(image);
    expect(meta).toMatchObject({ format: 'png', hasAlpha: true });
    expect(meta.width).toBeLessThan(1600);
    expect(meta.width / meta.height).toBeCloseTo(1600 / 1200, 1);
  });

  it('downscales an image over 8000 px per side even when it is small in bytes', async () => {
    const png = await solid(9000, 600).png().toBuffer();

    expect(await decoded(await prepared(png, 'image/png'))).toMatchObject({
      width: 2000,
      height: 133,
    });
  });

  it('applies EXIF orientation to the downscaled copy', async () => {
    const sideways = await solid(9000, 100).jpeg().withMetadata({ orientation: 6 }).toBuffer();

    expect(await decoded(await prepared(sideways, 'image/jpeg'))).toMatchObject({
      width: 22,
      height: 2000,
    });
  });

  it('makes a copy from what a truncated JPEG still holds', async () => {
    const jpeg = await sharp(randomBytes(9000 * 300 * 3), {
      raw: { width: 9000, height: 300, channels: 3 },
    })
      .jpeg({ quality: 95 })
      .toBuffer();
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length / 2));

    const image = await prepared(truncated, 'image/jpeg');

    expect(await decoded(image)).toMatchObject({ format: 'jpeg', width: 2000, height: 67 });
  });

  it('leaves out an image over the decode pixel limit without decoding it', async () => {
    const huge = await solid(10_500, 10_000).jpeg().toBuffer();
    expect(huge.length).toBeLessThan(BYTE_CAP);

    expect(await toModelImage(huge, 'image/jpeg')).toBeNull();
  });

  it('leaves out bytes over the byte cap that cannot be read', async () => {
    expect(await toModelImage(Buffer.alloc(4 * 1024 * 1024, 1), 'image/png')).toBeNull();
  });

  it('passes small bytes it cannot read through as stored', async () => {
    const notAnImage = Buffer.alloc(1024, 1);

    expect(await toModelImage(notAnImage, 'image/png')).toEqual({
      mediaType: 'image/png',
      base64: notAnImage.toString('base64'),
    });
  });

  it('leaves formats providers do not take as images alone', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');

    expect(await toModelImage(svg, 'image/svg+xml')).toEqual({
      mediaType: 'image/svg+xml',
      base64: svg.toString('base64'),
    });
  });

  it('reuses the downscaled copy for the same cache key', async () => {
    const png = await solid(9000, 600).png().toBuffer();

    const key = 'image-cache:2026-01-01T00:00:00.000Z';

    const first = await prepared(png, 'image/png', key);
    const again = await prepared(png, 'image/png', key);
    const uncached = await prepared(png, 'image/png');

    expect(again).toBe(first);
    expect(uncached).not.toBe(first);
    expect(uncached).toEqual(first);
  });
});

describe('model-bound image blocks', () => {
  it('sends the fitted copy for an <image> marker and a tool-result image', async () => {
    const png = await noisePng(1400, 1400, 3);
    findImageById.mockResolvedValue({
      id: 'image-fitted',
      mimeType: 'image/png',
      data: png,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const [message] = await resolveImageMarkers([
      { role: 'user', content: 'Look: <image id="image-fitted"/>' },
    ]);
    const [block] = await buildImageBlocksForIds(['image-fitted']);

    expect(message?.content).toEqual([
      { type: 'text', text: 'Look: ' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: expect.any(String) },
      },
    ]);
    expect(block).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg' } });
  });

  it('puts a note in place of an image too large to send', async () => {
    findImageById.mockResolvedValue({
      id: 'image-omitted',
      mimeType: 'image/png',
      data: Buffer.alloc(4 * 1024 * 1024, 1),
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const [message] = await resolveImageMarkers([
      { role: 'user', content: 'Look: <image id="image-omitted"/>' },
    ]);
    const blocks = await buildImageBlocksForIds(['image-omitted']);

    expect(message).toEqual({ role: 'user', content: `Look: ${OMITTED_IMAGE_NOTE}` });
    expect(blocks).toEqual([{ type: 'text', text: OMITTED_IMAGE_NOTE }]);
  });
});
