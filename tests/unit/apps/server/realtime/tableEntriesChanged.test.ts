/**
 * emitTableEntriesChanged sends one `table.entries.changed` per batch: every
 * entry in `entryIds` (the first also as `entryId`) up to 500, and
 * `allEntries: true` with no list past that.
 */
const mockEmit = jest.fn();
jest.mock('@server/realtime/emit', () => ({
  emitWorkspaceEvent: (event: unknown) => mockEmit(event),
}));
jest.mock('@server/realtime/surfaces/reminders', () => ({
  emitRemindersChangedForTable: jest.fn(),
}));

import { emitTableEntriesChanged } from '@server/realtime/surfaces/tables';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = (count: number) => Array.from({ length: count }, (_, index) => id(index + 1));

beforeEach(() => {
  mockEmit.mockReset();
});

describe('emitTableEntriesChanged', () => {
  it('names a single entry in both entryId and entryIds', () => {
    emitTableEntriesChanged(TABLE_ID, id(1));
    expect(mockEmit.mock.calls).toEqual([
      [{ type: 'table.entries.changed', tableId: TABLE_ID, entryId: id(1), entryIds: [id(1)] }],
    ]);
  });

  it('emits once for a batch, listing every entry once, the first as entryId', () => {
    emitTableEntriesChanged(TABLE_ID, [id(2), id(1), id(2), id(3)]);
    expect(mockEmit.mock.calls).toEqual([
      [
        {
          type: 'table.entries.changed',
          tableId: TABLE_ID,
          entryId: id(2),
          entryIds: [id(2), id(1), id(3)],
        },
      ],
    ]);
  });

  it('lists 500 entries, and says allEntries instead past 500', () => {
    emitTableEntriesChanged(TABLE_ID, ids(500));
    expect(mockEmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ entryId: id(1), entryIds: ids(500) })
    );
    emitTableEntriesChanged(TABLE_ID, ids(501));
    expect(mockEmit).toHaveBeenLastCalledWith({
      type: 'table.entries.changed',
      tableId: TABLE_ID,
      entryId: id(1),
      allEntries: true,
    });
    expect(mockEmit).toHaveBeenCalledTimes(2);
  });

  it('emits nothing for an empty batch', () => {
    emitTableEntriesChanged(TABLE_ID, []);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
