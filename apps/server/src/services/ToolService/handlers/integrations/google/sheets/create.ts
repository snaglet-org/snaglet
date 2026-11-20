import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface CreateSheetArgs {
  title: string;
  sheetTitles?: string[];
}

export default async function googleSheetsCreate(
  args: CreateSheetArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { title, sheetTitles } = args;

  if (!title || typeof title !== 'string') {
    throw new Error('title is required');
  }
  if (sheetTitles !== undefined) {
    if (!Array.isArray(sheetTitles) || sheetTitles.some((t) => typeof t !== 'string')) {
      throw new Error('sheetTitles must be an array of strings when provided');
    }
  }

  const auth = await getGoogleClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const requestBody: sheets_v4.Schema$Spreadsheet = {
    properties: { title },
  };
  if (sheetTitles && sheetTitles.length > 0) {
    requestBody.sheets = sheetTitles.map((t) => ({
      properties: { title: t },
    }));
  }

  const created = await sheets.spreadsheets.create({
    requestBody,
    fields: 'spreadsheetId,spreadsheetUrl,properties.title,sheets.properties.title',
  });

  const spreadsheet = created.data as sheets_v4.Schema$Spreadsheet;

  return JSON.stringify({
    spreadsheetId: spreadsheet.spreadsheetId,
    spreadsheetUrl: spreadsheet.spreadsheetUrl,
    title: spreadsheet.properties?.title,
    sheets: spreadsheet.sheets?.map((s) => s.properties?.title) ?? undefined,
  });
}
