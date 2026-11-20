/**
 * Image Marker Resolution
 *
 * User messages can embed images via `<image id="UUID"/>` markers in their
 * `content` string. This module parses those markers and expands them into
 * provider-ready content blocks (base64-inlined for Anthropic).
 *
 * Anthropic's servers can't fetch localhost URLs, so base64 inlining is the
 * only path that works in dev. Images live on the tail block, so prompt-cache
 * prefixes still hit normally.
 */

import { Images } from '@snaglet/db/tables/images';
import type { ProviderMessage, TextContentBlock, UserContentBlock } from './ProviderChatService';
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import { OMITTED_IMAGE_NOTE, toModelImage, type ModelImage } from './modelImage';

const IMAGE_MARKER_RE = /<image\s+id="([^"]+)"\s*\/>/g;

/**
 * Build `<image id="…"/>` markers for a list of image ids, joined by `sep`
 * (default a single space — the exact format the manual composer send appends).
 * Shared so the voice-dispatch path and the manual path emit identical markers.
 */
export function buildImageMarkers(ids: readonly string[], sep = ' '): string {
  return ids.map((id) => `<image id="${id}"/>`).join(sep);
}

interface Segment {
  kind: 'text' | 'image';
  value: string;
}

function parseSegments(content: string): { ids: string[]; segments: Segment[] } {
  const re = new RegExp(IMAGE_MARKER_RE.source, 'g');
  const segments: Segment[] = [];
  const ids: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', value: content.slice(lastIndex, match.index) });
    }
    segments.push({ kind: 'image', value: match[1]! });
    ids.push(match[1]!);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    segments.push({ kind: 'text', value: content.slice(lastIndex) });
  }
  return { ids, segments };
}

/**
 * Images loaded at once. Each may be a 50 MB original, so a long thread's
 * history is read a few at a time rather than all together.
 */
const IMAGE_LOAD_CONCURRENCY = 2;

/**
 * Resolve image markers in user messages by inlining image bytes as base64,
 * downscaled when an image is over the provider limits (see modelImage.ts).
 * Messages with no markers are returned untouched. Markers pointing to missing
 * images are dropped (with a warning) — the rest of the message is preserved.
 * An image too large to send becomes OMITTED_IMAGE_NOTE.
 */
export async function resolveImageMarkers(messages: ProviderMessage[]): Promise<ProviderMessage[]> {
  const allIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string') {
      const { ids } = parseSegments(m.content);
      for (const id of ids) allIds.add(id);
    }
  }
  if (allIds.size === 0) return messages;

  const imageMap = new Map<string, ModelImage | null>();
  await mapWithConcurrency([...allIds], IMAGE_LOAD_CONCURRENCY, async (id) => {
    try {
      const row = await Images.findImageById(id);
      if (!row) {
        logger.warn(`[imageMarkers] image not found: ${id}`);
        return;
      }
      const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data as Buffer);
      imageMap.set(
        id,
        await toModelImage(buf, row.mimeType, { cacheKey: `${row.id}:${row.updatedAt}` })
      );
    } catch (err) {
      logger.warn(`[imageMarkers] failed to load image ${id}: ${getErrorMessage(err)}`);
    }
  });

  return messages.map((m): ProviderMessage => {
    if (m.role !== 'user' || typeof m.content !== 'string') return m;
    const { segments } = parseSegments(m.content);
    if (segments.every((s) => s.kind === 'text')) return m;

    const blocks: UserContentBlock[] = [];
    for (const seg of segments) {
      if (seg.kind === 'text') {
        if (seg.value.length > 0) blocks.push({ type: 'text', text: seg.value });
      } else {
        const img = imageMap.get(seg.value);
        if (img === undefined) continue;
        if (img === null) {
          blocks.push({ type: 'text', text: OMITTED_IMAGE_NOTE });
          continue;
        }
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
        });
      }
    }

    // No image survived (missing or omitted) — fall back to plain text without markers.
    if (blocks.every((b) => b.type === 'text')) {
      const text = blocks.map((b) => (b as TextContentBlock).text).join('');
      return { role: 'user', content: text };
    }
    return { role: 'user', content: blocks };
  });
}
