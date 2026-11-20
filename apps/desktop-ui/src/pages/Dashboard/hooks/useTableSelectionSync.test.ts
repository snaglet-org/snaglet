import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { emitTableEvent } from '@desktop/features/database';
import {
  createLeaf,
  findLeaf,
  replaceLeafSelection,
  splitLeaf,
  type LayoutNode,
} from '../layout/paneTree';
import {
  discardTableDraft,
  promoteTableDraft,
  renameTableSelections,
  useTableSelectionSync,
} from './useTableSelectionSync';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';

const table: TableCatalogEntry = {
  id: TABLE_ID,
  name: 'Reading list',
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function leafWithHistory(): LayoutNode {
  const root = createLeaf({ kind: 'doc', doc_id: 'doc-1111111111111-aaaaaaaaa' });
  return replaceLeafSelection(root, root.id, { kind: 'table-draft', draft_id: TABLE_ID });
}

describe('promoteTableDraft', () => {
  it('turns the draft into the saved table in place, without a new history entry', () => {
    const layout = leafWithHistory();
    const next = promoteTableDraft(layout, table);
    expect(next.kind).toBe('leaf');
    if (next.kind !== 'leaf') return;
    expect(next.selection).toEqual({ kind: 'table', table_id: TABLE_ID, table });
    expect(next.history.entries).toHaveLength(2);
    expect(next.history.entries[1]).toEqual({ kind: 'table', table_id: TABLE_ID, table });
    expect(next.history.index).toBe(1);
  });

  it('leaves unrelated panes untouched', () => {
    const layout = createLeaf({ kind: 'table-draft', draft_id: 'table-2222222222222-bbbbbbbbb' });
    expect(promoteTableDraft(layout, table)).toBe(layout);
  });
});

describe('renameTableSelections', () => {
  const renamed: TableCatalogEntry = { ...table, name: 'Reading notes' };
  const other: TableCatalogEntry = {
    ...table,
    id: 'table-2222222222222-bbbbbbbbb',
    name: 'Budget',
  };

  it('relabels the open pane and every history entry for that table', () => {
    const root = createLeaf({ kind: 'table', table_id: TABLE_ID, table });
    const withOther = replaceLeafSelection(root, root.id, {
      kind: 'table',
      table_id: other.id,
      table: other,
    });
    const layout = replaceLeafSelection(withOther, root.id, { kind: 'table', table_id: TABLE_ID });

    const next = renameTableSelections(layout, renamed);
    expect(next.kind).toBe('leaf');
    if (next.kind !== 'leaf') return;
    expect(next.selection).toEqual({ kind: 'table', table_id: TABLE_ID, table: renamed });
    expect(next.history.entries).toEqual([
      { kind: 'table', table_id: TABLE_ID, table: renamed },
      { kind: 'table', table_id: other.id, table: other },
      { kind: 'table', table_id: TABLE_ID, table: renamed },
    ]);
  });

  it('returns the same layout when nothing shows the table or the name already matches', () => {
    const unrelated = createLeaf({ kind: 'table', table_id: other.id, table: other });
    expect(renameTableSelections(unrelated, renamed)).toBe(unrelated);
    const current = createLeaf({ kind: 'table', table_id: TABLE_ID, table: renamed });
    expect(renameTableSelections(current, renamed)).toBe(current);
  });
});

describe('discardTableDraft', () => {
  it('returns the pane to what it showed before the draft', () => {
    const layout = leafWithHistory();
    const next = discardTableDraft(layout, TABLE_ID);
    expect(next.kind).toBe('leaf');
    if (next.kind !== 'leaf') return;
    expect(next.selection).toEqual({ kind: 'doc', doc_id: 'doc-1111111111111-aaaaaaaaa' });
    expect(next.history).toEqual({
      entries: [{ kind: 'doc', doc_id: 'doc-1111111111111-aaaaaaaaa' }],
      index: 0,
    });
  });

  it('empties a pane whose only visit was the draft, keeping its siblings', () => {
    const root = createLeaf({ kind: 'doc', doc_id: 'doc-1111111111111-aaaaaaaaa' });
    const split = splitLeaf(root, root.id, 'right', { kind: 'table-draft', draft_id: TABLE_ID });
    if (split.kind !== 'split') throw new Error('expected a split');
    const draftLeafId = split.children[1].id;
    const next = discardTableDraft(split, TABLE_ID);
    const draftLeaf = findLeaf(next, draftLeafId);
    expect(draftLeaf?.selection).toBeNull();
    expect(draftLeaf?.history).toEqual({ entries: [], index: -1 });
    expect(findLeaf(next, root.id)?.selection).toEqual({
      kind: 'doc',
      doc_id: 'doc-1111111111111-aaaaaaaaa',
    });
  });
});

describe('useTableSelectionSync', () => {
  it('applies table events from the bus to the pane layout', () => {
    const { result } = renderHook(() => {
      const [layout, setLayout] = useState<LayoutNode>(leafWithHistory);
      useTableSelectionSync(setLayout);
      return layout;
    });

    act(() => emitTableEvent({ type: 'table.created', table }));
    expect(result.current.kind === 'leaf' && result.current.selection).toEqual({
      kind: 'table',
      table_id: TABLE_ID,
      table,
    });
  });

  it('relabels open panes from table.updated', () => {
    const { result } = renderHook(() => {
      const [layout, setLayout] = useState<LayoutNode>(() =>
        createLeaf({ kind: 'table', table_id: TABLE_ID, table })
      );
      useTableSelectionSync(setLayout);
      return layout;
    });

    const renamed = { ...table, name: 'Reading notes' };
    act(() => {
      emitTableEvent({ type: 'table.updated', table: renamed });
      emitTableEvent({ type: 'table.updated', table: renamed });
    });
    expect(result.current.kind === 'leaf' && result.current.selection).toEqual({
      kind: 'table',
      table_id: TABLE_ID,
      table: renamed,
    });
    expect(result.current.kind === 'leaf' && result.current.history.entries).toHaveLength(1);
  });

  it('drops a discarded draft from the pane', () => {
    const { result } = renderHook(() => {
      const [layout, setLayout] = useState<LayoutNode>(leafWithHistory);
      useTableSelectionSync(setLayout);
      return layout;
    });

    act(() => emitTableEvent({ type: 'draft.discarded', draftId: TABLE_ID }));
    expect(result.current.kind === 'leaf' && result.current.selection).toEqual({
      kind: 'doc',
      doc_id: 'doc-1111111111111-aaaaaaaaa',
    });
  });
});
