/**
 * Rows linked by their table's name: `[Title](<table name>:<entry uuid>)`, the
 * form agents write after reading a table by its SQL name. They render as the
 * same entry chip as the canonical `entry:<table id>/<uuid>` link once the
 * table catalog says which names are tables.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { EditorView } from '@tiptap/pm/view';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import {
  __resetTableNameCacheForTests,
  ensureTableNames,
} from '@desktop/features/database/tableNameCache';
import { DashboardNavigationProvider } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { MarkdownRenderer } from '@desktop/features/rich-markdown/renderer/MarkdownRenderer';
import { ChipEditableInput } from '@desktop/features/rich-markdown/editor/ChipEditableInput';
import {
  hasTableRowLinkByName,
  parseNodeRef,
} from '@desktop/features/rich-markdown/renderer/nodeRef';
import { __resetEntryNameCacheForTests } from './entryNameCache';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});
const api = vi.hoisted(() => ({
  list: vi.fn(),
  archived: vi.fn(),
  resolveEntries: vi.fn(),
  entries: vi.fn(),
  agents: vi.fn(),
}));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    tablesApi: {
      ...actual.tablesApi,
      list: api.list,
      resolveEntries: api.resolveEntries,
      entries: api.entries,
    },
    archiveApi: { ...actual.archiveApi, tables: api.archived },
    agentsApi: { ...actual.agentsApi, list: api.agents },
  };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const entryId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const openTableEntry = vi.fn();

const table = (id: string, name: string, origin: 'custom' | 'builtin'): TableCatalogEntry => ({
  id,
  name,
  origin,
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
});

function show(children: ReactNode) {
  return render(
    <DashboardNavigationProvider
      value={{
        openInPane: vi.fn(),
        openThreadAgent: vi.fn(),
        requestReveal: vi.fn(),
        openTableEntry,
      }}
    >
      {children}
    </DashboardNavigationProvider>
  );
}

beforeEach(() => {
  __resetTableNameCacheForTests();
  __resetEntryNameCacheForTests();
  openTableEntry.mockReset();
  api.list.mockReset().mockResolvedValue({
    tables: [
      table(tableId, 'test_backlog', 'custom'),
      table('table-builtin-docs', 'docs', 'builtin'),
    ],
  });
  api.archived.mockReset().mockResolvedValue({ tables: [] });
  api.resolveEntries.mockReset().mockResolvedValue({
    entries: [{ tableId, entryId, name: 'Current name', tableName: 'test_backlog' }],
  });
  api.entries.mockReset().mockResolvedValue({ page: 1 });
  api.agents.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  __resetEntryNameCacheForTests();
  vi.restoreAllMocks();
});

describe('row links by table name', () => {
  it('parse as the entry chip once the catalog has loaded', async () => {
    const href = `test_backlog:${entryId.toUpperCase()}`;
    expect(parseNodeRef(href)).toBeNull();
    await ensureTableNames();
    expect(parseNodeRef(href)).toEqual({ kind: 'entry', id: `${tableId}/${entryId}` });
    expect(parseNodeRef(`TEST_BACKLOG:${entryId}`)).toEqual({
      kind: 'entry',
      id: `${tableId}/${entryId}`,
    });
  });

  it('stay plain for unknown names, built-in tables, kind schemes and non-uuid bodies', async () => {
    await ensureTableNames();
    expect(parseNodeRef(`other_table:${entryId}`)).toBeNull();
    expect(parseNodeRef(`docs:${entryId}`)).toBeNull();
    expect(parseNodeRef(`test_backlog:not-a-uuid`)).toBeNull();
    expect(parseNodeRef(`thread:${entryId}`)).toEqual({ kind: 'thread', id: entryId });
  });

  it('are detected in markdown only when the scheme is not a node kind', () => {
    expect(hasTableRowLinkByName(`See [Fix](test_backlog:${entryId}).`)).toBe(true);
    expect(hasTableRowLinkByName(`See [Thread](thread:${entryId}).`)).toBe(false);
    expect(hasTableRowLinkByName(`Plain test_backlog:${entryId} text.`)).toBe(false);
  });

  it('render in a message as an entry chip that opens the row', async () => {
    show(<MarkdownRenderer content={`See [Old title](test_backlog:${entryId}).`} />);
    const chip = await screen.findByRole('link');
    await waitFor(() => expect(chip).toHaveTextContent('Current name'));
    expect(chip).toHaveClass('md-chip-entry');
    expect(chip).toHaveAttribute('href', `test_backlog:${entryId}`);
    fireEvent.click(chip);
    expect(openTableEntry).toHaveBeenCalledWith(tableId, entryId);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('never load the catalog for markdown without such a link', async () => {
    show(<MarkdownRenderer content={`See [Thread](thread:${entryId}).`} />);
    await screen.findByRole('link');
    expect(api.list).not.toHaveBeenCalled();
  });
});

describe('row links by table name in an editor', () => {
  beforeEach(() => {
    if (!document.elementFromPoint) document.elementFromPoint = () => null;
    if (!Range.prototype.getClientRects)
      Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    if (!Range.prototype.getBoundingClientRect)
      Range.prototype.getBoundingClientRect = () => new DOMRect();
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function (this: EditorView) {
      return { pos: this.state.selection.from, inside: -1 };
    });
  });

  it('upgrade to an entry chip once the catalog loads, keeping the source text', async () => {
    const onChange = vi.fn();
    const value = `[Old title](test_backlog:${entryId})`;
    show(<ChipEditableInput value={value} onChange={onChange} ariaLabel="Notes" />);
    const chip = await screen.findByRole('link');
    await waitFor(() => expect(chip).toHaveTextContent('Current name'));
    expect(chip).toHaveAttribute('data-node-id', `${tableId}/${entryId}`);
    fireEvent.click(chip);
    expect(openTableEntry).toHaveBeenCalledWith(tableId, entryId);
    expect(onChange).not.toHaveBeenCalled();
  });
});
