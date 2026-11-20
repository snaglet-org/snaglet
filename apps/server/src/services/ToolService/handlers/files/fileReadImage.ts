import { readFile, stat } from 'fs/promises';
import path from 'path';
import { formatBytes, generateId, imageSizeProblem } from '@snaglet/shared/utils';
import { Images } from '@snaglet/db/tables/images';
import type { ToolHandler, ToolHandlerRichResult } from '@server/services/ToolService/types';
import { validatePathConstraint } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { sniffImageMime } from '@server/services/ToolService/lib/sniffImageMime';
import { resolveAgentImageContainer } from '@server/services/ToolService/lib/resolveAgentImageContainer';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const tool: ToolHandler = async (input, settings, context): Promise<ToolHandlerRichResult> => {
  const rawPath = String(input.path ?? '');
  if (!rawPath) throw new Error('path is required');
  const cwd = resolveToolCwd(undefined, context);
  const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
  validatePathConstraint(filePath, settings);

  const ext = path.extname(filePath).toLowerCase();
  const extMime = MIME_BY_EXT[ext];
  if (!extMime) {
    const supported = Object.keys(MIME_BY_EXT).join(', ');
    throw new Error(
      `file: unsupported extension "${ext || '(none)'}" — supported: ${supported}. ` +
        'For text files use file(op:read) without mode:image.'
    );
  }

  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`file: not a regular file: ${filePath}`);
  const sizeProblem = imageSizeProblem(info.size, path.basename(filePath));
  if (sizeProblem) throw new Error(`file: ${sizeProblem} Resize or compress it first.`);

  const buf = await readFile(filePath);
  const sniffed = sniffImageMime(buf);
  if (!sniffed) {
    throw new Error(
      `file: ${path.basename(filePath)} does not contain png/jpeg/gif/webp data ` +
        '(magic-byte check failed) — the extension may be wrong.'
    );
  }
  // Trust the bytes over the filename when they disagree.
  const mimeType = sniffed;

  const imageId = generateId('image');
  const containerId = await resolveAgentImageContainer(context?.threadId);
  await Images.createImage({
    id: imageId,
    name: path.basename(filePath),
    containerId,
    mimeType,
    data: buf,
    sizeBytes: buf.byteLength,
    // Provenance marker: this image came from an agent tool capture
    // (not a user upload). Kept for filtering/badging; no auto-expiry.
    tags: ['tool-capture'],
  });

  const lines: string[] = [];
  lines.push(`# ${path.basename(filePath)}`);
  lines.push('');
  lines.push(`- path: \`${filePath}\``);
  lines.push(
    `- mime: ${mimeType}${mimeType !== extMime ? ' (extension said ' + extMime + ')' : ''}`
  );
  lines.push(`- size: ${formatBytes(buf.byteLength)}`);
  lines.push(`- saved to workspace as image id: \`${imageId}\``);
  lines.push('');
  lines.push(
    '_(Image bytes attached inline to this tool result. If you cannot see the image, your ' +
      'provider does not support image-in-tool-result; the image is still saved — reference it ' +
      `with <image id="${imageId}"/> or file({ op: "read", mode: "image", id: "${imageId}" }).)_`
  );

  return {
    output: lines.join('\n'),
    // Protocol shared with view_image's `id` branch: toolDispatch.ts loads
    // the listed images and appends them as image content blocks inside this
    // tool_result, so the vision model sees the pixels on the same turn.
    // The note keeps automation runs (which stringify rawContent) informative.
    rawContent: {
      inlineImageIds: [imageId],
      note: `image file ${filePath} saved as ${imageId}`,
    },
  };
};

export default tool;
