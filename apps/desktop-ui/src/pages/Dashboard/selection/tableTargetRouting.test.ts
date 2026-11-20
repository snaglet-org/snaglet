/**
 * Direct-target routing for Database tables.
 *
 * A table catalog id can arrive as a chip dropped on a pane, a Cmd+K hit, or
 * a sidebar tree-search hit, and all of them must land on the table pane. A
 * catalog id is not a workspace node id, so the failure this guards against
 * is a table being handed to a node path (`onSelect`, the library tree) and
 * silently opening nothing.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { canOpenChipInPane, selectionFromChip } from './selectionFromChip';
import { sidebarRevealTarget } from './types';
import { openPaletteResult } from '../components/CommandPalette/paletteActions';
import { serverHitToNode } from '../components/CommandPalette/paletteResultMappers';
import { viewForHitKind } from '@desktop/features/workspace-tree/searchUtils';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';

describe('table chips open the table pane', () => {
  it('is an openable chip kind', () => {
    expect(canOpenChipInPane({ id: TABLE_ID, kind: 'table', title: 'Reading list' })).toBe(true);
  });

  it('resolves to a table selection keyed by the catalog id', () => {
    expect(selectionFromChip({ id: TABLE_ID, kind: 'table', title: 'Reading list' })).toEqual({
      kind: 'table',
      table_id: TABLE_ID,
    });
  });
});

describe('palette table hits route to the table pane, never to the library tree', () => {
  const handlers = () => ({
    onSelect: vi.fn(),
    onOpenThreadAgent: vi.fn(),
    onOpenThreadWithFocusMessage: vi.fn(),
    onOpenTool: vi.fn(),
    onOpenAgent: vi.fn(),
    onOpenTable: vi.fn(),
  });

  it('titles the result by the table name and hands the catalog id to onOpenTable', async () => {
    const node = serverHitToNode({
      node_id: TABLE_ID,
      kind: 'table',
      score: 1,
      channels: ['fts'],
      payload: {
        name: 'Reading list',
        title: 'Reading list',
        origin: 'custom',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(node).toMatchObject({ kind: 'table', id: TABLE_ID, title: 'Reading list' });

    const h = handlers();
    await openPaletteResult(node, h);
    expect(h.onOpenTable).toHaveBeenCalledWith(TABLE_ID, {
      id: TABLE_ID,
      name: 'Reading list',
      origin: 'custom',
      projectId: null,
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(h.onSelect).not.toHaveBeenCalled();
  });

  it('still opens by id when the payload carries only a name', async () => {
    const h = handlers();
    await openPaletteResult(
      serverHitToNode({
        node_id: TABLE_ID,
        kind: 'table',
        score: 1,
        channels: ['fts'],
        payload: { name: 'Reading list' },
      }),
      h
    );
    expect(h.onOpenTable).toHaveBeenCalledWith(TABLE_ID, undefined);
  });

  it('does not throw when the host has no table surface wired', async () => {
    const { onOpenTable: _omitted, ...withoutTables } = handlers();
    await expect(
      openPaletteResult(
        {
          kind: 'table',
          id: TABLE_ID,
          title: 'Reading list',
          payload: {},
          createdAt: null,
          updatedAt: null,
        },
        withoutTables
      )
    ).resolves.toBeUndefined();
  });

  it('keeps a tree-search table hit in the workspace tree', () => {
    expect(viewForHitKind('table')).toBeNull();
  });
});

describe('"Open in sidebar" on a table pane', () => {
  it('reveals the table row in the workspace tree, keyed by its catalog id', () => {
    // The tree finds a catalog table's row in its Tables group by this id.
    expect(sidebarRevealTarget({ kind: 'table', table_id: TABLE_ID })).toEqual({
      view: 'library',
      id: TABLE_ID,
    });
  });

  it('only switches to the workspace tree for an unsaved table, which has no row yet', () => {
    expect(sidebarRevealTarget({ kind: 'table-draft', draft_id: TABLE_ID })).toEqual({
      view: 'library',
      id: null,
    });
  });
});
