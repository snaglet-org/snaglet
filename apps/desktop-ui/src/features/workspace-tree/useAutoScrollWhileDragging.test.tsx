/**
 * The tree's drag auto-scroller follows the body element: the body unmounts
 * while another sidebar view shows and comes back as a new element, which
 * must get its own listeners even though the tree data did not change.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const scrollers = vi.hoisted(() => [] as { el: HTMLElement; update: ReturnType<typeof vi.fn> }[]);
vi.mock('@desktop/utils/edgeAutoScroll', () => ({
  createEdgeAutoScroller: (el: HTMLElement) => {
    const scroller = { el, update: vi.fn(), stop: vi.fn() };
    scrollers.push(scroller);
    return scroller;
  },
}));

const listTree = vi.fn();
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    containersApi: { ...actual.containersApi, listTree: (...args: unknown[]) => listTree(...args) },
  };
});

import { WorkspaceTree } from './WorkspaceTree';

const doc: LibraryTreeChild = {
  kind: 'doc',
  id: 'doc-1111111111111-aaaaaaaaa',
  containerId: null,
  title: 'Guide',
  content: '',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('useAutoScrollWhileDragging', () => {
  it('scrolls the tree body again after another sidebar view hid it', async () => {
    listTree.mockResolvedValue([doc]);
    const view = render(<WorkspaceTree onNodeClick={vi.fn()} />);
    await screen.findByRole('tree');
    view.rerender(<WorkspaceTree onNodeClick={vi.fn()} hideBody />);
    view.rerender(<WorkspaceTree onNodeClick={vi.fn()} />);

    const body = screen.getByRole('tree');
    fireEvent.dragOver(body, { dataTransfer: { types: [] } });

    const current = scrollers.find((scroller) => scroller.el === body);
    expect(current?.update).toHaveBeenCalled();
  });
});
