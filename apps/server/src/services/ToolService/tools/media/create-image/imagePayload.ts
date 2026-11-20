/**
 * Decode, verify and sanitize an untrusted image payload for `create_image`.
 *
 * The caller's `mime_type` is only a claim: the decoded bytes must carry the
 * matching file signature, and sharp must then decode them as that same
 * format within the size and dimension limits below. The image is re-encoded
 * in its own format — the stored file is freshly written pixels, so EXIF/GPS,
 * XMP, ICC profiles, text chunks and anything appended after the image data
 * never survive. EXIF orientation is applied to the pixels before the tag is
 * dropped, so a rotated photo still displays upright.
 *
 * Everything here runs before any write; a rejected payload leaves nothing.
 * `sharp` is imported lazily so server boot never
 * loads the native addon.
 */

import { createHash } from 'crypto';
import { formatBytes, getErrorMessage } from '@snaglet/shared/utils';
import { sniffImageMime } from '@server/services/ToolService/lib/sniffImageMime';

const TOOL = 'create_image';

export const ACCEPTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
type AcceptedImageMimeType = (typeof ACCEPTED_IMAGE_MIME_TYPES)[number];

/**
 * Largest decoded image `create_image` takes. Lower than the upload limit
 * because the Base64 arrives inside an MCP or tool-call JSON body, which the
 * server caps at 8 MB.
 */
export const CREATE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Longest accepted side, in pixels (WebP itself tops out at 16383). */
export const MAX_IMAGE_SIDE_PX = 16_384;
/** Total pixel budget (width × height) — bounds decode memory for highly compressible inputs. */
export const MAX_IMAGE_PIXELS = 40_000_000;

const SHARP_FORMAT: Record<AcceptedImageMimeType, 'png' | 'jpeg' | 'webp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

/**
 * Payload patterns match one character at a time, never an anchored `[…]+`
 * run over the whole string: once a process has generated enough regexp code,
 * V8 compiles new patterns without its loop optimization, and an unoptimized
 * `+` keeps one backtrack entry per character — a multi-megabyte payload then
 * overflows the backtrack stack ("Maximum call stack size exceeded").
 */
const NON_BASE64_CHAR_RE = /[^A-Za-z0-9+/]/;
const WHITESPACE_RE = /\s/g;
const BYTE_LIMIT_LABEL = `${CREATE_IMAGE_MAX_BYTES}-byte (${formatBytes(CREATE_IMAGE_MAX_BYTES)})`;

interface SanitizedImage {
  data: Buffer;
  mimeType: AcceptedImageMimeType;
  width: number;
  height: number;
  /** Hex SHA-256 of the stored (sanitized) bytes. */
  sha256: string;
}

function isAcceptedMimeType(value: string): value is AcceptedImageMimeType {
  return (ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

function svgRejection(): Error {
  return new Error(
    `${TOOL}: SVG is not accepted — it is an active format that can carry scripts and ` +
      'external references. Rasterize it to PNG first.'
  );
}

function parseMimeType(value: unknown): AcceptedImageMimeType {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `${TOOL}: \`mime_type\` is required — one of ${ACCEPTED_IMAGE_MIME_TYPES.join(', ')}.`
    );
  }
  const mimeType = value.trim().toLowerCase();
  if (mimeType === 'image/svg+xml') throw svgRejection();
  if (!isAcceptedMimeType(mimeType)) {
    throw new Error(
      `${TOOL}: unsupported \`mime_type\` "${mimeType.slice(0, 80)}" — accepted: ` +
        `${ACCEPTED_IMAGE_MIME_TYPES.join(', ')}.`
    );
  }
  return mimeType;
}

function invalidBase64(): Error {
  return new Error(
    `${TOOL}: \`data_base64\` is not valid Base64 (standard alphabet A–Z a–z 0–9 + /, ` +
      'padded with = to a multiple of 4 characters).'
  );
}

/**
 * Strict standard-alphabet Base64 → bytes. The decoded size follows from the
 * length alone, so an oversized payload is refused before it is scanned or
 * allocated.
 */
function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string') {
    throw new Error(`${TOOL}: \`data_base64\` is required and must be a Base64 string.`);
  }
  const compact = value.replace(WHITESPACE_RE, '');
  if (/^data:/i.test(compact)) {
    throw new Error(
      `${TOOL}: \`data_base64\` must be the raw Base64 of the file, without a "data:" URL prefix.`
    );
  }
  if (compact.length === 0) {
    throw new Error(`${TOOL}: \`data_base64\` is empty.`);
  }
  if (compact.length % 4 !== 0) throw invalidBase64();
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const decodedBytes = (compact.length / 4) * 3 - padding;
  if (decodedBytes > CREATE_IMAGE_MAX_BYTES) {
    throw new Error(
      `${TOOL}: the image is ${decodedBytes} bytes decoded — over the ${BYTE_LIMIT_LABEL} ` +
        'limit. Send a smaller or more compressed capture.'
    );
  }
  // Padding may only close the string; any `=` left in the body is invalid.
  if (NON_BASE64_CHAR_RE.test(compact.slice(0, compact.length - padding))) {
    throw invalidBase64();
  }
  return Buffer.from(compact, 'base64');
}

/** Name the real format for a signature mismatch; SVG gets its own rejection. */
function assertSignature(data: Buffer, declared: AcceptedImageMimeType): void {
  const sniffed = sniffImageMime(data);
  if (sniffed === declared) return;
  if (sniffed === null) {
    const head = data.subarray(0, 4096).toString('utf8').replace(/^﻿/, '');
    if (/^\s*</.test(head) && /<svg[\s>]/i.test(head)) throw svgRejection();
    throw new Error(
      `${TOOL}: the decoded bytes are not a PNG, JPEG or WebP file (unrecognized file ` +
        'signature). Only raster captures in those formats are accepted.'
    );
  }
  if (!isAcceptedMimeType(sniffed)) {
    throw new Error(
      `${TOOL}: the decoded bytes are ${sniffed}, which is not accepted — send ` +
        `${ACCEPTED_IMAGE_MIME_TYPES.join(', ')}.`
    );
  }
  throw new Error(
    `${TOOL}: \`mime_type\` says ${declared} but the decoded bytes are ${sniffed}. ` +
      'Pass the mime_type that matches the data.'
  );
}

/** True when a WebP's image data is VP8L (lossless), so re-encoding keeps it lossless. */
function isLosslessWebp(data: Buffer): boolean {
  let offset = 12;
  while (offset + 8 <= data.length) {
    const chunk = data.toString('latin1', offset, offset + 4);
    if (chunk === 'VP8L') return true;
    if (chunk === 'VP8 ') return false;
    const size = data.readUInt32LE(offset + 4);
    offset += 8 + size + (size % 2);
  }
  return false;
}

export async function sanitizeImagePayload(
  mimeTypeInput: unknown,
  dataBase64Input: unknown
): Promise<SanitizedImage> {
  const mimeType = parseMimeType(mimeTypeInput);
  const input = decodeBase64(dataBase64Input);
  assertSignature(input, mimeType);

  const { default: sharp } = await import('sharp');
  const format = SHARP_FORMAT[mimeType];

  // Header-only read: the limits are checked before any pixel is decoded.
  let header: { format: string; width: number; height: number; pages?: number };
  try {
    header = await sharp(input).metadata();
  } catch (err) {
    throw new Error(`${TOOL}: the image could not be read as ${format}: ${getErrorMessage(err)}`);
  }
  if (header.format !== format) {
    throw new Error(
      `${TOOL}: the data decodes as ${header.format}, not ${format} — pass the matching mime_type.`
    );
  }
  if (header.width > MAX_IMAGE_SIDE_PX || header.height > MAX_IMAGE_SIDE_PX) {
    throw new Error(
      `${TOOL}: the image is ${header.width}×${header.height} px — each side must be at most ` +
        `${MAX_IMAGE_SIDE_PX} px.`
    );
  }
  if (header.width * header.height > MAX_IMAGE_PIXELS) {
    throw new Error(
      `${TOOL}: the image is ${header.width}×${header.height} px — over the ` +
        `${MAX_IMAGE_PIXELS.toLocaleString('en-US')}-pixel limit.`
    );
  }
  if ((header.pages ?? 1) > 1) {
    throw new Error(`${TOOL}: animated images are not accepted — send a single frame.`);
  }

  const pipeline = sharp(input, {
    failOn: 'warning',
    limitInputPixels: MAX_IMAGE_PIXELS,
    autoOrient: true,
  });
  if (format === 'png') pipeline.png();
  else if (format === 'jpeg') pipeline.jpeg({ quality: 90 });
  else pipeline.webp(isLosslessWebp(input) ? { lossless: true } : { quality: 90 });

  let output: { data: Buffer; info: { width: number; height: number } };
  try {
    output = await pipeline.toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new Error(
      `${TOOL}: the image could not be decoded as ${format}: ${getErrorMessage(err)}`
    );
  }
  if (output.data.length > CREATE_IMAGE_MAX_BYTES) {
    throw new Error(
      `${TOOL}: after stripping metadata the image re-encodes to ${output.data.length} bytes, ` +
        `over the ${BYTE_LIMIT_LABEL} limit. Send a smaller capture.`
    );
  }

  return {
    data: output.data,
    mimeType,
    width: output.info.width,
    height: output.info.height,
    sha256: createHash('sha256').update(output.data).digest('hex'),
  };
}
