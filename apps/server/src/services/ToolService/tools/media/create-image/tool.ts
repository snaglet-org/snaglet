/**
 * create_image — store image bytes the caller already holds (e.g. a screen
 * capture) as a normal image node. There is deliberately no file-path mode:
 * the only input is the encoded data itself.
 *
 * Atomicity comes from ordering. Input, destination and payload are all
 * validated before anything is written, and `Images.createImage` then writes
 * the node row and the blob as one unit (see ImageModel), so a rejected call
 * leaves neither a node nor a file behind.
 *
 * Agent images are initially filed in the selected project's Images folder,
 * or the root Images folder when unscoped. Optional parent references select scope.
 */

import { resolveAgentImageContainer } from '@server/services/ToolService/lib/resolveAgentImageContainer';
import { Images } from '@snaglet/db/tables/images';
import { generateId } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import { emitTreeNodeCreated, snapshotFromImage } from '@server/realtime/surfaces/tree';
import { resolveParentContainerOrThrow } from '../../_shared/parentContainerResolution';
import { sanitizeImagePayload } from './imagePayload';

const TOOL = 'create_image';
const MAX_TITLE_LENGTH = 120;

interface CreateImageParams {
  title: string;
  parentId?: string;
  parentPath?: string;
  caption: string | null;
  sortOrder?: number;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${TOOL}: \`${field}\` must be a string when provided`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseInput(input: Record<string, unknown>): CreateImageParams {
  const title = optionalString(input.title, 'title');
  if (!title) throw new Error(`${TOOL}: \`title\` is required and must be a non-empty string`);
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error(`${TOOL}: \`title\` must be at most ${MAX_TITLE_LENGTH} characters`);
  }

  const parentId = optionalString(input.parent_id, 'parent_id');
  const parentPath = optionalString(input.parent_path, 'parent_path');
  if (parentId !== undefined && parentPath !== undefined) {
    throw new Error(
      `${TOOL}: pass exactly one destination — \`parent_id\` (a container id) or ` +
        `\`parent_path\` (e.g. "/Snaglet/screens")${parentId !== undefined ? ', not both' : ''}. ` +
        'Find the container with node (op tree).'
    );
  }

  const sortOrder = input.sort_order;
  if (
    sortOrder !== undefined &&
    sortOrder !== null &&
    (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder) || sortOrder < 0)
  ) {
    throw new Error(`${TOOL}: \`sort_order\` must be a non-negative integer when provided`);
  }

  return {
    title,
    parentId,
    parentPath,
    caption: optionalString(input.caption, 'caption') ?? null,
    sortOrder: typeof sortOrder === 'number' ? sortOrder : undefined,
  };
}

const handler: ToolHandler = async (input, _settings, context) => {
  const params = parseInput(input);
  const image = await sanitizeImagePayload(input.mime_type, input.data_base64);

  const source =
    params.parentId || params.parentPath
      ? await resolveParentContainerOrThrow(TOOL, {
          parentId: params.parentId,
          parentPath: params.parentPath,
        })
      : undefined;
  const containerId = await resolveAgentImageContainer(context?.threadId, source);

  const created = await Images.createImage({
    id: generateId('image'),
    containerId,
    name: params.title,
    description: params.caption,
    mimeType: image.mimeType,
    data: image.data,
    sizeBytes: image.data.length,
    sortOrder: params.sortOrder,
  });
  emitTreeNodeCreated(snapshotFromImage(created));

  const result = {
    success: true,
    image_id: created.id,
    link: linkForm('image', created.id, created.name),
    width: image.width,
    height: image.height,
    mime_type: image.mimeType,
    sha256: image.sha256,
    size_bytes: image.data.length,
    container_id: created.containerId,
  };
  return { output: JSON.stringify(result, null, 2), rawContent: result };
};

export default handler;
