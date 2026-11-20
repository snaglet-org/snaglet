import { google } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface ReadSheetArgs {
  spreadsheetId: string;
  range: string;
}

export default async function googleSheetsRead(
  args: ReadSheetArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { spreadsheetId, range } = args;

  if (!spreadsheetId || typeof spreadsheetId !== 'string') {
    throw new Error('spreadsheetId is required');
  }
  if (!range || typeof range !== 'string') {
    throw new Error('range is required');
  }

  const auth = await getGoogleClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    majorDimension: 'ROWS',
  });

  const values = (res.data.values ?? []) as string[][];

  return JSON.stringify({
    spreadsheetId,
    range: res.data.range ?? range,
    values,
    rowCount: values.length,
  });
}
