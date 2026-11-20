import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_sheets_read',
  name: 'Google Sheets: Read Range',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'sheets', 'spreadsheet', 'read', 'range', 'values', 'get'],
  description:
    'Read the values from a range of an existing Google Sheets spreadsheet. Provide the ' +
    'spreadsheetId and an A1 range (e.g. "Sheet1!A1:B10"). Returns the values as an array of ' +
    'rows (string[][]) along with the resolved range and rowCount. An empty range returns an ' +
    'empty values array and rowCount 0. Requires the workspace Google integration connected ' +
    'with the spreadsheets scope.',
  parameters_schema: {
    type: 'object',
    properties: {
      spreadsheetId: {
        type: 'string',
        description: 'The ID of the spreadsheet to read from.',
      },
      range: {
        type: 'string',
        description: 'The A1 range to read, e.g. "Sheet1!A1:B10".',
      },
    },
    required: ['spreadsheetId', 'range'],
    additionalProperties: false,
  },
};

export default definition;
