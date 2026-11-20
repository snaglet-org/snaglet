/**
 * create_image payload sanitizer against the real `sharp` addon — no
 * database. Covers the accepted formats, the signature-over-claim rule, the
 * Base64 / size / dimension limits, and the metadata strip on re-encode.
 * Placement, persistence and rollback run against a real database in
 * tests/integration/apps/server/services/tools/createImage.test.ts.
 */

import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import {
  CREATE_IMAGE_MAX_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE_PX,
  sanitizeImagePayload,
} from '@server/services/ToolService/tools/media/create-image/imagePayload';

type Format = 'png' | 'jpeg' | 'webp';

function solid(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } });
}

async function encode(format: Format, width = 4, height = 3): Promise<Buffer> {
  return solid(width, height)[format]().toBuffer();
}

const b64 = (data: Buffer): string => data.toString('base64');

/** Rewrite a PNG's IHDR dimensions (header only — the pixel data stays tiny). */
function withPngDimensions(png: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(png);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt32BE(crc32(out.subarray(12, 29)), 29);
  return out;
}

describe('sanitizeImagePayload', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpeg'],
    ['image/webp', 'webp'],
  ] as const)(
    'accepts %s and returns the stored bytes, dimensions and hash',
    async (mime, format) => {
      const result = await sanitizeImagePayload(mime, b64(await encode(format)));

      expect(result).toMatchObject({ mimeType: mime, width: 4, height: 3 });
      expect(result.sha256).toBe(createHash('sha256').update(result.data).digest('hex'));
      const stored = await sharp(result.data).metadata();
      expect(stored).toMatchObject({ format, width: 4, height: 3 });
    }
  );

  it.each(['png', 'jpeg', 'webp'] as const)(
    'strips EXIF, ICC and embedded text from %s',
    async (format) => {
      const tagged = await solid(4, 3)
        [format]()
        .withExif({ IFD0: { Copyright: 'Test User', ImageDescription: 'private caption' } })
        .withIccProfile('p3')
        .toBuffer();
      const before = await sharp(tagged).metadata();
      expect(before.exif).toBeDefined();
      expect(before.icc).toBeDefined();

      const result = await sanitizeImagePayload(`image/${format}`, b64(tagged));
      const after = await sharp(result.data).metadata();
      expect(after.exif).toBeUndefined();
      expect(after.icc).toBeUndefined();
      expect(after.xmp).toBeUndefined();
      expect(result.data.includes('private caption')).toBe(false);
    }
  );

  it('applies EXIF orientation to the pixels before dropping the tag', async () => {
    const rotated = await solid(4, 2).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await sanitizeImagePayload('image/jpeg', b64(rotated));
    expect(result).toMatchObject({ width: 2, height: 4 });
    expect((await sharp(result.data).metadata()).orientation).toBeUndefined();
  });

  it('keeps a lossless WebP lossless', async () => {
    const lossless = await solid(4, 3).webp({ lossless: true }).toBuffer();
    const result = await sanitizeImagePayload('image/webp', b64(lossless));
    expect(result.data.toString('latin1', 12, 16)).toBe('VP8L');
  });

  it('drops bytes appended after the image data', async () => {
    const png = await encode('png');
    const polyglot = Buffer.concat([png, Buffer.from('<script>alert(1)</script>')]);
    const result = await sanitizeImagePayload('image/png', b64(polyglot));
    expect(result.data.includes('<script>')).toBe(false);
  });

  it('accepts line-wrapped Base64', async () => {
    const wrapped = b64(await encode('png')).replace(/(.{16})/g, '$1\n');
    await expect(sanitizeImagePayload('image/png', wrapped)).resolves.toMatchObject({
      mimeType: 'image/png',
    });
  });

  // ~7 MB of Base64 — past the ~4 MB at which an unoptimized whole-string
  // regexp overflows V8's backtrack stack (see imagePayload.ts). Run under
  // `node --no-regexp-optimization` to reproduce a long-lived process.
  it('validates a payload of exactly the decoded byte limit', async () => {
    const png = await encode('png');
    const atLimit = Buffer.concat([png, Buffer.alloc(CREATE_IMAGE_MAX_BYTES - png.length)]);
    await expect(sanitizeImagePayload('image/png', b64(atLimit))).resolves.toMatchObject({
      mimeType: 'image/png',
      width: 4,
      height: 3,
    });
  });

  describe('rejections', () => {
    it.each([
      ['image/png', 'jpeg', /mime_type` says image\/png but the decoded bytes are image\/jpeg/],
      ['image/jpeg', 'webp', /says image\/jpeg but the decoded bytes are image\/webp/],
      ['image/webp', 'png', /says image\/webp but the decoded bytes are image\/png/],
    ] as const)('rejects %s declared over %s bytes', async (mime, format, message) => {
      await expect(sanitizeImagePayload(mime, b64(await encode(format)))).rejects.toThrow(message);
    });

    it.each([
      ['not base64 at all!', /not valid Base64/],
      ['abc', /not valid Base64/],
      ['iVBORw0KGgo-_AAA', /not valid Base64/],
      ['A===', /not valid Base64/],
      ['', /is empty/],
      ['   ', /is empty/],
      ['data:image/png;base64,iVBORw0KGgo=', /without a "data:" URL prefix/],
    ])('rejects malformed Base64 %p', async (data, message) => {
      await expect(sanitizeImagePayload('image/png', data)).rejects.toThrow(message);
    });

    it('rejects a non-string payload', async () => {
      await expect(sanitizeImagePayload('image/png', 42)).rejects.toThrow(/Base64 string/);
    });

    it('rejects a payload over the decoded byte limit before decoding it', async () => {
      const oversized = Buffer.alloc(CREATE_IMAGE_MAX_BYTES + 1);
      (await encode('png')).copy(oversized);
      await expect(sanitizeImagePayload('image/png', b64(oversized))).rejects.toThrow(
        new RegExp(
          `${CREATE_IMAGE_MAX_BYTES + 1} bytes decoded — over the ${CREATE_IMAGE_MAX_BYTES}-byte`
        )
      );
    });

    it('rejects SVG whether it is declared or disguised', async () => {
      const svg = Buffer.from(
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">' +
          '<script>alert(1)</script></svg>'
      );
      await expect(sanitizeImagePayload('image/svg+xml', b64(svg))).rejects.toThrow(
        /SVG is not accepted/
      );
      await expect(sanitizeImagePayload('image/png', b64(svg))).rejects.toThrow(
        /SVG is not accepted/
      );
    });

    it('rejects other formats and unknown mime types', async () => {
      const gif = await solid(2, 2).gif().toBuffer();
      await expect(sanitizeImagePayload('image/png', b64(gif))).rejects.toThrow(
        /decoded bytes are image\/gif, which is not accepted/
      );
      await expect(sanitizeImagePayload('image/gif', b64(gif))).rejects.toThrow(
        /unsupported `mime_type` "image\/gif"/
      );
      await expect(sanitizeImagePayload(undefined, b64(gif))).rejects.toThrow(
        /`mime_type` is required/
      );
      await expect(
        sanitizeImagePayload('image/png', b64(Buffer.from('plain text, not an image')))
      ).rejects.toThrow(/unrecognized file signature/);
    });

    it('rejects an image wider or taller than the side limit', async () => {
      const wide = withPngDimensions(await encode('png', 1, 1), MAX_IMAGE_SIDE_PX + 1, 1);
      await expect(sanitizeImagePayload('image/png', b64(wide))).rejects.toThrow(
        new RegExp(`each side must be at most ${MAX_IMAGE_SIDE_PX} px`)
      );
    });

    it('rejects an image over the pixel budget', async () => {
      const side = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS)) + 1;
      const huge = withPngDimensions(await encode('png', 1, 1), side, side);
      await expect(sanitizeImagePayload('image/png', b64(huge))).rejects.toThrow(/pixel limit/);
    });

    it('rejects animated images', async () => {
      const frames = [await encode('png'), await solid(4, 3).negate().png().toBuffer()];
      const animated = await sharp(frames, { join: { animated: true } })
        .webp()
        .toBuffer();
      await expect(sanitizeImagePayload('image/webp', b64(animated))).rejects.toThrow(
        /animated images are not accepted/
      );
    });

    it('rejects a truncated image that still carries a valid signature', async () => {
      const truncated = (await encode('png')).subarray(0, 40);
      await expect(sanitizeImagePayload('image/png', b64(truncated))).rejects.toThrow(
        /could not be (read|decoded) as png/
      );
    });
  });
});
