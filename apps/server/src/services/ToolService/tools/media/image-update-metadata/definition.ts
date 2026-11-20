import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'image_update_metadata',
  name: 'Update Image Metadata',
  description:
    'Rename an image and/or set its description and tags for keyword retrieval and optional embedding. `name` renames the image and its stored file. View the image first with file(op:read, mode:image) to describe it accurately. `tags` REPLACES the existing set. Pass description=null to clear it. Changing any field removes stale stored vectors; a replacement is created only by an enabled automatic indexing pass or explicit embedding maintenance.',
  type: 'builtin',
  tier: 'standard',
  keywords: [
    'image',
    'rename',
    'name',
    'describe',
    'description',
    'caption',
    'tag',
    'tags',
    'metadata',
    'annotate',
    'alt',
    'index',
    'searchable',
  ],
  parameters_schema: {
    type: 'object',
    required: ['image_id'],
    properties: {
      image_id: {
        type: 'string',
        description: 'Id of the image node to update (e.g. "image-…").',
      },
      name: {
        type: 'string',
        description:
          'New display name (1-120 characters). Also renames the stored image file to match.',
      },
      description: {
        type: ['string', 'null'],
        description:
          'Natural-language description of what the image shows — used by keyword retrieval and embedding composition. Pass null to clear.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Keyword tags for the image. REPLACES the existing tag set, so read the image first if you want to preserve current tags.',
      },
    },
  },
};

export default definition;
