import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface AppendSheetArgs {
  spreadsheetId: string;
  range: string;
  values: string[][];
}

export default async function googleSheetsAppend(
  args: AppendSheetArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { spreadsheetId, range, values } = args;

  if (!spreadsheetId || typeof spreadsheetId !== 'string') {
    throw new Error('spreadsheetId is required');
  }
  if (!range || typeof range !== 'string') {
    throw new Error('range is required');
  }
  if (!Array.isArray(values) || values.length === 0 || values.some((row) => !Array.isArray(row))) {
    throw new Error('values must be a non-empty array of rows (string[][])');
  }

  const auth = await getGoogleClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const appended = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  const updates = (appended.data as sheets_v4.Schema$AppendValuesResponse).updates;

  return JSON.stringify({
    spreadsheetId: appended.data.spreadsheetId,
    updatedRange: updates?.updatedRange,
    updatedRows: updates?.updatedRows,
    updatedColumns: updates?.updatedColumns,
    updatedCells: updates?.updatedCells,
  });
}
