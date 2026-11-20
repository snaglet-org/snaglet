/**
 * Tree row drags carry the chip list of a multi-row selection, in visible
 * order, next to the single chip of the row under the pointer — so inputs
 * insert one chip per row while tree moves, the trash and pane drops keep
 * reading what they always did.
 */
import type { DragEvent as ReactDragEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import type { DocTreeNode, LibraryTreeChild, ThreadTreeNode } from '@desktop/utils/api';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import {
  NODE_CHIP_LIST_MIME,
  NODE_CHIP_MIME,
  readChipDragData,
  readChipDragList,
  setActiveDragChip,
  setActiveDragChipList,
} from '@desktop/utils/nodeChip/payload';
import {
  applyRowDragData,
  applyTableRowDragData,
  buildDragPayloads,
  payloadOf,
  payloadOfTable,
} from './treeRowDnd';

const timestamp = '2026-01-01T00:00:00.000Z';

const docA: DocTreeNode = {
  kind: 'doc',
  id: 'doc-1111111111111-aaaaaaaaa',
  containerId: null,
  title: 'Doc A',
  content: '',
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const docB: DocTreeNode = { ...docA, id: 'doc-2222222222222-bbbbbbbbb', title: 'Doc B' };
const threadC: ThreadTreeNode = {
  kind: 'thread',
  id: 'thread-3333333333333-ccccccccc',
  projectId: null,
  title: 'Thread C',
  sortOrder: 0,
  lastMessageAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const table: TableCatalogEntry = {
  id: 'table-4444444444444-ddddddddd',
  name: 'Table D',
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: timestamp,
};
const nodes: LibraryTreeChild[] = [docA, docB, threadC];
const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
const tableIndex = new Map([[table.id, table]]);
// Drawn order: thread C, table D, doc A, doc B.
const visibleOrderIndex = new Map([threadC.id, table.id, docA.id, docB.id].map((id, i) => [id, i]));

function dragEvent() {
  const store = new Map<string, string>();
  const dataTransfer = {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return [...store.keys()];
    },
    effectAllowed: 'none',
    setDragImage: () => {},
  };
  return {
    event: { dataTransfer } as unknown as ReactDragEvent<HTMLElement>,
    dataTransfer: dataTransfer as unknown as DataTransfer,
  };
}

afterEach(() => {
  setActiveDragChip(null);
  setActiveDragChipList(null);
  document.body.removeAttribute('data-dragging');
});

describe('tree row drags — multi-row chip list', () => {
  it('a selected-row drag carries every selected row as chips, in visible order', () => {
    // Selected in click order B, C, A; the drag starts on A.
    const selected = new Set([docB.id, threadC.id, docA.id]);
    const payloads = buildDragPayloads(
      payloadOf(docA),
      selected,
      nodeIndex,
      tableIndex,
      visibleOrderIndex
    );
    const { event, dataTransfer } = dragEvent();
    applyRowDragData(event, docA, payloads);

    expect(readChipDragList(dataTransfer)).toEqual({
      chips: [
        { id: threadC.id, kind: 'thread', title: 'Thread C' },
        { id: docA.id, kind: 'doc', title: 'Doc A' },
        { id: docB.id, kind: 'doc', title: 'Doc B' },
      ],
      unlinkable: 0,
    });
    // The MIME carries the same list for drops that miss the in-memory store.
    setActiveDragChipList(null);
    expect(readChipDragList(dataTransfer)?.chips.map((c) => c.id)).toEqual([
      threadC.id,
      docA.id,
      docB.id,
    ]);
    // Single-item consumers still read the row under the pointer.
    expect(readChipDragData(dataTransfer)).toEqual({ id: docA.id, kind: 'doc', title: 'Doc A' });
    expect(JSON.parse(dataTransfer.getData(PANE_ITEM_MIME))).toMatchObject({ doc_id: docA.id });
  });

  it('a single-row drag writes no list and reads back as its one chip', () => {
    const payloads = buildDragPayloads(
      payloadOf(docB),
      new Set([docA.id, threadC.id]),
      nodeIndex,
      tableIndex,
      visibleOrderIndex
    );
    const { event, dataTransfer } = dragEvent();
    applyRowDragData(event, docB, payloads);
    expect(dataTransfer.types).not.toContain(NODE_CHIP_LIST_MIME);
    expect(dataTransfer.types).toContain(NODE_CHIP_MIME);
    expect(readChipDragList(dataTransfer)).toEqual({
      chips: [{ id: docB.id, kind: 'doc', title: 'Doc B' }],
      unlinkable: 0,
    });
  });

  it('a table-row drag carries the linkable selection in visible order', () => {
    const selected = new Set([docA.id, threadC.id, table.id]);
    const fromTable = buildDragPayloads(
      payloadOfTable(table),
      selected,
      nodeIndex,
      tableIndex,
      visibleOrderIndex
    );
    const tableDrag = dragEvent();
    applyTableRowDragData(tableDrag.event, fromTable);
    expect(readChipDragList(tableDrag.dataTransfer)).toEqual({
      chips: [
        { id: threadC.id, kind: 'thread', title: 'Thread C' },
        { id: table.id, kind: 'table', title: 'Table D' },
        { id: docA.id, kind: 'doc', title: 'Doc A' },
      ],
      unlinkable: 0,
    });
  });
});
