/**
 * `table` chips — the kind contract.
 *
 * A Database table is not a workspace node: its chip is keyed by the catalog
 * id and always takes the dedicated `table:<catalog id>` href, so it can
 * round-trip through markdown without ever entering a node-id grammar.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { PANE_ITEM_MIME } from '../paneDrag';
import {
  isChipKind,
  readChipDragData,
  setActiveDragChip,
  writeChipDragData,
  NODE_CHIP_MIME,
  type NodeChipData,
} from './payload';
import { fallbackTitleForKind, isIncludableKind, KIND_TO_SCHEME } from './kinds';
import { chipHrefForNode, nodeToChipMarkdown } from './markdown';

const CUSTOM_ID = 'table-1111111111111-aaaaaaaaa';
const BUILTIN_ID = 'table-builtin-docs';

const tableChip: NodeChipData = { id: CUSTOM_ID, kind: 'table', title: 'Reading list' };

function fakeDataTransfer(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return [...store.keys()];
    },
  } as unknown as DataTransfer;
}

describe('table chip kind', () => {
  beforeEach(() => setActiveDragChip(null));

  it('is a recognized chip kind with total per-kind entries', () => {
    expect(isChipKind('table')).toBe(true);
    expect(KIND_TO_SCHEME.table).toBe('table');
    expect(fallbackTitleForKind('table')).toBe('Table');
  });

  it('is never transcluded — a table has no content to splice', () => {
    expect(isIncludableKind('table')).toBe(false);
    expect(nodeToChipMarkdown(tableChip, { include: true })).toBe(
      `[Reading list](table:${CUSTOM_ID})`
    );
  });

  it('always takes the `table:` scheme, for custom and built-in ids alike', () => {
    expect(chipHrefForNode(tableChip)).toBe(`table:${CUSTOM_ID}`);
    expect(chipHrefForNode({ id: BUILTIN_ID, kind: 'table', title: 'Docs' })).toBe(
      `table:${BUILTIN_ID}`
    );
    expect(nodeToChipMarkdown(tableChip)).toBe(`[Reading list](table:${CUSTOM_ID})`);
  });

  it('round-trips through the canonical MIME without the in-memory store', () => {
    const dt = fakeDataTransfer();
    writeChipDragData(dt, tableChip);
    setActiveDragChip(null);
    expect(readChipDragData(dt)).toEqual(tableChip);
  });

  it('reads a Database row pane payload as a table chip titled by the table name', () => {
    const dt = fakeDataTransfer({
      [PANE_ITEM_MIME]: JSON.stringify({
        kind: 'table',
        table_id: BUILTIN_ID,
        table: { id: BUILTIN_ID, name: 'Docs', origin: 'builtin', createdAt: '' },
      }),
    });
    expect(readChipDragData(dt)).toEqual({
      id: BUILTIN_ID,
      kind: 'table',
      title: 'Docs',
      name: 'Docs',
    });
    expect(dt.getData(NODE_CHIP_MIME)).toBe('');
  });

  it('does not read a table draft pane payload as a chip', () => {
    const dt = fakeDataTransfer({
      [PANE_ITEM_MIME]: JSON.stringify({ kind: 'table-draft', draft_id: CUSTOM_ID }),
    });
    expect(readChipDragData(dt)).toBeNull();
  });
});
