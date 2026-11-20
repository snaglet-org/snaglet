import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ContainerTreeNode,
  DocTreeNode,
  ImageTreeNode,
  LibraryTreeChild,
  ThreadTreeNode,
} from '@desktop/utils/api';
import { TreeRow } from './TreeRow';

const DOC: DocTreeNode = {
  kind: 'doc',
  id: 'doc-1',
  containerId: 'container-1',
  title: 'Alpha doc',
  content: '',
  sortOrder: 0,
  createdAt: '2026-07-29T12:00:00.000Z',
  updatedAt: '2026-07-29T12:00:00.000Z',
};

const CONTAINER: ContainerTreeNode = {
  kind: 'container',
  id: 'container-1',
  parentId: null,
  name: 'Planning',
  sortOrder: 0,
  category: null,
  folderPath: null,
  githubUrl: null,
  createdBy: null,
  lastEditedBy: null,
  createdAt: '2026-07-29T12:00:00.000Z',
  updatedAt: '2026-07-29T12:00:00.000Z',
  children: [DOC],
};

const THREAD: ThreadTreeNode = {
  kind: 'thread',
  id: 'thread-1',
  projectId: 'container-1',
  title: 'Discussion',
  sortOrder: 1,
  lastMessageAt: null,
  createdAt: '2026-07-29T12:00:00.000Z',
  updatedAt: '2026-07-29T12:00:00.000Z',
};

const IMAGE: ImageTreeNode = {
  kind: 'image',
  id: 'image-1',
  containerId: 'container-1',
  name: 'Diagram',
  description: null,
  tags: [],
  mimeType: 'image/png',
  sizeBytes: 100,
  sortOrder: 2,
  url: '/api/images/image-1/content',
  createdAt: '2026-07-29T12:00:00.000Z',
  updatedAt: '2026-07-29T12:00:00.000Z',
};

function treeRowProps(
  node: LibraryTreeChild,
  overrides: Partial<ComponentProps<typeof TreeRow>> = {}
): ComponentProps<typeof TreeRow> {
  return {
    node,
    depth: 0,
    expanded: new Set(),
    onToggle: vi.fn(),
    clickRow: vi.fn(),
    clickTable: vi.fn(() => false),
    selectedIds: new Set(),
    nodeIndex: new Map([[node.id, node]]),
    tableIndex: new Map(),
    visibleOrderIndex: new Map([[node.id, 0]]),
    dragSourceRef: { current: null },
    hoverTargetId: null,
    hoverZone: null,
    setHoverTargetId: vi.fn(),
    setHoverZone: vi.fn(),
    handleDrop: vi.fn(),
    handleThreadScopeDrop: vi.fn(),
    handleTableScopeDrop: vi.fn(),
    handleTableRowDrop: vi.fn(),
    handleTableDrop: vi.fn(),
    handleFileDrop: vi.fn(),
    isDescendant: vi.fn(() => false),
    openPicker: vi.fn(),
    creator: null,
    draftInputRef: { current: null },
    commitCreator: vi.fn(),
    cancelCreator: vi.fn(),
    renamingId: null,
    startRename: vi.fn(),
    commitRename: vi.fn(),
    cancelRename: vi.fn(),
    projectFiles: new Map(),
    tablesByProject: new Map(),
    onNodeClick: vi.fn(),
    threadAgents: new Map(),
    expandedThreadAgentGroups: new Set(),
    toggleThreadAgentGroup: vi.fn(),
    activeNodeId: null,
    openNodeIds: new Set(),
    onRowContextMenu: vi.fn(),
    ...overrides,
  };
}

function renderTreeRow(props: ComponentProps<typeof TreeRow>) {
  return render(
    <div role="tree">
      <TreeRow {...props} />
    </div>
  );
}

describe('TreeRow keyboard accessibility', () => {
  it('exposes the visible row as a focusable selected treeitem and activates with Enter or Space', () => {
    const clickRow = vi.fn();
    renderTreeRow(treeRowProps(DOC, { clickRow, selectedIds: new Set([DOC.id]) }));

    const row = screen.getByRole('treeitem', { name: 'Alpha doc' });
    expect(row).toHaveAttribute('tabindex', '0');
    expect(row).toHaveAttribute('aria-level', '1');
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(row).not.toHaveAttribute('aria-expanded');

    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });

    expect(clickRow).toHaveBeenCalledTimes(2);
    expect(clickRow).toHaveBeenNthCalledWith(1, DOC, expect.objectContaining({ key: 'Enter' }));
    expect(clickRow).toHaveBeenNthCalledWith(2, DOC, expect.objectContaining({ key: ' ' }));
  });

  it('expands with Right, collapses with Left, and reports aria-expanded', () => {
    const onToggle = vi.fn();
    const initialProps = treeRowProps(CONTAINER, { onToggle });
    const { rerender } = renderTreeRow(initialProps);

    const closedRow = screen.getByRole('treeitem', { name: 'Planning' });
    expect(closedRow).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(closedRow, { key: 'ArrowRight' });
    expect(onToggle).toHaveBeenCalledWith(CONTAINER.id);

    rerender(
      <div role="tree">
        <TreeRow {...treeRowProps(CONTAINER, { onToggle, expanded: new Set([CONTAINER.id]) })} />
      </div>
    );

    const openRow = screen.getByRole('treeitem', { name: 'Planning' });
    expect(openRow).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(openRow, { key: 'ArrowLeft' });
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onToggle).toHaveBeenLastCalledWith(CONTAINER.id);
  });

  it('does not treat keyboard input from a nested row action as row activation', () => {
    const clickRow = vi.fn();
    renderTreeRow(treeRowProps(DOC, { clickRow }));

    fireEvent.keyDown(screen.getByRole('button', { name: 'Copy link to Alpha doc' }), {
      key: 'Enter',
    });

    expect(clickRow).not.toHaveBeenCalled();
  });

  it('does not start a row drag from the export action', () => {
    const dragSourceRef: ComponentProps<typeof TreeRow>['dragSourceRef'] = { current: null };
    renderTreeRow(treeRowProps(DOC, { dragSourceRef }));

    const event = fireEvent.dragStart(screen.getByRole('button', { name: 'Export Alpha doc' }));

    expect(event).toBe(false);
    expect(dragSourceRef.current).toBeNull();
  });

  it('offers export only for docs and containers, never threads or images', () => {
    const doc = renderTreeRow(treeRowProps(DOC));
    expect(screen.getByRole('button', { name: 'Export Alpha doc' })).toBeInTheDocument();
    doc.unmount();

    const container = renderTreeRow(treeRowProps(CONTAINER));
    expect(screen.getByRole('button', { name: 'Export Planning' })).toBeInTheDocument();
    container.unmount();

    const thread = renderTreeRow(treeRowProps(THREAD));
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
    thread.unmount();

    renderTreeRow(treeRowProps(IMAGE));
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
  });

  it('opens the rename field on a double-click, for docs and images alike', () => {
    const startRename = vi.fn();
    const doc = renderTreeRow(treeRowProps(DOC, { startRename }));
    fireEvent.doubleClick(screen.getByText('Alpha doc'));
    expect(startRename).toHaveBeenCalledWith(DOC.id);
    doc.unmount();

    startRename.mockClear();
    renderTreeRow(treeRowProps(IMAGE, { startRename }));
    fireEvent.doubleClick(screen.getByText('Diagram'));
    expect(startRename).toHaveBeenCalledWith(IMAGE.id);
  });

  it('starts a rename with F2, on an image too', () => {
    const startRename = vi.fn();
    const doc = renderTreeRow(treeRowProps(DOC, { startRename }));
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Alpha doc' }), { key: 'F2' });
    expect(startRename).toHaveBeenCalledWith(DOC.id);
    doc.unmount();

    startRename.mockClear();
    renderTreeRow(treeRowProps(IMAGE, { startRename }));
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Diagram' }), { key: 'F2' });
    expect(startRename).toHaveBeenCalledWith(IMAGE.id);
  });

  it('archives the row with Delete or Cmd/Ctrl+Backspace, never plain Backspace', () => {
    const onArchiveRow = vi.fn();
    renderTreeRow(treeRowProps(DOC, { onArchiveRow }));
    const row = screen.getByRole('treeitem', { name: 'Alpha doc' });

    fireEvent.keyDown(row, { key: 'Backspace' });
    expect(onArchiveRow).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: 'Delete' });
    fireEvent.keyDown(row, { key: 'Backspace', metaKey: true });
    expect(onArchiveRow).toHaveBeenCalledTimes(2);
    expect(onArchiveRow).toHaveBeenCalledWith(DOC);
  });

  it('hands focus back to the row when its rename field closes', () => {
    const props = treeRowProps(DOC, { renamingId: DOC.id });
    const { rerender } = renderTreeRow(props);
    const input = screen.getByRole('textbox', { name: 'Rename' });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Escape' });
    rerender(
      <div role="tree">
        <TreeRow {...props} renamingId={null} />
      </div>
    );

    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'Alpha doc' }));
  });

  it('renders no taxonomy chip on a plain folder — only projects carry a badge', () => {
    const { container } = renderTreeRow(treeRowProps(CONTAINER));

    expect(screen.queryByText('project')).toBeNull();
    expect(screen.queryByText('blocked')).toBeNull();
    expect(container.querySelector('[data-container-phase]')).toBeNull();
  });
});
