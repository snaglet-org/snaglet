import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_upload_file',
  name: 'Drive Upload File',
  description:
    'Upload a new file to Google Drive, either from a local file path or from inline text content. ' +
    'Optionally place it in a parent folder. Returns the new file ID and metadata.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'drive', 'upload', 'file', 'create', 'media'],
  parameters_schema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Absolute path to a local file to upload. Provide this OR content.',
      },
      content: {
        type: 'string',
        description:
          'Inline UTF-8 text content to upload as the file body. Provide this OR filePath.',
      },
      name: {
        type: 'string',
        description:
          'Name the file should have in Drive. Required with content; defaults to the basename of filePath.',
      },
      mimeType: {
        type: 'string',
        description:
          'MIME type of the uploaded file. Defaults to text/plain for content, application/octet-stream for filePath.',
      },
      parentId: {
        type: 'string',
        description: 'Optional parent folder ID. Omitted uploads to Drive root.',
      },
    },
    required: [],
  },
};

export default definition;
