import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_sheets_create',
  name: 'Google Sheets: Create Spreadsheet',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'sheets', 'spreadsheet', 'create', 'excel'],
  description:
    'Create a new Google Sheets spreadsheet in the connected Google Workspace. Provide a ' +
    'title and, optionally, sheetTitles to seed named tabs (defaults to a single Sheet1 if ' +
    'omitted). Returns the spreadsheetId, spreadsheetUrl, and the created tab titles. ' +
    'Requires the workspace Google integration to be connected with the spreadsheets scope.',
  parameters_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'The title for the new spreadsheet.',
      },
      sheetTitles: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional. Names for the tabs (sheets) to create within the spreadsheet. ' +
          'Omit to get a single default tab.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

export default definition;
