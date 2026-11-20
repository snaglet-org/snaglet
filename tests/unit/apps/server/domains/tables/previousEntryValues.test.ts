/**
 * previousEntryValues reads an entry's values before a write so the hook event
 * can carry from/to. A failure the write itself reports (missing entry, missing
 * table) reads as "no previous values"; a programmer-class SQL error (undefined
 * column etc.) means the code is wrong for the schema and must surface.
 */
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';

const mockGetEntry = jest.fn();

jest.mock('@snaglet/db/tables/table_entries', () => ({
  TableEntries: { getEntry: (tableId: string, id: string) => mockGetEntry(tableId, id) },
}));
jest.mock('@server/services/HookService', () => ({ hooks: { emit: jest.fn() } }));
jest.mock('@server/realtime/surfaces/tables', () => ({}));

import { previousEntryValues } from '@server/domains/tables/tableEntries';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const ENTRY_ID = '00000000-0000-4000-8000-000000000001';

/** A pg-shaped error: the driver puts the SQLSTATE on `code`. */
function sqlError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  mockGetEntry.mockReset();
});

describe('previousEntryValues', () => {
  it("returns the entry's values", async () => {
    mockGetEntry.mockResolvedValue({ entry: { values: { 'field-1': 'Open' } } });
    await expect(previousEntryValues(TABLE_ID, ENTRY_ID)).resolves.toEqual({ 'field-1': 'Open' });
  });

  it('reads a missing entry as no previous values', async () => {
    mockGetEntry.mockRejectedValue(new AppError('Entry not found', ErrorCode.NOT_FOUND, 404));
    await expect(previousEntryValues(TABLE_ID, ENTRY_ID)).resolves.toBeUndefined();
  });

  it('reads a transient SQL failure as no previous values', async () => {
    mockGetEntry.mockRejectedValue(sqlError('57014', 'canceling statement due to timeout'));
    await expect(previousEntryValues(TABLE_ID, ENTRY_ID)).resolves.toBeUndefined();
  });

  it('rethrows a programmer error instead of swallowing it', async () => {
    const bug = sqlError('42703', 'column "missing_column" does not exist');
    mockGetEntry.mockRejectedValue(bug);
    await expect(previousEntryValues(TABLE_ID, ENTRY_ID)).rejects.toBe(bug);
  });
});
