import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_sheets_append',
  name: 'Google Sheets: Append Rows',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'sheets', 'spreadsheet', 'append', 'rows', 'write'],
  description:
    'Append rows of data to an existing Google Sheets spreadsheet. Provide the spreadsheetId, ' +
    'a range (e.g. "Sheet1!A1") indicating the table to append after, and values as an array ' +
    'of rows (string[][]). Uses USER_ENTERED input so formulas and typed values are parsed. ' +
    'Returns the updatedRange, updatedRows, updatedColumns, and updatedCells. Requires the ' +
    'workspace Google integration connected with the spreadsheets scope.',
  parameters_schema: {
    type: 'object',
    properties: {
      spreadsheetId: {
        type: 'string',
        description: 'The ID of the spreadsheet to append to.',
      },
      range: {
        type: 'string',
        description:
          'The A1 range indicating the table to append after, e.g. "Sheet1!A1". ' +
          'The API finds the last row of the table in this range and appends below it.',
      },
      values: {
        type: 'array',
        items: {
          type: 'array',
          items: { type: 'string' },
        },
        description: 'Rows to append, as an array of arrays of cell values (string[][]).',
      },
    },
    required: ['spreadsheetId', 'range', 'values'],
    additionalProperties: false,
  },
};

export default definition;
