/**
 * The copy of a stored image that goes into a model request. Vision providers
 * cap each image (Anthropic: 5 MB of Base64 and 8000 px per side; OpenAI and
 * Gemini allow more), so an image over either cap is downscaled and
 * re-encoded here. The stored original is never changed.
 *
 * An image over a cap that cannot be brought under it is left out (null), and
 * callers put OMITTED_IMAGE_NOTE in its place: sending it as stored would make
 * the provider refuse the request on every later turn of the thread.
 *
 * `sharp` is imported lazily so server boot never loads the native addon.
 */

import type { Metadata } from 'sharp';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { LruByBytes } from '@server/utils/lruByBytes';
import { createSlotLimiter } from '@server/utils/slotLimiter';

/** Anthropic's per-image cap applies to the Base64 string, 4/3 of the bytes. */
const MAX_MODEL_IMAGE_BYTES = ((5 * 1024 * 1024) / 4) * 3;
const MAX_MODEL_IMAGE_SIDE_PX = 8000;
/**
 * Most pixels decoded to make a model copy. Some formats decode whole (a
 * 16000 px square WebP took 1.5 GB), so larger images are left out instead.
 */
const MAX_DECODE_PIXELS = 100_000_000;
/**
 * Longest side of a downscaled copy. Anthropic's per-side limit drops to
 * 2000 px once a request carries more than 20 images, and providers shrink
 * larger images before the model sees them anyway.
 */
const DOWNSCALED_LONG_SIDE_PX = 2000;
/** A copy still over the byte cap is shrunk by this factor and encoded again. */
const SHRINK_STEP = 0.75;
const MAX_ENCODE_ATTEMPTS = 6;
/**
 * Downscales running at once, across every thread. One: two near-limit WebP
 * decodes together peak around 1.6 GB, and the cache absorbs repeats.
 */
const MAX_CONCURRENT_DOWNSCALES = 1;

/** Formats providers take as image blocks. Anything else is passed through as stored. */
const MODEL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Stands in for an image that could not be made small enough for the model. */
export const OMITTED_IMAGE_NOTE = '[image omitted: too large to send to the model]';

export interface ModelImage {
  mediaType: string;
  base64: string;
}

/**
 * A downscale result. `lasting` is false when it failed in a way that may not
 * repeat (a sharp error such as running out of memory), so it is not cached.
 */
interface Downscaled {
  image: ModelImage | null;
  lasting: boolean;
}

const withDownscaleSlot = createSlotLimiter(MAX_CONCURRENT_DOWNSCALES);

/**
 * Downscaled copies and left-out (null) results, so an image is not decoded
 * again on every turn.
 */
const preparedCache = new LruByBytes<ModelImage | null>({
  maxBytes: 32 * 1024 * 1024,
  maxEntries: 64,
  sizeOf: (entry) => (entry ? entry.base64.length : 0),
});

/**
 * `data` as a model-ready image: as stored when it fits the provider caps,
 * otherwise at most 2000 px on its long side, as JPEG (PNG when it has
 * transparent pixels), under the byte cap. Null when an image over a cap
 * cannot be read, is over MAX_DECODE_PIXELS, stays over the byte cap, or
 * fails to decode.
 *
 * Pass `cacheKey` (an image id plus its updatedAt) to reuse the result on
 * later turns instead of decoding the original again. A failed decode is not
 * cached, so the next call tries again.
 */
export async function toModelImage(
  data: Buffer,
  mimeType: string,
  options: { cacheKey?: string } = {}
): Promise<ModelImage | null> {
  const mediaType = mimeType.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mimeType;
  const asStored = (): ModelImage => ({ mediaType, base64: data.toString('base64') });
  if (!MODEL_IMAGE_TYPES.has(mediaType.toLowerCase())) return asStored();

  const key = options.cacheKey ? `${options.cacheKey}:${data.length}` : null;
  const cached = key ? preparedCache.get(key) : undefined;
  if (cached !== undefined) return cached;
  const leftOut = (reason: string): null => {
    logger.warn(`[modelImage] left out a ${data.length}-byte ${mediaType} image: ${reason}`);
    if (key) preparedCache.set(key, null);
    return null;
  };

  const header = await readHeader(data);
  if (!header) {
    return data.length <= MAX_MODEL_IMAGE_BYTES ? asStored() : leftOut('unreadable');
  }
  const { width, height } = header;
  if (
    data.length <= MAX_MODEL_IMAGE_BYTES &&
    width <= MAX_MODEL_IMAGE_SIDE_PX &&
    height <= MAX_MODEL_IMAGE_SIDE_PX
  ) {
    return asStored();
  }
  if (width * height > MAX_DECODE_PIXELS) {
    return leftOut(`${width}×${height} is over the decode pixel limit`);
  }

  const { image, lasting } = await withDownscaleSlot(() =>
    downscale(data, Math.min(DOWNSCALED_LONG_SIDE_PX, Math.max(width, height)))
  );
  if (key && lasting) preparedCache.set(key, image);
  return image;
}

/** The image's header, or null when sharp cannot read it. Decodes no pixels. */
async function readHeader(data: Buffer): Promise<Metadata | null> {
  try {
    const { default: sharp } = await import('sharp');
    return await sharp(data, { failOn: 'none', limitInputPixels: false }).metadata();
  } catch (err) {
    logger.warn(`[modelImage] could not read image header: ${getErrorMessage(err)}`);
    return null;
  }
}

async function downscale(data: Buffer, longSide: number): Promise<Downscaled> {
  try {
    const { default: sharp } = await import('sharp');
    // Decoded once to raw pixels at the target size; each encode attempt
    // starts from these. Orientation is applied because re-encoding drops
    // the EXIF tag, and failOn 'none' keeps what a truncated file still has.
    const { data: pixels, info } = await sharp(data, {
      failOn: 'none',
      limitInputPixels: MAX_DECODE_PIXELS,
      autoOrient: true,
    })
      .resize(fitBox(longSide))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const raw = { width: info.width, height: info.height, channels: info.channels };
    const hasAlpha = info.channels === 2 || info.channels === 4;
    const transparent = hasAlpha && !(await sharp(pixels, { raw }).stats()).isOpaque;

    let side = Math.max(info.width, info.height);
    for (let attempt = 0; attempt < MAX_ENCODE_ATTEMPTS; attempt += 1) {
      const pipeline = sharp(pixels, { raw }).resize(fitBox(side));
      const encoded = transparent
        ? await pipeline.png().toBuffer()
        : await pipeline.removeAlpha().jpeg({ quality: 85 }).toBuffer();
      if (encoded.length <= MAX_MODEL_IMAGE_BYTES) {
        const mediaType = transparent ? 'image/png' : 'image/jpeg';
        return { image: { mediaType, base64: encoded.toString('base64') }, lasting: true };
      }
      side = Math.floor(side * SHRINK_STEP);
    }
    logger.warn('[modelImage] left out an image still over the byte cap after downscaling');
    return { image: null, lasting: true };
  } catch (err) {
    logger.warn(
      `[modelImage] left out an image that could not be downscaled this time: ${getErrorMessage(err)}`
    );
    return { image: null, lasting: false };
  }
}

function fitBox(side: number) {
  return { width: side, height: side, fit: 'inside' as const, withoutEnlargement: true };
}
