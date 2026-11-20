/**
 * A flat thread (projectId === null) renders its name in the pane topbar; a
 * thread in a project keeps the `/Project/Thread name` breadcrumb.
 *
 * The chrome rail sizes every control to its content
 * (`.chrome > * { flex: 0 0 auto }`), so the title only takes width while it
 * stays in normal flow. The last test pins that nothing positions the title
 * span absolutely, which would collapse a root-level header to icon + slash +
 * chip.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LayoutLeaf } from '../../layout/paneTree';
import type { LibraryTreeChild, ThreadTreeNode } from '@desktop/utils/api';
import type { DetailSelection } from '../../selection/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

// Pane body is irrelevant to the topbar — stub the router.
vi.mock('../../views/DetailRouter.js', () => ({
  DetailRouter: () => <div>pane body</div>,
}));
vi.mock('../PaneHistoryNav/PaneHistoryNav.js', () => ({ PaneHistoryNav: () => null }));

const listTree = vi.fn();
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    containersApi: { ...actual.containersApi, listTree: (...args: unknown[]) => listTree(...args) },
  };
});

import { PaneChrome } from './PaneChrome';

function threadNode(id: string, title: string | null, projectId: string | null): ThreadTreeNode {
  return {
    kind: 'thread',
    id,
    projectId,
    // Deprecated alias the shared type still requires; never read here.
    title,
    sortOrder: 0,
    lastMessageAt: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: null,
  };
}

function makeLeaf(selection: DetailSelection): LayoutLeaf {
  return { kind: 'leaf', id: 'leaf-1', selection, history: { entries: [], index: -1 } };
}

function renderPane(selection: DetailSelection) {
  return render(
    <PaneChrome
      leaf={makeLeaf(selection)}
      isActive
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

describe('PaneChrome topbar title for threads', () => {
  it('renders the thread name for a flat thread (no project)', async () => {
    const root = threadNode('t-root', 'Root thread', null);
    listTree.mockResolvedValue([root] satisfies LibraryTreeChild[]);
    renderPane({ kind: 'thread', thread_id: 't-root', node: root });
    await waitFor(() => expect(listTree).toHaveBeenCalled());
    expect(screen.getByText('Root thread')).toBeTruthy();
  });

  it('renders the thread name plus project breadcrumb for a project thread', async () => {
    const nested = threadNode('t-nested', 'Nested thread', 'c-1');
    const tree: LibraryTreeChild[] = [
      {
        kind: 'container',
        id: 'c-1',
        parentId: null,
        name: 'Team',
        sortOrder: 0,
        category: 'project',
        folderPath: null,
        githubUrl: null,
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:00.000Z',
        children: [nested],
      },
    ];
    listTree.mockResolvedValue(tree);
    renderPane({ kind: 'thread', thread_id: 't-nested', node: nested });
    await screen.findByText('Team');
    expect(screen.getByText('Nested thread')).toBeTruthy();
  });

  it('keeps the title in normal flow so a root-level name occupies width (no absolute positioning)', async () => {
    // jsdom reports 0 for every clientWidth, which would make any width-fitting
    // code bail early. Stub a realistic measure so a fit that sets
    // `position: absolute` on the title would actually run and fail the test.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return 240;
      },
    });

    const root = threadNode('t-root', 'Root thread', null);
    listTree.mockResolvedValue([root] satisfies LibraryTreeChild[]);
    renderPane({ kind: 'thread', thread_id: 't-root', node: root });
    const title = await screen.findByText('Root thread');
    // Let any layout work scheduled in a requestAnimationFrame run before
    // asserting.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    expect(title.style.position).toBe('');
  });
});

afterEach(() => {
  // Remove the clientWidth stub installed by the in-flow pin above.
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});
