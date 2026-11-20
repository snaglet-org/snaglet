/**
 * WikiLinkPreviewModal — opening an item from inside a previewed container
 * switches the same modal to that item, and Back returns to the container.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ContainerTreeNode, DocTreeNode, LibraryTreeChild } from '@desktop/utils/api';
import { WikiLinkPreviewModal } from './WikiLinkPreviewModal';

const api = vi.hoisted(() => ({ get: vi.fn(), listTree: vi.fn(), getDoc: vi.fn() }));
vi.mock('@desktop/utils/api', async (original) => {
  const actual = await original<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    containersApi: { get: api.get, listTree: api.listTree },
    docsApi: { ...actual.docsApi, get: api.getDoc },
  };
});
vi.mock('@desktop/features/rich-markdown/renderer/useWorkspaceAncestors', () => ({
  useWorkspaceAncestors: () => [],
}));
vi.mock('@desktop/pages/Dashboard/views/ContainerView', () => ({
  ContainerView: ({
    container,
    onOpenNode,
  }: {
    container: ContainerTreeNode;
    onOpenNode?: (node: LibraryTreeChild) => void;
  }) => (
    <div data-testid="container-view">
      {container.children.map((child) => (
        <button key={child.id} type="button" onClick={() => onOpenNode?.(child)}>
          open {child.id}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('@desktop/pages/Dashboard/views/DocView', () => ({
  DocView: ({ node }: { node: DocTreeNode }) => <div data-testid="doc-view">{node.title}</div>,
}));

const STAMP = '2026-01-01T00:00:00.000Z';
const FOLDER_ID = 'container-1111111111111-aaaaaaaaa';
const DOC_ID = 'doc-1111111111111-bbbbbbbbb';
const doc: DocTreeNode = {
  kind: 'doc',
  id: DOC_ID,
  containerId: FOLDER_ID,
  title: 'Launch notes',
  content: '',
  sortOrder: 0,
  createdAt: STAMP,
  updatedAt: STAMP,
};
const folder: ContainerTreeNode = {
  kind: 'container',
  id: FOLDER_ID,
  name: 'Plans',
  category: null,
  parentId: null,
  folderPath: null,
  githubUrl: null,
  children: [doc],
  sortOrder: 0,
  createdAt: STAMP,
  updatedAt: STAMP,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({
    id: FOLDER_ID,
    parentId: null,
    name: 'Plans',
    sortOrder: 0,
    x: null,
    y: null,
    category: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  });
  api.listTree.mockResolvedValue([folder]);
  api.getDoc.mockResolvedValue({ ...doc });
});

it('switches to a doc opened from a previewed container, and Back returns', async () => {
  const onClose = vi.fn();
  render(<WikiLinkPreviewModal kind="container" id={FOLDER_ID} onClose={onClose} />);
  fireEvent.click(await screen.findByText(`open ${DOC_ID}`));

  expect(await screen.findByTestId('doc-view')).toHaveTextContent('Launch notes');
  expect(api.getDoc).toHaveBeenCalledWith(DOC_ID);
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId('wiki-link-preview-back'));
  expect(await screen.findByTestId('container-view')).toBeInTheDocument();
  expect(screen.queryByTestId('wiki-link-preview-back')).toBeNull();
});

it('hands the click to the caller when it wired its own navigation', async () => {
  const onChipClick = vi.fn();
  render(
    <WikiLinkPreviewModal
      kind="container"
      id={FOLDER_ID}
      onClose={vi.fn()}
      onChipClick={onChipClick}
    />
  );
  fireEvent.click(await screen.findByText(`open ${DOC_ID}`));
  expect(onChipClick).toHaveBeenCalledWith('page', DOC_ID);
  expect(screen.queryByTestId('doc-view')).toBeNull();
});
