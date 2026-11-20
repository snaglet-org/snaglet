import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { canOpenChipInPane, selectionFromChip } from './selectionFromChip';
import { sidebarRevealTarget, workspaceNodeId } from './types';

const cache = vi.hoisted(() => ({
  get: vi.fn<(tableId: string) => TableCatalogEntry | null>(),
}));
vi.mock('@desktop/features/database/tableNameCache', () => ({ getCachedTableEntry: cache.get }));

const tableId = 'table-1111111111111-aaaaaaaaa';
const entryId = '00000000-0000-4000-8000-00000000abcd';
const chip = { kind: 'entry' as const, id: `${tableId}/${entryId}`, title: 'Planning note' };
beforeEach(() => {
  cache.get.mockReset();
  cache.get.mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe('entry chips open their owning table pane', () => {
  it('routes a custom-table entry directly to its table with a transient seek', async () => {
    expect(canOpenChipInPane(chip)).toBe(true);
    const selection = await selectionFromChip(chip);
    expect(selection).toEqual({
      kind: 'table',
      table_id: tableId,
      table: undefined,
      focusEntryId: entryId,
      focusRequestId: expect.any(Number),
    });
    expect(workspaceNodeId(selection)).toBeNull();
    expect(sidebarRevealTarget(selection)).toEqual({ view: 'library', id: tableId });
  });

  it('uses cached table identity for chrome, never the entry label', async () => {
    const table: TableCatalogEntry = {
      id: tableId,
      name: 'Work notes',
      origin: 'custom',
      projectId: null,
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    cache.get.mockReturnValue(table);
    const selection = await selectionFromChip(chip);
    expect(cache.get).toHaveBeenCalledWith(tableId);
    expect(selection).toMatchObject({ table, focusEntryId: entryId });
  });

  it('normalizes uppercase UUIDs without changing the owning table', async () => {
    const selection = await selectionFromChip({
      ...chip,
      id: `${tableId}/${entryId.toUpperCase()}`,
    });
    expect(selection).toMatchObject({ table_id: tableId, focusEntryId: entryId });
  });

  it('assigns a fresh request to repeated chip navigation even within one clock tick', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const first = await selectionFromChip(chip);
    const second = await selectionFromChip(chip);
    if (first?.kind !== 'table' || second?.kind !== 'table')
      throw new Error('Entry chips must resolve to tables');
    expect(first.focusRequestId).toEqual(expect.any(Number));
    expect(second.focusRequestId).not.toBe(first.focusRequestId);
  });

  it.each([
    `table-builtin-docs/${entryId}`,
    `${tableId}/not-an-entry-id`,
    `${tableId}/${entryId}/extra`,
    `entry:${tableId}/${entryId}`,
    tableId,
  ])('refuses invalid or built-in entry identity %s', async (id) => {
    expect(await selectionFromChip({ ...chip, id })).toBeNull();
    expect(cache.get).not.toHaveBeenCalled();
  });
});
