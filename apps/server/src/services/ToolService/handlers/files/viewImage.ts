import { Images, imageBlobPath, storageKeyFor } from '@snaglet/db/tables/images';
import { formatBytes } from '@snaglet/shared/utils';
import fileReadImage from './fileReadImage';
import type { ToolHandler, ToolHandlerRichResult } from '@server/services/ToolService/types';

// Media types the provider renders as an inline image content block. Mirrors
// sniffImageMime / file-read-image's MIME_BY_EXT: Anthropic's Messages API
// accepts only jpeg/png/gif/webp as inline images. SVG (image/svg+xml) is not
// an accepted image media type, so attaching it produces no visible image and
// the model would fall back to metadata-only.
const PROVIDER_INLINE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Cap on inlined text source (e.g. an SVG's XML) so one huge asset can't blow
// the model turn — generous enough to inspect typical icon/illustration SVGs.
const MAX_INLINE_SOURCE_CHARS = 20_000;

/**
 * True when a non-raster image's bytes are text the model can usefully read
 * inline (SVG markup, XML, plain text). Binary formats the provider can't
 * accept AND we can't sensibly inline as text fall through to the path hint.
 */
function isTextInlineableMime(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return (
    m === 'image/svg+xml' ||
    m.startsWith('text/') ||
    m.endsWith('+xml') ||
    m.endsWith('+json') ||
    m === 'application/xml' ||
    m === 'application/json'
  );
}

/**
 * file_read image mode — the one way to look at an image, whichever address it lives at.
 *
 * Two mutually exclusive branches, selected by which param is given:
 *   - `path`     — a local file on disk (delegates to file-read-image/tool.ts,
 *                  which also persists it to the workspace images table).
 *   - `id`       — an existing workspace image node (a prior upload, a
 *                  generated image, or an ad hoc tool capture like a
 *                  screenshot). Both live here so there is a single,
 *                  discoverable "view an image" verb instead of two parallel ones.
 *
 * For an image the provider accepts inline (png/jpeg/gif/webp) both branches
 * return a short text summary plus `rawContent: { inlineImageIds: [...] }`,
 * which toolDispatch.ts turns into a real image content block on this
 * tool_result (the model sees the pixels this same turn) and renders as the
 * standard "📸" chat message via postImageCaptureMessage.
 *
 * For a workspace image whose media type the provider cannot render inline
 * (notably SVG: image/svg+xml is not an Anthropic image media type), the `id`
 * branch does not attach an image block (that would silently degrade to
 * metadata-only). Instead it inlines the raw source text (SVG markup) so the
 * model can read it, or — for a non-text format — names the on-disk file to
 * read. Every fallback note carries the concrete blob path.
 */
const tool: ToolHandler = async (input, settings, context): Promise<ToolHandlerRichResult> => {
  const path = typeof input.path === 'string' ? input.path.trim() : '';
  // `image_id` is the handler's internal key; `param_aliases: { image_id: ['id'] }`
  // on definition.ts means an agent-facing `id` is already copied in here by
  // the ToolExecutor's normalization chokepoint before this handler runs.
  const imageId = typeof input.image_id === 'string' ? input.image_id.trim() : '';

  if (path && imageId) {
    throw new Error('file: provide exactly one of `path` or `id`, not both.');
  }
  if (!path && !imageId) {
    throw new Error(
      'file: provide exactly one of `path` (a local image file) or `id` ' +
        '(a workspace image id, e.g. `image-…`) to view.'
    );
  }

  if (path) {
    const result = await fileReadImage(input, settings, context);
    return typeof result === 'string' ? { output: result } : result;
  }

  return viewWorkspaceImage(imageId);
};

/** The former workspace_get_image implementation, reused verbatim. */
async function viewWorkspaceImage(imageId: string): Promise<ToolHandlerRichResult> {
  const row = await Images.findImageById(imageId);
  if (!row) {
    return { output: `file: no workspace image found with id \`${imageId}\`.` };
  }

  const lines: string[] = [];
  lines.push(`# ${row.name || 'Untitled image'}`);
  lines.push('');
  lines.push(`- id: \`${row.id}\``);
  lines.push(`- mime: ${row.mimeType}`);
  lines.push(`- size: ${formatBytes(row.sizeBytes)}`);
  if (row.containerId) lines.push(`- container: \`${row.containerId}\``);
  if (row.tags.length > 0) lines.push(`- tags: ${row.tags.map((t) => `\`${t}\``).join(', ')}`);
  lines.push(`- added: ${row.createdAt}`);
  if (row.description) {
    lines.push('');
    lines.push('## Description');
    lines.push(row.description);
  }

  // The concrete on-disk file for this image, named in every note below so an
  // agent whose provider can't render an inline image (or can't render THIS
  // format) has an actionable path to read instead of a dead-end
  // "provider-limitation" sentence.
  // The key comes from the row: a renamed image's file is named after it.
  const blobPath = imageBlobPath(row.storageKey ?? storageKeyFor(row.id, row.mimeType));

  // Raster formats the provider accepts inline (png/jpeg/gif/webp): attach the
  // bytes as a real image content block via the inlineImageIds protocol —
  // toolDispatch.ts turns it into an image block inside the tool_result so the
  // vision model sees the pixels this same turn. Behavior-preserving.
  if (PROVIDER_INLINE_IMAGE_MIME.has(row.mimeType.toLowerCase())) {
    lines.push('');
    lines.push(
      '_(Image bytes attached inline to this tool result. If your provider cannot ' +
        `display images in tool results, read the raw file at \`${blobPath}\`.)_`
    );
    return { output: lines.join('\n'), rawContent: { inlineImageIds: [row.id] } };
  }

  // SVG (and any other text-shaped format the provider can't accept as an inline
  // image): inline the raw source so the model can read and inspect the markup,
  // instead of silently degrading to metadata-only. Capped so a huge file can't
  // blow the turn.
  if (isTextInlineableMime(row.mimeType)) {
    const fullSource = row.data.toString('utf8');
    const truncated = fullSource.length > MAX_INLINE_SOURCE_CHARS;
    const source = truncated ? fullSource.slice(0, MAX_INLINE_SOURCE_CHARS) : fullSource;
    const fence = row.mimeType.toLowerCase().includes('svg') ? 'svg' : 'xml';
    lines.push('');
    lines.push(
      `_(${row.mimeType} is not a provider-supported inline image format, so the raw ` +
        `source is inlined below for inspection instead of image bytes. Full file on ` +
        `disk: \`${blobPath}\`.)_`
    );
    lines.push('');
    lines.push('## Source');
    lines.push('```' + fence);
    lines.push(source);
    if (truncated) {
      lines.push(
        `… [truncated — showing first ${MAX_INLINE_SOURCE_CHARS} of ${fullSource.length} ` +
          `chars; read the full file at ${blobPath}]`
      );
    }
    lines.push('```');
    return { output: lines.join('\n') };
  }

  // Any other non-inlineable binary format: can't attach as an image and can't
  // sensibly inline as text — name the on-disk file to read directly.
  lines.push('');
  lines.push(
    `_(${row.mimeType} cannot be inlined as an image for this provider; read the raw ` +
      `file at \`${blobPath}\`.)_`
  );
  return { output: lines.join('\n') };
}

export default tool;
