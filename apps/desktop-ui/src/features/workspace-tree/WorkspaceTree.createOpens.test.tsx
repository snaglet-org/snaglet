/**
 * An item named in the tree's inline draft row opens in the active pane once
 * it is saved, as a click on its new row would: the row is selected, the
 * pane opens through `onNodeClick`, and focus lost with the draft input lands
 * on the row. Nothing opens when the draft is canceled, left blank, or its
 * create fails, and focus the user moved elsewhere stays there.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerTreeNode, DocTreeNode, LibraryTreeChild } from '@desktop/utils/api';
import { __resetTableCatalogForTests } from '@desktop/features/database/useTableCatalog';
import { EXPANDED_STORAGE_KEY } from './constants';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  listTree: vi.fn(),
  createContainer: vi.fn(),
  createDoc: vi.fn(),
  listTables: vi.fn(),
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    containersApi: { ...actual.containersApi, listTree: api.listTree, create: api.createContainer },
    docsApi: { ...actual.docsApi, create: api.createDoc },
    tablesApi: { ...actual.tablesApi, list: api.listTables },
  };
});

import { WorkspaceTree } from './WorkspaceTree';

const timestamp = '2026-01-01T00:00:00.000Z';

const doc = (id: string, title: string): DocTreeNode => ({
  kind: 'doc',
  id,
  containerId: null,
  title,
  content: '',
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const container = (
  id: string,
  name: string,
  category: ContainerTreeNode['category']
): ContainerTreeNode => ({
  kind: 'container',
  id,
  parentId: null,
  name,
  sortOrder: 1,
  category,
  folderPath: null,
  githubUrl: null,
  createdBy: null,
  lastEditedBy: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  children: [],
});

const existing = doc('doc-1111111111111-aaaaaaaaa', 'Guide');

/** Open the root `+` menu, pick `kind`, and type `name` into the draft row. */
async function startDraft(kind: 'Doc' | 'Container' | 'Project', name: string) {
  await screen.findByRole('treeitem', { name: 'Guide' });
  fireEvent.click(screen.getByRole('button', { name: 'Create at root' }));
  fireEvent.click(screen.getByRole('menuitem', { name: kind }));
  const input = screen.getByRole('textbox', {
    name: `${kind === 'Container' ? 'container' : kind.toLowerCase()} name`,
  });
  fireEvent.change(input, { target: { value: name } });
  return input;
}

beforeEach(() => {
  __resetTableCatalogForTests();
  api.listTables.mockResolvedValue({ tables: [] });
  window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(['workspace/items']));
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('WorkspaceTree opens what its draft row creates', () => {
  const cases: {
    kind: 'Doc' | 'Container' | 'Project';
    created: LibraryTreeChild;
    create: () => typeof api.createDoc;
  }[] = [
    {
      kind: 'Doc',
      created: doc('doc-2222222222222-bbbbbbbbb', 'Plans'),
      create: () => api.createDoc,
    },
    {
      kind: 'Container',
      created: container('container-2222222222222-bbbbbbbbb', 'Plans', null),
      create: () => api.createContainer,
    },
    {
      kind: 'Project',
      created: container('container-3333333333333-ccccccccc', 'Plans', 'project'),
      create: () => api.createContainer,
    },
  ];

  it.each(cases)(
    'opens a saved $kind in the active pane, selected and focused like a clicked row',
    async ({ kind, created, create }) => {
      api.listTree.mockResolvedValueOnce([existing]).mockResolvedValue([existing, created]);
      create().mockResolvedValue({ id: created.id });
      const onNodeClick = vi.fn();
      render(<WorkspaceTree onNodeClick={onNodeClick} />);

      fireEvent.keyDown(await startDraft(kind, 'Plans'), { key: 'Enter' });

      await waitFor(() => expect(onNodeClick).toHaveBeenCalledTimes(1));
      expect(onNodeClick).toHaveBeenCalledWith(expect.objectContaining({ id: created.id }));
      const row = screen.getByRole('treeitem', { name: 'Plans' });
      expect(row).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('treeitem', { name: 'Guide' })).toHaveAttribute(
        'aria-selected',
        'false'
      );
      expect(row).toHaveFocus();
    }
  );

  it('opens nothing when the draft is canceled with Escape or left blank', async () => {
    api.listTree.mockResolvedValue([existing]);
    const onNodeClick = vi.fn();
    render(<WorkspaceTree onNodeClick={onNodeClick} />);

    fireEvent.keyDown(await startDraft('Doc', 'Plans'), { key: 'Escape' });
    fireEvent.keyDown(await startDraft('Doc', '   '), { key: 'Enter' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.createDoc).not.toHaveBeenCalled();
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it('opens nothing when the create fails', async () => {
    api.listTree.mockResolvedValue([existing]);
    api.createDoc.mockRejectedValue(new Error('Server unreachable'));
    const onNodeClick = vi.fn();
    render(<WorkspaceTree onNodeClick={onNodeClick} />);

    fireEvent.keyDown(await startDraft('Doc', 'Plans'), { key: 'Enter' });

    await waitFor(() => expect(api.createDoc).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it('opens a draft saved on blur but leaves focus where the user moved it', async () => {
    const created = doc('doc-2222222222222-bbbbbbbbb', 'Plans');
    api.listTree.mockResolvedValueOnce([existing]).mockResolvedValue([existing, created]);
    api.createDoc.mockResolvedValue({ id: created.id });
    const onNodeClick = vi.fn();
    render(
      <>
        <WorkspaceTree onNodeClick={onNodeClick} />
        <input aria-label="Elsewhere" />
      </>
    );

    const input = await startDraft('Doc', 'Plans');
    const elsewhere = screen.getByRole('textbox', { name: 'Elsewhere' });
    // Focus moving away blurs the draft row, which saves it.
    elsewhere.focus();
    fireEvent.blur(input);

    await waitFor(() => expect(onNodeClick).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('treeitem', { name: 'Plans' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(elsewhere).toHaveFocus();
  });
});
