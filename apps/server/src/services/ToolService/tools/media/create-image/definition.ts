import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import { formatBytes } from '@snaglet/shared/utils';
import {
  ACCEPTED_IMAGE_MIME_TYPES,
  CREATE_IMAGE_MAX_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE_PX,
} from './imagePayload';

const definition: BuiltinToolDefinition = {
  id: 'create_image',
  name: 'Create Image',
  description:
    'Save image data you already hold in memory (for example a screen capture handed to you as an image block) in the project’s Images container (or root Images container outside a project). Move it afterward if needed. Pass the raw Base64 of the file as `data_base64`, its `mime_type` (PNG, JPEG or WebP), a `title`, and optionally one scope reference: `parent_id` (a container id like "container-1234567890-abcd1234") or `parent_path` (e.g. `/Snaglet/screens`). ' +
    `The bytes are checked against their real file signature — a \`mime_type\` that does not match the data is an error — and SVG or any other format is rejected. Limits: ${formatBytes(CREATE_IMAGE_MAX_BYTES)} decoded, ${MAX_IMAGE_SIDE_PX} px per side, ${MAX_IMAGE_PIXELS / 1_000_000} megapixels. ` +
    'The image is re-encoded before it is stored, which strips all metadata (EXIF/GPS, XMP, ICC profiles, text chunks). Nothing is written unless every check passes. ' +
    'Returns `image_id`, a ready-to-paste `link`, `width`, `height`, `mime_type` and the `sha256` of the stored bytes. ' +
    'The image contents are sent to and stored by Snaglet: only pass captures that were intentionally taken for the workspace.',
  type: 'builtin',
  tier: 'standard',
  contextRequirement: 'none',
  destructive: false,
  keywords: ['image', 'screenshot', 'screen', 'capture', 'save', 'create', 'png', 'jpeg', 'webp'],
  parameters_schema: {
    type: 'object',
    required: ['title', 'mime_type', 'data_base64'],
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 120,
        description: 'Display name for the image node.',
      },
      parent_id: {
        type: 'string',
        description:
          'Id of a container selecting project scope. NOT a display name — an unknown id is an error. Optional; selects the enclosing project, not final placement. Do not pass both parent fields.',
      },
      parent_path: {
        type: 'string',
        description:
          'Slash-delimited path selecting project scope, e.g. `/Snaglet/screens` (case-insensitive; a bare name matches a root-level container). Optional; selects the enclosing project, not final placement. Do not pass both parent fields.',
      },
      mime_type: {
        type: 'string',
        enum: [...ACCEPTED_IMAGE_MIME_TYPES],
        description: 'Format of the data. Must match the file signature of the decoded bytes.',
      },
      data_base64: {
        type: 'string',
        description: `Raw standard Base64 of the image file — no "data:" URL prefix; whitespace is ignored. At most ${formatBytes(CREATE_IMAGE_MAX_BYTES)} once decoded.`,
      },
      caption: {
        type: 'string',
        description: 'Optional caption, stored as the image description.',
      },
      sort_order: {
        type: 'integer',
        minimum: 0,
        description:
          'Optional position among the container’s images; later siblings shift down. Defaults to the end.',
      },
    },
  },
  sort_order: 5,
};

export default definition;
