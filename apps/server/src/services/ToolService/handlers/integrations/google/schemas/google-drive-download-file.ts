import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_download_file',
  name: 'Google Drive: Download File',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'drive', 'download', 'file', 'content', 'export', 'read'],
  description:
    'Download the contents of a file from the connected Google Workspace Drive by file ID. ' +
    'Returns text files as UTF-8 and binary files (PDFs, images) as base64. Native Google ' +
    'formats (Docs, Sheets, Slides) are exported \u2014 Docs to text/plain, Sheets to CSV, ' +
    'Slides to PDF \u2014 unless an explicit exportMimeType is given. By default the file is ' +
    'written to disk in the user\u2019s ~/Downloads folder and the absolute saved path is ' +
    'returned. Provide savePath to write somewhere else, or set inMemory: true to skip the disk ' +
    'write and return the raw content (UTF-8 or base64) to the agent instead. Requires the ' +
    'workspace Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description:
          'The Drive file ID to download. Obtain it from google_drive operation "search_files".',
      },
      exportMimeType: {
        type: 'string',
        description:
          'Optional. For native Google formats (Docs/Sheets/Slides), the MIME type to export as. ' +
          'Examples: "text/plain", "text/csv", "application/pdf". ' +
          'Ignored for non-native files (they download in their stored format).',
      },
      savePath: {
        type: 'string',
        description:
          'Optional. If provided, the downloaded bytes are written to this path on disk instead ' +
          'of being returned to the agent. May be a full file path, or a directory (ending in a ' +
          'separator or an existing dir) in which case the Drive file name is used. A leading ' +
          '~ expands to the home directory. Parent directories are created as needed. The ' +
          'response then includes savedTo (the absolute path written) and writtenToDisk: true. ' +
          'If omitted, defaults to the ~/Downloads folder.',
      },
      inMemory: {
        type: 'boolean',
        description:
          'Optional. If true, skip writing to disk and return the file content to the agent ' +
          '(UTF-8 for text, base64 for binary). Overrides the default ~/Downloads write and any savePath.',
      },
    },
    required: ['fileId'],
    additionalProperties: false,
  },
};

export default definition;
