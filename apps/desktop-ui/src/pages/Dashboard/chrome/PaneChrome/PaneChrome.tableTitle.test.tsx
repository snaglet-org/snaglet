/**
 * Pane chrome labels for Database tables: the topbar title, back/forward
 * tooltips and history menu read the shared live name cache, not the
 * selection's catalog snapshot, which goes stale when a layout is restored
 * from storage or a rename is missed while disconnected. The pane body is
 * never remounted to relabel.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { emitTableEvent } from '@desktop/features/database/tableEvents';
import { __resetTableNameCacheForTests } from '@desktop/features/database/tableNameCache';
import type { LayoutLeaf } from '../../layout/paneTree';
import type { NonNullableSelection } from '../../layout/paneTreeTypes';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ list: vi.fn(), archived: vi.fn(), bodyMounts: 0 }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    tablesApi: { ...actual.tablesApi, list: api.list },
    archiveApi: { ...actual.archiveApi, tables: api.archived },
  };
});

vi.mock('../../views/DetailRouter.js', () => ({
  DetailRouter: () => {
    useEffect(() => {
      api.bodyMounts += 1;
    }, []);
    return <div>pane body</div>;
  },
}));

import { PaneChrome } from './PaneChrome';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';

const entry = (name: string): TableCatalogEntry => ({
  id: TABLE_ID,
  name,
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
});

/** The selection as persisted before the table was renamed elsewhere. */
const staleTable: NonNullableSelection = {
  kind: 'table',
  table_id: TABLE_ID,
  table: entry('old_name'),
};
const profile: NonNullableSelection = { kind: 'profile' };

function leaf(
  id: string,
  selection: NonNullableSelection,
  entries: NonNullableSelection[]
): LayoutLeaf {
  return { kind: 'leaf', id, selection, history: { entries, index: entries.indexOf(selection) } };
}

function paneFor(layoutLeaf: LayoutLeaf) {
  return (
    <PaneChrome
      leaf={layoutLeaf}
      isActive={false}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onDropSelection={vi.fn()}
      onReplaceSelection={vi.fn()}
      onGoBack={vi.fn()}
      onGoForward={vi.fn()}
      onJumpToHistoryEntry={vi.fn()}
    />
  );
}

/** Pane A shows the table; pane B moved on from it to the profile. */
function renderPanes() {
  const view = render(
    <>
      {paneFor(leaf('leaf-a', staleTable, [profile, staleTable]))}
      {paneFor(leaf('leaf-b', profile, [staleTable, profile]))}
    </>
  );
  const pane = (id: string) => view.container.querySelector<HTMLElement>(`[data-leaf-id="${id}"]`);
  const title = () => {
    const center = pane('leaf-a')?.querySelector<HTMLElement>('[data-pane-chrome-zone="center"]');
    return center?.textContent ?? '';
  };
  const backTitle = () =>
    pane('leaf-b')
      ?.querySelector('[data-pane-chrome-zone="left"] button')
      ?.getAttribute('aria-label');
  const menuLabels = () => {
    const paneB = pane('leaf-b');
    if (!paneB) throw new Error('pane B is not rendered');
    fireEvent.click(within(paneB).getByRole('button', { name: 'Recently visited' }));
    const labels = screen.getAllByRole('menuitem').map((item) => item.getAttribute('title'));
    fireEvent.keyDown(document, { key: 'Escape' });
    return labels;
  };
  return { title, backTitle, menuLabels };
}

describe('PaneChrome table labels', () => {
  beforeEach(() => {
    __resetTableNameCacheForTests();
    api.list.mockReset().mockResolvedValue({ tables: [entry('reading_list')] });
    api.archived.mockReset().mockResolvedValue({ tables: [] });
    api.bodyMounts = 0;
  });

  it('prefers the live name over a stale snapshot and follows a rename without remounting', async () => {
    const { title, backTitle, menuLabels } = renderPanes();
    await waitFor(() => expect(title()).toBe('reading_list'));
    expect(backTitle()).toBe('Back to reading_list');
    expect(menuLabels()).toEqual(['My profile', 'reading_list']);

    act(() => emitTableEvent({ type: 'table.updated', table: entry('book_club') }));

    expect(title()).toBe('book_club');
    expect(backTitle()).toBe('Back to book_club');
    expect(menuLabels()).toEqual(['My profile', 'book_club']);
    expect(api.bodyMounts).toBe(2);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('relabels after a reconnect refetch finds a rename missed while offline', async () => {
    const { title, backTitle } = renderPanes();
    await waitFor(() => expect(title()).toBe('reading_list'));

    api.list.mockResolvedValue({ tables: [entry('renamed_offline')] });
    act(() => emitTableEvent({ type: 'tables.invalidated' }));

    await waitFor(() => expect(title()).toBe('renamed_offline'));
    expect(backTitle()).toBe('Back to renamed_offline');
    expect(api.bodyMounts).toBe(2);
  });

  it('shows the unavailable label once the loaded catalog lacks the table', async () => {
    api.list.mockResolvedValue({ tables: [] });
    const { title, backTitle, menuLabels } = renderPanes();
    expect(title()).toBe('old_name');

    await waitFor(() => expect(title()).toBe('Unavailable table'));
    expect(backTitle()).toBe('Back to Unavailable table');
    expect(menuLabels()).toEqual(['My profile', 'Unavailable table']);
  });

  it('keeps the real name of an archived table, whether archived here or found archived on load', async () => {
    const { title, backTitle } = renderPanes();
    await waitFor(() => expect(title()).toBe('reading_list'));

    act(() => emitTableEvent({ type: 'table.removed', tableId: TABLE_ID, state: 'archived' }));
    expect(title()).toBe('reading_list');
    expect(backTitle()).toBe('Back to reading_list');

    api.list.mockResolvedValue({ tables: [] });
    api.archived.mockResolvedValue({
      tables: [
        { ...entry('reading_list'), state: 'archived', archivedAt: '2026-01-02T00:00:00.000Z' },
      ],
    });
    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(title()).toBe('reading_list');
    expect(title()).not.toContain('Unavailable');
  });
});
