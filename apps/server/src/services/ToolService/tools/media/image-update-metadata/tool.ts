import { asTrimmedString, imageNameProblem } from '@snaglet/shared/utils';
import { Images, type ImageListRow } from '@snaglet/db/tables/images';
import type { ToolHandler } from '@server/services/ToolService/types';
import { emitTreeNodeUpdated } from '@server/realtime/surfaces/tree';

/**
 * `image_update_metadata` — rename an image and/or set its description and tags
 * so it becomes embeddable and searchable.
 *
 * Key-present = intent: omitting a key leaves that field untouched; passing
 * `description: null` clears it. `name` renames the image and its stored file
 * through the same model path as a rename in the sidebar. `tags` sets the whole
 * set (trimmed, de-duplicated, blanks dropped). At least one field is required.
 */
const tool: ToolHandler = async (input, _settings, _context) => {
  const imageId = asTrimmedString(input.image_id);
  if (!imageId) throw new Error('image_id is required');

  let name: string | undefined;
  if ('name' in input) {
    if (typeof input.name !== 'string') throw new Error('name must be a string');
    const problem = imageNameProblem(input.name);
    if (problem) throw new Error(problem);
    name = input.name.trim();
  }

  const patch: { description?: string | null; tags?: string[] } = {};

  if ('description' in input) {
    if (input.description === null) {
      patch.description = null;
    } else {
      const desc = asTrimmedString(input.description);
      patch.description = desc && desc.length > 0 ? desc : null;
    }
  }

  if ('tags' in input) {
    if (!Array.isArray(input.tags)) throw new Error('tags must be an array of strings');
    const tags = input.tags
      .map((t) => asTrimmedString(t))
      .filter((t): t is string => !!t && t.length > 0);
    patch.tags = Array.from(new Set(tags));
  }

  const hasMetadata = patch.description !== undefined || patch.tags !== undefined;
  if (name === undefined && !hasMetadata) {
    throw new Error('Provide name, description and/or tags to update');
  }

  let updated: ImageListRow | null = null;
  let renamed = false;
  if (name !== undefined) {
    const outcome = await Images.rename(imageId, name);
    if (outcome.status === 'missing') throw new Error(`Image not found: ${imageId}`);
    if (outcome.status === 'conflict') {
      throw new Error(
        `Image ${imageId} changed while renaming; it is now "${outcome.currentName}"`
      );
    }
    renamed = outcome.status === 'renamed';
    updated = outcome.image;
  }
  if (hasMetadata) {
    updated = await Images.updateMetadata(imageId, patch);
    if (!updated) throw new Error(`Image not found: ${imageId}`);
  }
  if (!updated) throw new Error(`Image not found: ${imageId}`);

  emitTreeNodeUpdated({
    id: updated.id,
    kind: 'image',
    ...(renamed ? { title: updated.name } : {}),
    ...(hasMetadata ? { description: updated.description, tags: updated.tags } : {}),
    updatedAt: updated.updatedAt,
  });

  const hasEmbeddingMetadata =
    Boolean(updated.description?.trim()) || updated.tags.some((tag) => tag.trim().length > 0);

  return [
    `Image updated: ${updated.name || '(untitled)'} [${updated.id}]`,
    ...(renamed ? ['Renamed: the stored image file now carries the new name.'] : []),
    `Description: ${updated.description ?? '(none)'}`,
    `Tags: ${updated.tags.length ? updated.tags.join(', ') : '(none)'}`,
    'Keyword metadata is searchable immediately.',
    hasEmbeddingMetadata
      ? 'When metadata changes, stale stored vectors are removed. A replacement requires enabled automatic indexing or explicit embedding maintenance.'
      : 'Stored vectors were removed because no description or tags remain.',
  ].join('\n');
};

export default tool;
