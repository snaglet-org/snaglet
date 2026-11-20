/**
 * extractToolImages — pulls image payloads out of a tool's execution result
 * and persists them to the images table so they can be:
 *   1. Rendered in the thread UI as agent messages (see
 *      `postImageCaptureMessage` below — the shared chat-render helper).
 *   2. Re-injected into the model's context on the next turn via the
 *      existing `<image id="UUID"/>` marker convention (see imageMarkers.ts).
 *
 * Recognized shapes (best-effort, non-throwing):
 *   - MCP standard:    { content: [{ type: 'image', data: <base64>, mimeType: 'image/png' }, ...] }
 *   - Snaglet tool result:  { content: [{ type: 'image', source: { data, media_type } }] }
 *   - Wrapped result:  { result: <any of the above> }
 *
 * The JSON-stringified tool result that goes back to the LLM has each base64
 * blob swapped for `[image saved: <uuid>]`, saving tokens and avoiding noise.
 *
 * Placement: every image is filed into the calling thread's project Images
 * folder (via `resolveAgentImageContainer`), like the builtin `screenshot` and
 * `image_generate` tools. A flat thread, or no thread context at all (e.g. a
 * headless run), files it in the root Images folder.
 */

import { generateId, getErrorMessage, isoNow } from '@snaglet/shared/utils';
import { Images } from '@snaglet/db/tables/images';
import { Messages } from '@snaglet/db/tables/messages';
import { logger } from '@server/config/logger';
import { wsService } from '@server/services/WebSocketService';
import { resolveAgentImageContainer } from '@server/services/ToolService/lib/resolveAgentImageContainer';
import { OMITTED_IMAGE_NOTE, toModelImage } from '@server/services/modelImage';
import type { UserContentBlock } from '@server/services/ProviderChatService';

interface ExtractedImage {
  id: string;
  mediaType: string;
  byteLength: number;
}

export interface ExtractToolImagesResult {
  images: ExtractedImage[];
  /**
   * Tool output with base64 blobs stripped, safe to send back to the model
   * or to write to the activity log — see the note on
   * `hadImageBlocks` below. Every `{type:'image', data|source.data}` node
   * anywhere in `execResult` is scrubbed via `buildCleanedOutput`'s
   * `JSON.stringify` replacer, which visits the full object tree regardless
   * of nesting depth — this is unconditional, not gated on `collectBlocks`
   * recognizing a top-level shape, so it never leaks raw base64.
   */
  cleanedOutput: string;
  /** True if anything was extracted and persisted as a workspace image. */
  hasImages: boolean;
  /**
   * True if at least one image-shaped block was detected in the raw result,
   * regardless of whether it was ultimately persisted (it may have been
   * dropped by the per-call cap, or `Images.createImage` may have thrown).
   * Callers must treat `cleanedOutput` (not the raw execResult) as
   * the loggable/model-facing text whenever this is true — `hasImages` alone
   * under-reports the cases that still need scrubbing.
   */
  hadImageBlocks: boolean;
}

const MAX_IMAGES_PER_TOOL_CALL = 3;

interface MaybeImageBlock {
  type?: string;
  data?: unknown;
  mimeType?: unknown;
  source?: { data?: unknown; media_type?: unknown; mediaType?: unknown } | null;
}

function coerceBase64(block: MaybeImageBlock): { data: string; mediaType: string } | null {
  if (!block || typeof block !== 'object') return null;
  if (block.type !== 'image') return null;

  // MCP shape
  if (typeof block.data === 'string' && block.data.length > 0) {
    const mt = typeof block.mimeType === 'string' ? block.mimeType : 'image/png';
    return { data: block.data, mediaType: mt };
  }
  // Anthropic-style nested shape
  const src = block.source;
  if (src && typeof src === 'object' && typeof src.data === 'string' && src.data.length > 0) {
    const mt =
      (typeof src.media_type === 'string' && src.media_type) ||
      (typeof src.mediaType === 'string' && src.mediaType) ||
      'image/png';
    return { data: src.data, mediaType: mt };
  }
  return null;
}

function collectBlocks(raw: unknown): MaybeImageBlock[] {
  if (!raw) return [];
  // Unwrap one level of `{ result: ... }` if present
  const root: unknown =
    raw && typeof raw === 'object' && 'result' in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).result
      : raw;

  if (root && typeof root === 'object') {
    const content = (root as Record<string, unknown>).content;
    if (Array.isArray(content)) return content as MaybeImageBlock[];
  }
  if (Array.isArray(root)) return root as MaybeImageBlock[];
  return [];
}

export async function extractToolImages(
  execResult: unknown,
  ctx: { threadId: string; agentId: string | null; runId: string; toolName: string }
): Promise<ExtractToolImagesResult> {
  const blocks = collectBlocks(execResult);
  const saved: ExtractedImage[] = [];
  let dropped = 0;
  let detected = 0;

  // Resolve Images once, only when the tool actually returns image bytes.
  let containerId: string | null = null;
  let containerResolved = false;

  for (const block of blocks) {
    const coerced = coerceBase64(block);
    if (!coerced) continue;
    detected += 1;
    if (saved.length >= MAX_IMAGES_PER_TOOL_CALL) {
      dropped += 1;
      continue;
    }
    try {
      if (!containerResolved) {
        containerId = await resolveAgentImageContainer(ctx.threadId);
        containerResolved = true;
      }
      const buf = Buffer.from(coerced.data, 'base64');
      const id = generateId('image');
      const ext = coerced.mediaType.split('/')[1] ?? 'png';
      const name = `tool-${ctx.toolName}-${ctx.runId.slice(0, 8)}-${id.slice(0, 8)}.${ext}`;
      await Images.createImage({
        id,
        name,
        // Shared initial placement; never affects later manual moves.
        containerId,
        mimeType: coerced.mediaType,
        data: buf,
        sizeBytes: buf.byteLength,
        // Provenance marker: this image came from an agent tool capture
        // (not a user upload). Kept for filtering/badging; no auto-expiry.
        tags: ['tool-capture'],
      });
      saved.push({ id, mediaType: coerced.mediaType, byteLength: buf.byteLength });
    } catch (err) {
      // Swallow — image extraction must never fail the tool call. The block
      // was detected (counted above) even though it wasn't persisted, so
      // `hadImageBlocks` still reports true and `cleanedOutput` still scrubs
      // its base64 below — a failed save must never leak raw bytes.
      logger.warn('[extractToolImages] failed to persist image:', getErrorMessage(err));
    }
  }

  // Build a sanitized copy of execResult with base64 stripped. Unconditional —
  // not gated on `blocks.length > 0` — because `buildCleanedOutput`'s
  // JSON.stringify replacer walks the full object tree regardless of nesting,
  // so an unrecognized top-level shape is still scrubbed, and a non-image
  // result passes through unchanged.
  const cleanedOutput = buildCleanedOutput(execResult, saved, dropped);

  return {
    images: saved,
    cleanedOutput,
    hasImages: saved.length > 0,
    hadImageBlocks: detected > 0,
  };
}

function buildCleanedOutput(execResult: unknown, saved: ExtractedImage[], dropped: number): string {
  // Walk and replace any `data` field on image blocks with a placeholder.
  let savedIdx = 0;
  const replacer = (_key: string, value: unknown): unknown => {
    if (value && typeof value === 'object' && (value as MaybeImageBlock).type === 'image') {
      const v = value as MaybeImageBlock & Record<string, unknown>;
      const placeholder =
        savedIdx < saved.length ? `[image saved: ${saved[savedIdx].id}]` : '[image dropped]';
      savedIdx += 1;
      const out: Record<string, unknown> = { ...v };
      if ('data' in out) out.data = placeholder;
      if (out.source && typeof out.source === 'object') {
        out.source = { ...(out.source as object), data: placeholder };
      }
      return out;
    }
    return value;
  };
  let str = safeStringify(execResult, replacer);
  if (dropped > 0) {
    str += `\n[note: ${dropped} additional image(s) dropped due to per-call cap of ${MAX_IMAGES_PER_TOOL_CALL}]`;
  }
  return str;
}

function safeStringify(
  value: unknown,
  replacer?: (key: string, value: unknown) => unknown
): string {
  try {
    return JSON.stringify(value, replacer as never, 2);
  } catch {
    return String(value);
  }
}

/**
 * Build provider-ready ImageContentBlocks for a list of image IDs by reading
 * bytes back from the images table, so screenshots can be injected into the
 * model's messages[] and seen on the next turn. An image over the provider
 * limits is downscaled for the model (see modelImage.ts); one too large to
 * send becomes an OMITTED_IMAGE_NOTE text block. Images load one at a time.
 */
export async function buildImageBlocksForIds(ids: string[]): Promise<UserContentBlock[]> {
  const blocks: UserContentBlock[] = [];
  for (const id of ids) {
    try {
      const row = await Images.findImageById(id);
      if (!row) continue;
      const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data as Uint8Array);
      const image = await toModelImage(buf, row.mimeType || 'image/png', {
        cacheKey: `${row.id}:${row.updatedAt}`,
      });
      if (!image) {
        blocks.push({ type: 'text', text: OMITTED_IMAGE_NOTE });
        continue;
      }
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
      });
    } catch (err) {
      logger.warn(`[extractToolImages] failed to load image ${id}: ${getErrorMessage(err)}`);
    }
  }
  return blocks;
}

export interface PostImageCaptureMessageParams {
  threadId: string;
  agentId: string;
  runId: string | null;
  toolName: string;
  imageIds: string[];
}

/**
 * Post the standard "📸 Captured N image(s) from <tool>" chat message
 * carrying an `<image id="…"/>` marker per id, and broadcast it to the
 * thread's socket channel.
 *
 * SHARED across both of toolDispatch.ts's image paths — the `inlineImageIds`
 * protocol (a tool attaches EXISTING workspace images to its result, e.g.
 * view_image's `path`/`id` branches, the rewritten screenshot tool) and the
 * auto-extract path (a tool returns raw MCP-shape image blocks that get
 * persisted here, e.g. an MCP screenshot tool). Before this
 * helper existed, only the auto-extract path posted a chat message, so
 * inlineImageIds tools rendered in the tree but not in chat — this makes
 * every image-bearing tool result render the same way. No-ops for an empty
 * id list so callers can invoke it unconditionally.
 */
export async function postImageCaptureMessage(
  params: PostImageCaptureMessageParams
): Promise<void> {
  const { threadId, agentId, runId, toolName, imageIds } = params;
  if (imageIds.length === 0) return;

  const imageMarkers = imageIds.map((id) => `<image id="${id}"/>`).join('\n');
  const body = `📸 Captured ${imageIds.length} image(s) from ${toolName}\n\n${imageMarkers}`;
  const imgMsgId = generateId('message');
  await Messages.create({
    id: imgMsgId,
    threadId,
    role: 'assistant',
    content: body,
    agentId,
    runId: runId ?? null,
  });
  wsService.broadcastToChannel(threadId, {
    type: 'thread:message',
    payload: {
      id: imgMsgId,
      threadId,
      agentId,
      role: 'assistant',
      content: body,
      createdAt: isoNow(),
    },
  });
}
